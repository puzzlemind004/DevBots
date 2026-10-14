/**
 * De quoi faire tourner l'orchestrateur en test : un dépôt temporaire, un faux
 * CLI, et un faux git ou un vrai. Chaque test a le sien, si bien que les tests
 * sur un vrai dépôt peuvent tourner en parallèle.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ClaudeResponse, ClaudeStreamRequest } from '../../src/core/claudeCli.js';
import { FlowStateStore, type FlowStatus } from '../../src/core/flowState.js';
import {
  Orchestrator,
  type DevSettings,
  type OrchestratorDeps,
  type OrchestratorEvent
} from '../../src/core/orchestrator.js';
import { DEV_SCHEMA, ISSUES_SCHEMA, REVIEW_SCHEMA } from '../../src/core/supervision.js';
import { WorkDir } from '../../src/core/workDir.js';
import { exec } from '../../src/util/exec.js';
import { FakeGit } from './fakeGit.js';

export type Handler = (request: ClaudeStreamRequest) => Promise<unknown> | unknown;

/**
 * Un faux CLI : une file de réponses par rôle (dev, revue, étape), et les
 * requêtes gardées pour les vérifier.
 */
export class FakeClaude {
  readonly requests: ClaudeStreamRequest[] = [];
  readonly dev: Handler[] = [];
  readonly review: Handler[] = [];
  readonly steps: Handler[] = [];
  private sessions = 0;
  /** Coût rendu par chaque session. */
  cost = 0;

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
    return {
      sessionId: request.resume ?? `session-${++this.sessions}`,
      output,
      costUsd: this.cost || undefined,
      permissionDenials: []
    };
  };
}

/** Un agent de dev qui écrit un fichier et son CR, et déclare build et tests au vert. */
export function devWrites(file: string, content = 'export const ok = true;\n'): Handler {
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

export const approved: Handler = () => ({ verdict: 'approved', summary: 'Conforme.', corrections: [] });
export const noIssues: Handler = () => ({ summary: 'RAS', issues: [] });

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

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout;
}

const INITIAL_FILES = { '.gitignore': '.work/\n', 'README.md': '# Dépôt\n' };

export class Harness {
  readonly claude = new FakeClaude();
  readonly events: OrchestratorEvent[] = [];
  readonly store: FlowStateStore;
  readonly settings: DevSettings;
  /** Le faux git ; absent sur un vrai dépôt. */
  readonly fakeGit?: FakeGit;
  orchestrator: Orchestrator;

  private constructor(
    readonly root: string,
    readonly repo: string,
    readonly work: string,
    realGit: boolean
  ) {
    this.fakeGit = realGit ? undefined : new FakeGit(repo, INITIAL_FILES);
    this.store = new FlowStateStore(path.join(work, 'state.json'));
    this.settings = {
      maxParallel: 2,
      devSkill: 'dev-story',
      allowedCommands: ['npm test'],
      worktreeRoot: path.join(root, 'worktrees'),
      baseBranch: '',
      installCommand: 'none',
      rulesFile: '',
      reviewModel: 'opus',
      maxLoops: 2,
      mergeChecks: [],
      checkCommands: [],
      correctionMaxTurns: 40,
      storyBudgetUsd: 0
    };
    this.orchestrator = this.newOrchestrator();
  }

  /** Un dépôt avec une feature `LOCAL-F1` et le plan de la story 42, sur un faux git par défaut. */
  static async create(options: { realGit?: boolean } = {}): Promise<Harness> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devbots-orch-')));
    const repo = path.join(root, 'repo');
    const work = path.join(repo, '.work');
    await fs.mkdir(path.join(work, 'ready'), { recursive: true });
    await fs.mkdir(path.join(work, 'features'), { recursive: true });
    await fs.mkdir(path.join(work, 'plans', '42'), { recursive: true });
    await fs.writeFile(path.join(work, 'plans', '42', 'v1.json'), '{"steps":[]}', 'utf8');
    await fs.writeFile(
      path.join(work, 'features', 'LOCAL-F1-inscription.md'),
      '---\nsource: "local"\nsource_id: "LOCAL-F1"\nlevel: "feature"\ntitle: "Inscription"\n---\n\n# Inscription\n',
      'utf8'
    );
    if (options.realGit) {
      await initRepo(root, repo);
    }
    return new Harness(root, repo, work, Boolean(options.realGit));
  }

  /** Remplace l'orchestrateur, avec d'autres dépendances (checks, installation). */
  replaceOrchestrator(deps: Partial<OrchestratorDeps>): Orchestrator {
    this.orchestrator = this.newOrchestrator(deps);
    return this.orchestrator;
  }

  async addReady(id: string, files: string[], extra = ''): Promise<void> {
    await fs.writeFile(path.join(this.work, 'ready', `${id}-story.md`), READY_CARD(id, files, extra), 'utf8');
  }

  /**
   * Attend qu'une story atteigne un état stable (ou celui demandé). La raison
   * d'un blocage accompagne l'état, pour qu'un échec dise pourquoi.
   */
  async settle(id: string, wanted?: FlowStatus): Promise<string> {
    for (let i = 0; i < 400; i++) {
      const run = (await this.store.read()).stories[id];
      const status = run?.status;
      const reached = wanted ? status === wanted : status === 'awaiting_human' || status === 'blocked';
      if (status && reached && (wanted || !this.orchestrator.activeIds.includes(id))) {
        return status === 'blocked' && wanted !== 'blocked' && run.reason ? `blocked: ${run.reason}` : status;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`La story ${id} n'a pas atteint ${wanted ?? 'un état stable'}.`);
  }

  async dispose(): Promise<void> {
    this.orchestrator.stopAll();
    await this.orchestrator.whenIdle();
    await fs.rm(this.root, { recursive: true, force: true, maxRetries: 5 });
  }

  private newOrchestrator(deps: Partial<OrchestratorDeps> = {}): Orchestrator {
    return new Orchestrator({
      repoRoot: this.repo,
      workDir: new WorkDir(this.work),
      store: this.store,
      stream: this.claude.run,
      settings: () => this.settings,
      onEvent: (e) => this.events.push(e),
      git: this.fakeGit,
      ...deps
    });
  }
}

async function initRepo(root: string, repo: string): Promise<void> {
  await git(root, 'init', '--quiet', '-b', 'main', repo);
  // Écrite d'un bloc plutôt que par `git config` : chaque processus git coûte.
  // Sans maintenance automatique, aucun `commit` ne relance git derrière lui.
  await fs.appendFile(
    path.join(repo, '.git', 'config'),
    '[user]\n\temail = test@example.com\n\tname = Test\n[maintenance]\n\tauto = false\n',
    'utf8'
  );
  for (const [file, content] of Object.entries(INITIAL_FILES)) {
    await fs.writeFile(path.join(repo, file), content, 'utf8');
  }
  await git(repo, 'add', '--all');
  await git(repo, 'commit', '--quiet', '-m', 'init');
}
