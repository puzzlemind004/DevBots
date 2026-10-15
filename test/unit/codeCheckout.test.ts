/**
 * Le code que lisent la planification et la vérification « déjà fait », sur
 * un vrai dépôt git : celui de la branche de feature, pas celui de la branche
 * extraite dans le dépôt.
 */

import { describe, it as base } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ClaudeRequest, ClaudeResponse } from '../../src/core/claudeCli.js';
import { codeCheckout, readCheckoutDir, removeReadCheckout, type CheckoutOptions } from '../../src/core/codeCheckout.js';
import { featureBranchName, Git } from '../../src/core/git.js';
import { PlanningError, PlanningSession } from '../../src/core/planning.js';
import { PlanStore } from '../../src/core/planStore.js';
import { SAMPLE_CARD, sampleUnderstanding } from './fixtures.js';
import { git } from './orchestratorHarness.js';

const FEATURE = { id: 'LOCAL-F1', title: 'Inscription' };
const FEATURE_BRANCH = featureBranchName(FEATURE.id, FEATURE.title);

interface Repo {
  root: string;
  repo: string;
  worktrees: string;
  git: Git;
  options: (overrides?: Partial<CheckoutOptions>) => CheckoutOptions;
}

const it = base.extend<{ r: Repo }>({
  r: async ({}, use) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devbots-checkout-'));
    const repo = path.join(root, 'repo');
    await git(root, 'init', '--quiet', '-b', 'main', repo);
    await fs.appendFile(
      path.join(repo, '.git', 'config'),
      '[user]\n\temail = test@example.com\n\tname = Test\n[maintenance]\n\tauto = false\n',
      'utf8'
    );
    await commit(repo, '.gitignore', '.work/\n');
    const worktrees = path.join(root, 'worktrees');
    await use({
      root,
      repo,
      worktrees,
      git: new Git(repo),
      options: (overrides) => ({
        repoRoot: repo,
        worktreeRoot: worktrees,
        storyId: 'LOCAL-3',
        purpose: 'plan',
        baseSetting: '',
        feature: FEATURE,
        ...overrides
      })
    });
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function commit(cwd: string, file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await fs.writeFile(path.join(cwd, file), content, 'utf8');
  await git(cwd, 'add', '--all');
  await git(cwd, 'commit', '--quiet', '-m', file);
}

/** La story A mergée dans la branche de feature, le dépôt resté sur `main`. */
async function mergeStoryA(r: Repo): Promise<void> {
  await git(r.repo, 'branch', FEATURE_BRANCH, 'main');
  await git(r.repo, 'checkout', '--quiet', FEATURE_BRANCH);
  await commit(r.repo, 'src/a.ts', 'export const a = 1;\n');
  await git(r.repo, 'checkout', '--quiet', 'main');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe.concurrent('codeCheckout', { timeout: 30_000 }, () => {
  it('lit la branche de feature dans un worktree détaché, à jour à chaque appel', async ({ r, expect }) => {
    await mergeStoryA(r);

    const first = await codeCheckout(r.git, r.options());
    expect(first).toEqual({ dir: readCheckoutDir(r.worktrees, 'LOCAL-3', 'plan'), ref: FEATURE_BRANCH, detached: true });
    expect(await exists(path.join(first.dir, 'src', 'a.ts'))).toBe(true);
    expect(await git(r.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

    // Une autre story mergée entre deux appels : le même dossier la voit.
    await git(r.repo, 'checkout', '--quiet', FEATURE_BRANCH);
    await commit(r.repo, 'src/b.ts', 'export const b = 2;\n');
    await git(r.repo, 'checkout', '--quiet', 'main');
    const second = await codeCheckout(r.git, r.options());
    expect(second.dir).toBe(first.dir);
    expect(await exists(path.join(second.dir, 'src', 'b.ts'))).toBe(true);

    await removeReadCheckout(r.git, r.worktrees, 'LOCAL-3', 'plan');
    expect(await exists(first.dir)).toBe(false);
  });

  it("lit la branche d'où partira la feature tant qu'elle n'existe pas, dans le même dossier", async ({ r, expect }) => {
    await git(r.repo, 'checkout', '--quiet', '-b', 'panier-rapide');
    await commit(r.repo, 'src/panier.ts', 'export {};\n');

    const before = await codeCheckout(r.git, r.options());
    expect(before.ref).toBe('panier-rapide');
    expect(await exists(path.join(before.dir, 'src', 'panier.ts'))).toBe(true);

    await git(r.repo, 'branch', FEATURE_BRANCH, 'panier-rapide');
    const after = await codeCheckout(r.git, r.options());
    expect(after.ref).toBe(FEATURE_BRANCH);
    expect(after.dir).toBe(before.dir);
  });

  it('lit le dépôt lui-même pour une story sans feature', async ({ r, expect }) => {
    expect(await codeCheckout(r.git, r.options({ feature: undefined }))).toEqual({
      dir: r.repo,
      ref: 'main',
      detached: false
    });
  });

  it('lit la branche de base réglée quand elle n’est pas extraite', async ({ r, expect }) => {
    await git(r.repo, 'branch', 'develop', 'main');
    const checkout = await codeCheckout(r.git, r.options({ feature: undefined, baseSetting: 'develop' }));
    expect(checkout.ref).toBe('develop');
    expect(checkout.detached).toBe(true);
  });

  it('planifie B sur le code de A, mergée dans la feature, le dépôt sur une autre branche', async ({ r, expect }) => {
    await mergeStoryA(r);
    const work = path.join(r.repo, '.work');
    const storyFile = path.join(work, 'new', 'LOCAL-3-b.md');
    await fs.mkdir(path.dirname(storyFile), { recursive: true });
    await fs.writeFile(storyFile, SAMPLE_CARD, 'utf8');

    const requests: ClaudeRequest[] = [];
    const seen: boolean[] = [];
    const runner = async (request: ClaudeRequest): Promise<ClaudeResponse> => {
      requests.push(request);
      seen.push(await exists(path.join(request.cwd, 'src', 'a.ts')));
      return { sessionId: 'session-1', output: sampleUnderstanding() };
    };
    const session = await PlanningSession.open(
      {
        store: new PlanStore(path.join(work, 'plans')),
        runner,
        repoRoot: r.repo,
        settings: { skill: '', model: '', maxResumes: 5 },
        code: () => codeCheckout(r.git, r.options())
      },
      storyFile,
      'LOCAL-3',
      'B'
    );
    await session.understand();

    expect(seen).toEqual([true]);
    const request = requests[0]!;
    expect(request.addDirs).toEqual([work]);
    expect(request.prompt).toContain(`Fiche de la story : ${storyFile}`);
    expect(request.prompt).toContain(`le code de ${FEATURE_BRANCH}`);
  });
});

describe('PlanningSession et le dossier de sa session', () => {
  it("refuse de reprendre une session commencée ailleurs : Claude ne l'y retrouverait pas", async ({ expect }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devbots-plan-cwd-'));
    try {
      const work = path.join(root, '.work');
      const storyFile = path.join(work, 'new', '42-b.md');
      await fs.mkdir(path.dirname(storyFile), { recursive: true });
      await fs.writeFile(storyFile, SAMPLE_CARD, 'utf8');
      const store = new PlanStore(path.join(work, 'plans'));
      let dir = root;
      const runner = async (request: ClaudeRequest): Promise<ClaudeResponse> => ({
        sessionId: request.resume ?? 's1',
        output: sampleUnderstanding()
      });
      const deps = {
        store,
        runner,
        repoRoot: root,
        settings: { skill: '', model: '', maxResumes: 5 },
        code: async () => ({ dir, ref: 'main' })
      };

      const session = await PlanningSession.open(deps, storyFile, '42', 'B');
      await session.understand();
      expect(session.state.cwd).toBe(root);

      dir = path.join(root, 'ailleurs');
      await session.setAnswer('Q1', { choice: 'oui' });
      await expect(session.understand()).rejects.toThrow(PlanningError);

      await session.restart();
      await session.understand();
      expect(session.state.cwd).toBe(dir);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
