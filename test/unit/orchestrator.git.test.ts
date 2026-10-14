/**
 * L'orchestrateur sur un vrai dépôt git : le parcours complet, et les merges
 * (rebase, conflits, fast-forward, nettoyage) que le faux git ne simule pas.
 *
 * Chaque test lance des dizaines de processus git, lents sous Windows : ils
 * tournent en parallèle, chacun dans son propre dépôt.
 */

import { describe, it as base } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';
import { DEV_SCHEMA } from '../../src/core/supervision.js';
import { approved, devWrites, git, Harness, noIssues } from './orchestratorHarness.js';

const it = base.extend<{ h: Harness }>({
  h: async ({}, use) => {
    const h = await Harness.create({ realGit: true });
    await use(h);
    await h.dispose();
  }
});

const FEATURE = 'feature/LOCAL-F1-inscription';

/** Mène 42 jusqu'à « À valider », sur `src/email.ts`. */
async function toReview(h: Harness, content = 'export const ok = true;\n'): Promise<void> {
  await h.addReady('42', ['src/email.ts']);
  h.claude.dev.push(devWrites('src/email.ts', content));
  h.claude.review.push(approved);
  h.claude.steps.push(noIssues);
  await h.orchestrator.enqueue('42', 'sonnet');
  if ((await h.settle('42')) !== 'awaiting_human') {
    throw new Error('La story 42 n’a pas atteint « À valider ».');
  }
}

/** Un commit sur la branche de la feature, fait à côté pendant la revue. */
async function advanceFeature(h: Harness, file: string, content: string): Promise<void> {
  await git(h.repo, 'checkout', '--quiet', FEATURE);
  await fs.mkdir(path.dirname(path.join(h.repo, file)), { recursive: true });
  await fs.writeFile(path.join(h.repo, file), content, 'utf8');
  await git(h.repo, 'add', '--all');
  await git(h.repo, 'commit', '--quiet', '-m', `feature : ${file}`);
}

describe.concurrent('Orchestrator sur un vrai dépôt git', { timeout: 30_000 }, () => {
  it("mène une story de Ready jusqu'à « À valider »", async ({ h, expect }) => {
    await h.addReady('42', ['src/email.ts']);
    h.claude.dev.push(devWrites('src/email.ts'));
    h.claude.review.push(approved);
    h.claude.steps.push(() => ({
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

    await h.orchestrator.enqueue('42', 'sonnet');
    expect(await h.settle('42')).toBe('awaiting_human');

    const run = (await h.store.read()).stories['42']!;
    expect(run.baseBranch).toBe('feature/LOCAL-F1-inscription');
    expect(run.branch).toBe('story/42-story-42');
    expect(run.lastDev).toMatchObject({ build: 'passed', tests: 'passed' });
    expect(run.followUps).toEqual(['LOCAL-1', 'LOCAL-2']);

    // La branche de feature part de main, la story est commitée sur sa branche.
    expect(await git(h.repo, 'branch', '--list', 'feature/*')).toContain('feature/LOCAL-F1-inscription');
    expect(await git(run.worktree, 'log', '--format=%s', '-1')).toBe('42 : Story 42');
    expect(await git(run.worktree, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/email.ts');
    // `.devbots/` reste hors de git.
    expect(await git(run.worktree, 'status', '--porcelain')).toBe('');

    // L'agent de dev : skill, modèle, outils bornés, rien de dangereux.
    const dev = h.claude.requests[0]!;
    expect(dev.prompt.startsWith('/dev-story\n')).toBe(true);
    expect(dev.model).toBe('sonnet');
    expect(dev.cwd).toBe(run.worktree);
    expect(dev.allowedTools).toContain('Bash(npm test:*)');
    expect(dev.allowedTools).toContain('Skill');
    expect(dev.disallowedTools).toContain('Bash(git push:*)');
    // Avec un skill, la méthode est la sienne.
    expect(dev.prompt).toContain('comme le prévoit ton skill');
    expect(dev.prompt).not.toContain('étape par étape');
    // Revue et étape : sessions neuves, lecture seule ; seule l'étape a un skill.
    const [, review, step] = h.claude.requests;
    expect(review!.resume).toBeUndefined();
    expect(review!.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(step!.prompt.startsWith('/pre-pr-check\n')).toBe(true);
    expect(step!.tools).toContain('Skill');
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
      fs.access(path.join(h.work, 'new', 'LOCAL-1-revoir-la-validation-cote-serveur.md'))
    ).resolves.toBeUndefined();
    const ready = matter(await fs.readFile(path.join(h.work, 'ready', 'LOCAL-2-extraire-la-constante.md'), 'utf8'));
    expect(ready.data).toMatchObject({ origin: 'pre-pr-check', origin_story: '42', parent: 'LOCAL-F1' });

    // Ce qu'il te faut pour la revue.
    const runDir = path.join(h.work, 'runs', '42');
    expect(await fs.readFile(path.join(runDir, 'cr.md'), 'utf8')).toContain('Fait.');
    expect(await fs.readFile(path.join(runDir, 'report.md'), 'utf8')).toContain('Extraire la constante');
    expect(await fs.readFile(path.join(runDir, 'journal.log'), 'utf8')).toContain('Je travaille.');
    expect(h.events).toContainEqual({ kind: 'awaitingHuman', storyId: '42', title: 'Story 42' });
  });

  it('merge dans la branche de la feature, nettoie et range la fiche dans Done', async ({ h, expect }) => {
    await toReview(h);
    const { worktree, branch } = (await h.store.read()).stories['42']!;

    await h.orchestrator.approve('42');

    const run = (await h.store.read()).stories['42']!;
    expect(run.status).toBe('done');
    expect(run.reason).toBeUndefined();
    expect(await git(h.repo, 'rev-parse', FEATURE)).toBe(run.mergeCommit);
    expect(await git(h.repo, 'show', `${FEATURE}:src/email.ts`)).toBe('export const ok = true;');
    // La feature n'était pas extraite : le dépôt reste sur main, intact.
    expect(await git(h.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    await expect(fs.access(path.join(h.repo, 'src', 'email.ts'))).rejects.toThrow();

    await expect(fs.access(worktree)).rejects.toThrow();
    expect(await git(h.repo, 'branch', '--list', branch)).toBe('');
    await expect(fs.access(path.join(h.work, 'ready', '42-story.md'))).rejects.toThrow();
    const done = matter(await fs.readFile(path.join(h.work, 'done', '42-story.md'), 'utf8'));
    expect(done.data).toMatchObject({ merge_commit: run.mergeCommit, merged_into: FEATURE });
    expect(done.content).toContain('## Étapes');
    expect(h.events).toContainEqual({ kind: 'merged', storyId: '42', title: 'Story 42', into: FEATURE, warning: undefined });
  });

  it('libère les fichiers de la story : celle qui les attendait part', async ({ h, expect }) => {
    await toReview(h);
    await h.addReady('43', ['src/email.ts']);
    await h.orchestrator.enqueue('43', 'sonnet');
    expect((await h.store.read()).stories['43']!.status).toBe('queued');

    h.claude.dev.push(devWrites('src/email.ts', 'export const ok = 43;\n'));
    h.claude.review.push(approved);
    h.claude.steps.push(noIssues);
    await h.orchestrator.approve('42');
    expect(await h.settle('43')).toBe('awaiting_human');
    // 43 part de la feature, où 42 est déjà mergée.
    const run43 = (await h.store.read()).stories['43']!;
    expect(await git(run43.worktree, 'log', '--format=%s', '-2')).toBe('43 : Story 43\n42 : Story 42');
  });

  it("intègre la feature qui a avancé par un rebase, relance les checks, et avance la branche extraite", async ({
    h,
    expect
  }) => {
    const checks: string[] = [];
    h.replaceOrchestrator({
      check: async (_dir, command) => {
        checks.push(command);
      }
    });
    h.settings.mergeChecks = ['npm run build', 'npm test'];
    await toReview(h);
    await advanceFeature(h, 'docs/notes.md', '# Notes\n');

    await h.orchestrator.approve('42');

    expect((await h.store.read()).stories['42']!.status).toBe('done');
    expect(checks).toEqual(['npm run build', 'npm test']);
    // Historique linéaire : la story est rebasée sur la feature.
    expect(await git(h.repo, 'log', '--format=%s', '-3', FEATURE)).toBe('42 : Story 42\nfeature : docs/notes.md\ninit');
    expect(await git(h.repo, 'rev-list', '--merges', `main..${FEATURE}`)).toBe('');
    // La feature est extraite dans le dépôt : son arbre de travail suit.
    expect(await fs.readFile(path.join(h.repo, 'src', 'email.ts'), 'utf8')).toContain('export const ok = true;');
  });

  it('ne relance pas les checks quand la feature n’a pas bougé', async ({ h, expect }) => {
    const checks: string[] = [];
    h.replaceOrchestrator({
      check: async (_dir, command) => {
        checks.push(command);
      }
    });
    h.settings.mergeChecks = ['npm test'];
    await toReview(h);
    await h.orchestrator.approve('42');
    expect((await h.store.read()).stories['42']!.status).toBe('done');
    expect(checks).toEqual([]);
  });

  it("renvoie un check en échec à l'agent, puis merge au feu vert suivant", async ({ h, expect }) => {
    h.replaceOrchestrator({
      check: async () => {
        throw new Error('2 tests en échec');
      }
    });
    h.settings.mergeChecks = ['npm test'];
    await toReview(h);
    await advanceFeature(h, 'docs/notes.md', '# Notes\n');

    h.claude.dev.push(devWrites('src/email.ts', 'export const ok = 2;\n'));
    h.claude.review.push(approved);
    h.claude.steps.push(noIssues);
    await h.orchestrator.approve('42');
    expect(h.events.some((e) => e.kind === 'returned' && e.reason.includes('npm test'))).toBe(true);
    expect(await h.settle('42')).toBe('awaiting_human');
    const devs = h.claude.requests.filter((r) => r.schema === DEV_SCHEMA);
    expect(devs[1]!.resume).toBeUndefined();
    expect(devs[1]!.prompt).toContain('« npm test » échoue');
    expect(devs[1]!.prompt).toContain('2 tests en échec');

    // La story contient déjà la feature : pas de nouvelle intégration, pas de check.
    await h.orchestrator.approve('42');
    expect((await h.store.read()).stories['42']!.status).toBe('done');
  });

  it("renvoie un conflit à l'agent, qui le résout ; le merge conclut ensuite", async ({ h, expect }) => {
    await toReview(h, 'export const ok = true;\n');
    await advanceFeature(h, 'src/email.ts', 'export const ok = false;\n');

    // L'agent trouve les marqueurs, et les résout.
    let seen = '';
    h.claude.dev.push(async (r) => {
      seen = await fs.readFile(path.join(r.cwd, 'src/email.ts'), 'utf8');
      return devWrites('src/email.ts', 'export const ok = !false;\n')(r);
    });
    h.claude.review.push(approved);
    h.claude.steps.push(noIssues);
    await h.orchestrator.approve('42');

    expect(h.events.some((e) => e.kind === 'returned' && e.reason.includes('conflit'))).toBe(true);
    expect(await h.settle('42')).toBe('awaiting_human');
    expect(seen).toContain('<<<<<<<');
    const dev = h.claude.requests.filter((r) => r.schema === DEV_SCHEMA)[1]!;
    expect(dev.resume).toBeUndefined();
    expect(dev.prompt).toContain('- src/email.ts');
    const run = (await h.store.read()).stories['42']!;
    expect(await git(run.worktree, 'rev-list', '--merges', `${FEATURE}..HEAD`)).not.toBe('');

    await git(h.repo, 'checkout', '--quiet', 'main');
    await h.orchestrator.approve('42');
    expect((await h.store.read()).stories['42']!.status).toBe('done');
    expect(await git(h.repo, 'show', `${FEATURE}:src/email.ts`)).toBe('export const ok = !false;');
  });

  it('refuse de conclure un conflit qui garde ses marqueurs', async ({ h, expect }) => {
    await toReview(h, 'export const ok = true;\n');
    await advanceFeature(h, 'src/email.ts', 'export const ok = false;\n');

    // Premier passage : l'agent ne touche à rien, le commit est refusé.
    h.claude.dev.push(
      async () => ({ status: 'done', summary: '', build: 'passed', tests: 'passed', tests_detail: '', lint: 'passed', blocked_reason: '' }),
      devWrites('src/email.ts', 'export const ok = 1;\n')
    );
    h.claude.review.push(approved);
    h.claude.steps.push(noIssues);
    await h.orchestrator.approve('42');
    expect(await h.settle('42')).toBe('awaiting_human');
    const devs = h.claude.requests.filter((r) => r.schema === DEV_SCHEMA);
    expect(devs[2]!.prompt).toContain('marqueurs de conflit restants dans src/email.ts');
  });
});
