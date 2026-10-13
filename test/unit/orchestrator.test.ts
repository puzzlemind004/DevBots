import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import matter from 'gray-matter';
import type { ClaudeResponse, ClaudeStreamRequest } from '../../src/core/claudeCli.js';
import { FlowStateStore, type FlowStatus } from '../../src/core/flowState.js';
import { Orchestrator, type DevSettings, type OrchestratorEvent } from '../../src/core/orchestrator.js';
import { DEV_SCHEMA, ISSUES_SCHEMA, REVIEW_SCHEMA } from '../../src/core/supervision.js';
import { WorkDir } from '../../src/core/workDir.js';
import { exec } from '../../src/util/exec.js';

type Handler = (request: ClaudeStreamRequest) => Promise<unknown> | unknown;

/**
 * Un faux CLI : une file de réponses par rôle (dev, revue, étape), et les
 * requêtes gardées pour les vérifier.
 */
class FakeClaude {
  readonly requests: ClaudeStreamRequest[] = [];
  readonly dev: Handler[] = [];
  readonly review: Handler[] = [];
  readonly steps: Handler[] = [];
  private sessions = 0;

  readonly run = async (request: ClaudeStreamRequest): Promise<ClaudeResponse> => {
    this.requests.push(request);
    const queue =
      request.schema === DEV_SCHEMA ? this.dev : request.schema === REVIEW_SCHEMA ? this.review : this.steps;
    const handler = queue.shift();
    if (!handler) {
      throw new Error(`Appel inattendu (${request.schema === ISSUES_SCHEMA ? 'étape' : 'autre'})`);
    }
    request.onEvent({ kind: 'text', text: 'Je travaille.' });
    const output = await handler(request);
    return { sessionId: request.resume ?? `session-${++this.sessions}`, output, permissionDenials: [] };
  };
}

/** Un agent de dev qui écrit un fichier et son CR, et déclare build et tests au vert. */
function devWrites(file: string, content = 'export const ok = true;\n'): Handler {
  return async (request) => {
    await fs.mkdir(path.dirname(path.join(request.cwd, file)), { recursive: true });
    await fs.writeFile(path.join(request.cwd, file), content, 'utf8');
    await fs.writeFile(path.join(request.cwd, '.devbots', 'cr.md'), '# CR\n\nFait.\n', 'utf8');
    return {
      status: 'done',
      summary: 'Fait.',
      build: 'passed',
      tests: 'passed',
      tests_detail: '3 tests',
      lint: 'passed',
      blocked_reason: ''
    };
  };
}

const approved: Handler = () => ({ verdict: 'approved', summary: 'Conforme.', corrections: [] });
const noIssues: Handler = () => ({ summary: 'RAS', issues: [] });

const READY_CARD = (id: string, files: string[], extra = '') => `---
source: "local"
source_id: "${id}"
parent: "LOCAL-F1"
title: "Story ${id}"
state: "open"
plan: "plans/${id}/v1.json"
recommended_model: "sonnet"
files: ${JSON.stringify(files)}
${extra}---

# Story ${id}

## Étapes

1. Faire.
`;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout;
}

describe('Orchestrator', () => {
  let root: string;
  let repo: string;
  let work: string;
  let claude: FakeClaude;
  let events: OrchestratorEvent[];
  let settings: DevSettings;
  let orchestrator: Orchestrator;
  let store: FlowStateStore;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devbots-orch-')));
    repo = path.join(root, 'repo');
    work = path.join(repo, '.work');
    await fs.mkdir(path.join(work, 'ready'), { recursive: true });
    await fs.mkdir(path.join(work, 'features'), { recursive: true });
    await fs.mkdir(path.join(work, 'plans', '42'), { recursive: true });
    await fs.writeFile(path.join(work, 'plans', '42', 'v1.json'), '{"steps":[]}', 'utf8');
    await fs.writeFile(
      path.join(work, 'features', 'LOCAL-F1-inscription.md'),
      '---\nsource: "local"\nsource_id: "LOCAL-F1"\nlevel: "feature"\ntitle: "Inscription"\n---\n\n# Inscription\n',
      'utf8'
    );
    await git(root, 'init', '--quiet', '-b', 'main', repo);
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, '.gitignore'), '.work/\n', 'utf8');
    await fs.writeFile(path.join(repo, 'README.md'), '# Dépôt\n', 'utf8');
    await git(repo, 'add', '--all');
    await git(repo, 'commit', '--quiet', '-m', 'init');

    claude = new FakeClaude();
    events = [];
    settings = {
      maxParallel: 2,
      devSkill: 'dev-story',
      allowedCommands: ['npm test'],
      worktreeRoot: path.join(root, 'worktrees'),
      baseBranch: '',
      installCommand: 'none',
      rulesFile: '',
      reviewModel: 'opus',
      maxLoops: 2,
      mergeChecks: []
    };
    store = new FlowStateStore(path.join(work, 'state.json'));
    orchestrator = new Orchestrator({
      repoRoot: repo,
      workDir: new WorkDir(work),
      store,
      stream: claude.run,
      settings: () => settings,
      onEvent: (e) => events.push(e)
    });
  });

  afterEach(async () => {
    orchestrator.stopAll();
    await orchestrator.whenIdle();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  async function addReady(id: string, files: string[], extra = ''): Promise<void> {
    await fs.writeFile(path.join(work, 'ready', `${id}-story.md`), READY_CARD(id, files, extra), 'utf8');
  }

  /**
   * Attend qu'une story atteigne un état stable (ou celui demandé). La raison
   * d'un blocage accompagne l'état, pour qu'un échec dise pourquoi.
   */
  async function settle(id: string, wanted?: FlowStatus): Promise<string> {
    for (let i = 0; i < 400; i++) {
      const run = (await store.read()).stories[id];
      const status = run?.status;
      const reached = wanted ? status === wanted : status === 'awaiting_human' || status === 'blocked';
      if (status && reached && (wanted || !orchestrator.activeIds.includes(id))) {
        return status === 'blocked' && wanted !== 'blocked' && run.reason ? `blocked: ${run.reason}` : status;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`La story ${id} n'a pas atteint ${wanted ?? 'un état stable'}.`);
  }

  it("mène une story de Ready jusqu'à « À valider »", async () => {
    await addReady('42', ['src/email.ts']);
    claude.dev.push(devWrites('src/email.ts'));
    claude.review.push(approved);
    claude.steps.push(() => ({
      summary: 'Deux remarques.',
      issues: [
        {
          title: 'Extraire la constante',
          description: 'Valeur magique.',
          severity: 'minor',
          file: 'src/email.ts',
          line: 1,
          classification: 'followup_simple',
          mini_plan: '1. Extraire la constante.'
        },
        {
          title: 'Revoir la validation côté serveur',
          description: 'À traiter à part.',
          severity: 'major',
          file: '',
          line: 0,
          classification: 'followup_complex',
          mini_plan: ''
        }
      ]
    }));

    await orchestrator.enqueue('42', 'sonnet');
    expect(await settle('42')).toBe('awaiting_human');

    const run = (await store.read()).stories['42']!;
    expect(run.baseBranch).toBe('feature/LOCAL-F1-inscription');
    expect(run.branch).toBe('story/42-story-42');
    expect(run.lastDev).toMatchObject({ build: 'passed', tests: 'passed' });
    expect(run.followUps).toEqual(['LOCAL-1', 'LOCAL-2']);

    // La branche de feature part de main, la story est commitée sur sa branche.
    expect(await git(repo, 'branch', '--list', 'feature/*')).toContain('feature/LOCAL-F1-inscription');
    expect(await git(run.worktree, 'log', '--format=%s', '-1')).toBe('42 : Story 42');
    expect(await git(run.worktree, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/email.ts');
    // `.devbots/` reste hors de git.
    expect(await git(run.worktree, 'status', '--porcelain')).toBe('');

    // L'agent de dev : skill, modèle, outils bornés, rien de dangereux.
    const dev = claude.requests[0]!;
    expect(dev.prompt.startsWith('/dev-story\n')).toBe(true);
    expect(dev.model).toBe('sonnet');
    expect(dev.cwd).toBe(run.worktree);
    expect(dev.allowedTools).toContain('Bash(npm test:*)');
    expect(dev.disallowedTools).toContain('Bash(git push:*)');
    // Revue et étape : sessions neuves, lecture seule.
    const [, review, step] = claude.requests;
    expect(review!.resume).toBeUndefined();
    expect(review!.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(step!.prompt.startsWith('/pre-pr-check\n')).toBe(true);
    expect(step!.resume).toBeUndefined();

    // Fichiers de la tâche dans le worktree.
    for (const f of ['story.md', 'plan.json', 'cr-template.md', 'diff.patch']) {
      await expect(fs.access(path.join(run.worktree, '.devbots', f))).resolves.toBeUndefined();
    }
    expect(await fs.readFile(path.join(run.worktree, '.devbots', 'cr-template.md'), 'utf8')).toContain(
      '# CR — 42 Story 42'
    );

    // Tri : la fiche complexe dans new/, la simple dans ready/.
    await expect(
      fs.access(path.join(work, 'new', 'LOCAL-1-revoir-la-validation-cote-serveur.md'))
    ).resolves.toBeUndefined();
    const ready = matter(await fs.readFile(path.join(work, 'ready', 'LOCAL-2-extraire-la-constante.md'), 'utf8'));
    expect(ready.data).toMatchObject({ origin: 'pre-pr-check', origin_story: '42', parent: 'LOCAL-F1' });

    // Ce qu'il te faut pour la revue.
    const runDir = path.join(work, 'runs', '42');
    expect(await fs.readFile(path.join(runDir, 'cr.md'), 'utf8')).toContain('Fait.');
    expect(await fs.readFile(path.join(runDir, 'report.md'), 'utf8')).toContain('Extraire la constante');
    expect(await fs.readFile(path.join(runDir, 'journal.log'), 'utf8')).toContain('Je travaille.');
    expect(events).toContainEqual({ kind: 'awaitingHuman', storyId: '42', title: 'Story 42' });
  });

  it("renvoie les corrections à l'agent dans sa session, puis relit dans une session neuve", async () => {
    await addReady('42', ['src/email.ts']);
    claude.dev.push(devWrites('src/email.ts'), devWrites('src/email.ts', 'export const ok = 1;\n'));
    claude.review.push(
      () => ({ verdict: 'changes_requested', summary: '', corrections: [{ description: 'Couvrir C2', location: 'CR' }] }),
      approved
    );
    claude.steps.push(noIssues);

    await orchestrator.enqueue('42', 'sonnet');
    expect(await settle('42')).toBe('awaiting_human');

    const devs = claude.requests.filter((r) => r.schema === DEV_SCHEMA);
    expect(devs).toHaveLength(2);
    expect(devs[1]!.resume).toBe('session-1');
    expect(devs[1]!.prompt).toContain('- Couvrir C2 (CR)');
    const reviews = claude.requests.filter((r) => r.schema === REVIEW_SCHEMA);
    expect(reviews.every((r) => r.resume === undefined)).toBe(true);

    const run = (await store.read()).stories['42']!;
    expect(run.loops).toBe(1);
    expect(await git(run.worktree, 'log', '--format=%s', '-2')).toBe('42 : corrections (boucle 1)\n42 : Story 42');
  });

  it('renvoie un build en échec sans appeler la revue', async () => {
    await addReady('42', ['src/email.ts']);
    claude.dev.push(
      async (r) => ({ ...((await devWrites('src/email.ts')(r)) as object), build: 'failed' }),
      devWrites('src/email.ts', 'export const ok = 2;\n')
    );
    claude.review.push(approved);
    claude.steps.push(noIssues);

    await orchestrator.enqueue('42', 'sonnet');
    expect(await settle('42')).toBe('awaiting_human');
    expect(claude.requests.map((r) => r.schema)).toEqual([DEV_SCHEMA, DEV_SCHEMA, REVIEW_SCHEMA, ISSUES_SCHEMA]);
    expect(claude.requests[1]!.prompt).toContain('Le build est en échec');
  });

  it('te rend la main au plafond de boucles, et reprend les corrections à la relance', async () => {
    await addReady('42', ['src/email.ts']);
    await fs.writeFile(
      path.join(work, 'supervision.json'),
      JSON.stringify({ maxLoops: 0, steps: [{ skill: 'pre-pr-check' }] }),
      'utf8'
    );
    claude.dev.push(devWrites('src/email.ts'));
    claude.review.push(approved);
    claude.steps.push(() => ({
      summary: '',
      issues: [
        {
          title: 'Fuite',
          description: 'Abonnement jamais fermé.',
          severity: 'blocking',
          file: 'src/email.ts',
          line: 3,
          classification: 'blocking',
          mini_plan: ''
        }
      ]
    }));

    await orchestrator.enqueue('42', 'sonnet');
    expect(await settle('42', 'blocked')).toBe('blocked');
    const blocked = (await store.read()).stories['42']!;
    expect(blocked.reason).toContain('Plafond de 0 boucle');
    expect(blocked.pendingCorrections).toContain('Fuite');
    expect(events.some((e) => e.kind === 'blocked')).toBe(true);

    claude.dev.push(devWrites('src/email.ts', 'export const ok = 3;\n'));
    claude.review.push(approved);
    claude.steps.push(noIssues);
    await orchestrator.retry('42');
    expect(await settle('42')).toBe('awaiting_human');
    const resumed = claude.requests.filter((r) => r.schema === DEV_SCHEMA)[1]!;
    expect(resumed.resume).toBe('session-1');
    expect(resumed.prompt).toContain('Fuite (src/email.ts:3)');
  });

  it('ne lance pas en parallèle deux stories qui touchent un même fichier', async () => {
    await addReady('42', ['src/shared.ts']);
    await addReady('43', ['src/shared.ts']);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    claude.dev.push(async (r) => {
      await gate;
      return devWrites('src/shared.ts')(r);
    }, devWrites('src/shared.ts', 'export const b = 1;\n'));
    claude.review.push(approved, approved);
    claude.steps.push(noIssues, noIssues);

    await orchestrator.enqueue('42', 'sonnet');
    await orchestrator.enqueue('43', 'sonnet');
    const state = await store.read();
    expect(state.stories['43']!.status).toBe('queued');
    expect(state.stories['43']!.reason).toContain('fichiers communs avec 42');
    release();
    expect(await settle('42')).toBe('awaiting_human');
    // 42 attend ton feu vert : ses fichiers restent occupés jusqu'au merge.
    expect((await store.read()).stories['43']!.status).toBe('queued');
  });

  it("s'arrête à ta demande, et la story passe bloquée", async () => {
    await addReady('42', ['src/email.ts']);
    claude.dev.push(
      (r) =>
        new Promise((_, reject) =>
          r.signal!.addEventListener('abort', () => reject(new Error('tué')), { once: true })
        )
    );
    await orchestrator.enqueue('42', 'sonnet');
    await settle('42', 'in_dev');
    for (let i = 0; i < 100 && claude.requests.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(orchestrator.stop('42')).toBe(true);
    expect(await settle('42', 'blocked')).toBe('blocked');
    expect((await store.read()).stories['42']!.reason).toBe('Arrêtée par toi.');
  });

  it("retente l'installation des dépendances à la relance si elle a échoué", async () => {
    await addReady('42', ['src/email.ts']);
    const installs: string[] = [];
    settings.installCommand = 'npm ci';
    orchestrator = new Orchestrator({
      repoRoot: repo,
      workDir: new WorkDir(work),
      store,
      stream: claude.run,
      settings: () => settings,
      install: async (dir, command) => {
        installs.push(command.join(' '));
        if (installs.length === 1) {
          throw new Error('registre injoignable');
        }
      }
    });

    await orchestrator.enqueue('42', 'sonnet');
    expect(await settle('42', 'blocked')).toBe('blocked');
    expect((await store.read()).stories['42']!.reason).toBe('registre injoignable');

    claude.dev.push(devWrites('src/email.ts'));
    claude.review.push(approved);
    claude.steps.push(noIssues);
    await orchestrator.retry('42');
    expect(await settle('42')).toBe('awaiting_human');
    expect(installs).toEqual(['npm ci', 'npm ci']);
  });

  it('au redémarrage, bloque les stories dont le processus a disparu', async () => {
    await store.update((s) => {
      s.stories['42'] = {
        storyId: '42',
        title: 'x',
        status: 'in_dev',
        model: 'sonnet',
        baseBranch: 'main',
        branch: 'story/42',
        worktree: '',
        loops: 0,
        queuedAt: '',
        updatedAt: '',
        followUps: []
      };
    });
    expect(await orchestrator.recover()).toEqual(['42']);
    expect((await store.read()).stories['42']).toMatchObject({ status: 'blocked' });
  });

  // De vrais rebases et merges git, lents sous Windows : de la marge.
  describe('revue humaine et merge', { timeout: 20000 }, () => {
    const FEATURE = 'feature/LOCAL-F1-inscription';

    /** Mène 42 jusqu'à « À valider », sur `src/email.ts`. */
    async function toReview(content = 'export const ok = true;\n'): Promise<void> {
      await addReady('42', ['src/email.ts']);
      claude.dev.push(devWrites('src/email.ts', content));
      claude.review.push(approved);
      claude.steps.push(noIssues);
      await orchestrator.enqueue('42', 'sonnet');
      expect(await settle('42')).toBe('awaiting_human');
    }

    /** Un commit sur la branche de la feature, fait à côté pendant la revue. */
    async function advanceFeature(file: string, content: string): Promise<void> {
      await git(repo, 'checkout', '--quiet', FEATURE);
      await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
      await fs.writeFile(path.join(repo, file), content, 'utf8');
      await git(repo, 'add', '--all');
      await git(repo, 'commit', '--quiet', '-m', `feature : ${file}`);
    }

    function withChecks(check: (dir: string, command: string) => Promise<void>): void {
      orchestrator = new Orchestrator({
        repoRoot: repo,
        workDir: new WorkDir(work),
        store,
        stream: claude.run,
        settings: () => settings,
        onEvent: (e) => events.push(e),
        check
      });
    }

    it('merge dans la branche de la feature, nettoie et range la fiche dans Done', async () => {
      await toReview();
      const { worktree, branch } = (await store.read()).stories['42']!;

      await orchestrator.approve('42');

      const run = (await store.read()).stories['42']!;
      expect(run.status).toBe('done');
      expect(run.reason).toBeUndefined();
      expect(await git(repo, 'rev-parse', FEATURE)).toBe(run.mergeCommit);
      expect(await git(repo, 'show', `${FEATURE}:src/email.ts`)).toBe('export const ok = true;');
      // La feature n'était pas extraite : le dépôt reste sur main, intact.
      expect(await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
      await expect(fs.access(path.join(repo, 'src', 'email.ts'))).rejects.toThrow();

      await expect(fs.access(worktree)).rejects.toThrow();
      expect(await git(repo, 'branch', '--list', branch)).toBe('');
      await expect(fs.access(path.join(work, 'ready', '42-story.md'))).rejects.toThrow();
      const done = matter(await fs.readFile(path.join(work, 'done', '42-story.md'), 'utf8'));
      expect(done.data).toMatchObject({ merge_commit: run.mergeCommit, merged_into: FEATURE });
      expect(done.content).toContain('## Étapes');
      expect(events).toContainEqual({ kind: 'merged', storyId: '42', title: 'Story 42', into: FEATURE, warning: undefined });
    });

    it('libère les fichiers de la story : celle qui les attendait part', async () => {
      await toReview();
      await addReady('43', ['src/email.ts']);
      await orchestrator.enqueue('43', 'sonnet');
      expect((await store.read()).stories['43']!.status).toBe('queued');

      claude.dev.push(devWrites('src/email.ts', 'export const ok = 43;\n'));
      claude.review.push(approved);
      claude.steps.push(noIssues);
      await orchestrator.approve('42');
      expect(await settle('43')).toBe('awaiting_human');
      // 43 part de la feature, où 42 est déjà mergée.
      const run43 = (await store.read()).stories['43']!;
      expect(await git(run43.worktree, 'log', '--format=%s', '-2')).toBe('43 : Story 43\n42 : Story 42');
    });

    it("intègre la feature qui a avancé par un rebase, relance les checks, et avance la branche extraite", async () => {
      const checks: string[] = [];
      withChecks(async (_dir, command) => {
        checks.push(command);
      });
      settings.mergeChecks = ['npm run build', 'npm test'];
      await toReview();
      await advanceFeature('docs/notes.md', '# Notes\n');

      await orchestrator.approve('42');

      expect((await store.read()).stories['42']!.status).toBe('done');
      expect(checks).toEqual(['npm run build', 'npm test']);
      // Historique linéaire : la story est rebasée sur la feature.
      expect(await git(repo, 'log', '--format=%s', '-3', FEATURE)).toBe('42 : Story 42\nfeature : docs/notes.md\ninit');
      expect(await git(repo, 'rev-list', '--merges', `main..${FEATURE}`)).toBe('');
      // La feature est extraite dans le dépôt : son arbre de travail suit.
      expect(await fs.readFile(path.join(repo, 'src', 'email.ts'), 'utf8')).toContain('export const ok = true;');
    });

    it('ne relance pas les checks quand la feature n’a pas bougé', async () => {
      const checks: string[] = [];
      withChecks(async (_dir, command) => {
        checks.push(command);
      });
      settings.mergeChecks = ['npm test'];
      await toReview();
      await orchestrator.approve('42');
      expect((await store.read()).stories['42']!.status).toBe('done');
      expect(checks).toEqual([]);
    });

    it("renvoie un check en échec à l'agent, puis merge au feu vert suivant", async () => {
      withChecks(async () => {
        throw new Error('2 tests en échec');
      });
      settings.mergeChecks = ['npm test'];
      await toReview();
      await advanceFeature('docs/notes.md', '# Notes\n');

      claude.dev.push(devWrites('src/email.ts', 'export const ok = 2;\n'));
      claude.review.push(approved);
      claude.steps.push(noIssues);
      await orchestrator.approve('42');
      expect(events.some((e) => e.kind === 'returned' && e.reason.includes('npm test'))).toBe(true);
      expect(await settle('42')).toBe('awaiting_human');
      const devs = claude.requests.filter((r) => r.schema === DEV_SCHEMA);
      expect(devs[1]!.resume).toBe('session-1');
      expect(devs[1]!.prompt).toContain('« npm test » échoue');
      expect(devs[1]!.prompt).toContain('2 tests en échec');

      // La story contient déjà la feature : pas de nouvelle intégration, pas de check.
      await orchestrator.approve('42');
      expect((await store.read()).stories['42']!.status).toBe('done');
    });

    it("renvoie un conflit à l'agent, qui le résout ; le merge conclut ensuite", async () => {
      await toReview('export const ok = true;\n');
      await advanceFeature('src/email.ts', 'export const ok = false;\n');

      // L'agent trouve les marqueurs, et les résout.
      let seen = '';
      claude.dev.push(async (r) => {
        seen = await fs.readFile(path.join(r.cwd, 'src/email.ts'), 'utf8');
        return devWrites('src/email.ts', 'export const ok = !false;\n')(r);
      });
      claude.review.push(approved);
      claude.steps.push(noIssues);
      await orchestrator.approve('42');

      expect(events.some((e) => e.kind === 'returned' && e.reason.includes('conflit'))).toBe(true);
      expect(await settle('42')).toBe('awaiting_human');
      expect(seen).toContain('<<<<<<<');
      const dev = claude.requests.filter((r) => r.schema === DEV_SCHEMA)[1]!;
      expect(dev.resume).toBe('session-1');
      expect(dev.prompt).toContain('- src/email.ts');
      const run = (await store.read()).stories['42']!;
      expect(await git(run.worktree, 'rev-list', '--merges', `${FEATURE}..HEAD`)).not.toBe('');

      await git(repo, 'checkout', '--quiet', 'main');
      await orchestrator.approve('42');
      expect((await store.read()).stories['42']!.status).toBe('done');
      expect(await git(repo, 'show', `${FEATURE}:src/email.ts`)).toBe('export const ok = !false;');
    });

    it('refuse de conclure un conflit qui garde ses marqueurs', async () => {
      await toReview('export const ok = true;\n');
      await advanceFeature('src/email.ts', 'export const ok = false;\n');

      // Premier passage : l'agent ne touche à rien, le commit est refusé.
      claude.dev.push(
        async () => ({ status: 'done', summary: '', build: 'passed', tests: 'passed', tests_detail: '', lint: 'passed', blocked_reason: '' }),
        devWrites('src/email.ts', 'export const ok = 1;\n')
      );
      claude.review.push(approved);
      claude.steps.push(noIssues);
      await orchestrator.approve('42');
      expect(await settle('42')).toBe('awaiting_human');
      const devs = claude.requests.filter((r) => r.schema === DEV_SCHEMA);
      expect(devs[2]!.prompt).toContain('marqueurs de conflit restants dans src/email.ts');
    });

    it("renvoie tes retours à l'agent dans sa session, sans dupliquer les fiches du tri", async () => {
      await addReady('42', ['src/email.ts']);
      const issue = {
        title: 'Extraire la constante',
        description: 'Valeur magique.',
        severity: 'minor',
        file: 'src/email.ts',
        line: 1,
        classification: 'followup_complex',
        mini_plan: ''
      };
      claude.dev.push(devWrites('src/email.ts'), devWrites('src/email.ts', 'export const valid = true;\n'));
      claude.review.push(approved, approved);
      claude.steps.push(() => ({ summary: '', issues: [issue] }), () => ({ summary: '', issues: [issue] }));
      await orchestrator.enqueue('42', 'sonnet');
      expect(await settle('42')).toBe('awaiting_human');

      await orchestrator.sendFeedback('42', 'Renomme ok en valid.');
      expect(await settle('42')).toBe('awaiting_human');

      const dev = claude.requests.filter((r) => r.schema === DEV_SCHEMA)[1]!;
      expect(dev.resume).toBe('session-1');
      expect(dev.prompt).toContain('Retours de la revue humaine');
      expect(dev.prompt).toContain('Renomme ok en valid.');
      expect((await store.read()).stories['42']!.followUps).toEqual(['LOCAL-1']);
      expect(await fs.readdir(path.join(work, 'new'))).toEqual(['LOCAL-1-extraire-la-constante.md']);
    });

    it("n'accepte feu vert et retours que sur une story à valider", async () => {
      await addReady('42', ['src/email.ts']);
      await expect(orchestrator.approve('42')).rejects.toThrow("n'attend pas ton feu vert");
      await expect(orchestrator.sendFeedback('42', 'x')).rejects.toThrow("n'attend pas ta revue");
    });

    it('donne à chaque worktree un port stable, sans doublon', async () => {
      await store.update((s) => {
        for (const id of ['42', '43']) {
          s.stories[id] = {
            storyId: id,
            title: id,
            status: 'awaiting_human',
            model: 'sonnet',
            baseBranch: 'main',
            branch: `story/${id}`,
            worktree: '',
            loops: 0,
            queuedAt: '',
            updatedAt: '',
            followUps: []
          };
        }
      });
      expect(await orchestrator.assignPort('42', 4201)).toBe(4201);
      expect(await orchestrator.assignPort('43', 4201)).toBe(4202);
      expect(await orchestrator.assignPort('42', 4201)).toBe(4201);
    });

    it('au redémarrage, un merge interrompu revient à valider', async () => {
      await store.update((s) => {
        s.stories['42'] = {
          storyId: '42',
          title: 'x',
          status: 'merging',
          model: 'sonnet',
          baseBranch: 'main',
          branch: 'story/42',
          worktree: '',
          loops: 0,
          queuedAt: '',
          updatedAt: '',
          followUps: []
        };
      });
      expect(await orchestrator.recover()).toEqual([]);
      expect((await store.read()).stories['42']).toMatchObject({ status: 'awaiting_human' });
    });
  });
});
