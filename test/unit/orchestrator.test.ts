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
      maxLoops: 2
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
});
