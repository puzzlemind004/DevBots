import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import matter from 'gray-matter';
import type { ClaudeRequest, ClaudeResponse } from '../../src/core/claudeCli.js';
import { PLAN_SCHEMA, UNDERSTANDING_SCHEMA, type PlanSection } from '../../src/core/plan.js';
import { PlanningError, PlanningSession, type PlanningSettings } from '../../src/core/planning.js';
import { PlanStore } from '../../src/core/planStore.js';
import { SAMPLE_CARD, samplePlan, sampleUnderstanding } from './fixtures.js';

/** Un faux CLI : rend les réponses prévues dans l'ordre et garde les requêtes. */
class FakeClaude {
  readonly requests: ClaudeRequest[] = [];
  private readonly queue: unknown[] = [];

  reply(...outputs: unknown[]): this {
    this.queue.push(...outputs);
    return this;
  }

  readonly run = async (request: ClaudeRequest): Promise<ClaudeResponse> => {
    this.requests.push(request);
    if (this.queue.length === 0) {
      throw new Error('Appel inattendu');
    }
    return { sessionId: request.resume ?? 'session-1', output: this.queue.shift() };
  };
}

const SETTINGS: PlanningSettings = { skill: 'plan-story', model: 'opus', maxResumes: 5 };
const ALL: PlanSection[] = ['understanding', 'coverage', 'steps', 'tests', 'dependencies', 'execution'];

describe('PlanningSession', () => {
  let root: string;
  let work: string;
  let storyFile: string;
  let store: PlanStore;
  let claude: FakeClaude;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'devbots-plan-'));
    work = path.join(root, '.work');
    await fs.mkdir(path.join(work, 'new'), { recursive: true });
    storyFile = path.join(work, 'new', '42-valider-l-email.md');
    await fs.writeFile(storyFile, SAMPLE_CARD, 'utf8');
    store = new PlanStore(path.join(work, 'plans'));
    claude = new FakeClaude();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const open = () =>
    PlanningSession.open({ store, runner: claude.run, repoRoot: root, settings: SETTINGS }, storyFile, '42', 'Valider');

  it('indique la fiche de la feature parente dans le premier prompt', async () => {
    const featureFile = path.join(work, 'features', 'LOCAL-F1-inscription.md');
    claude.reply(sampleUnderstanding());
    const session = await PlanningSession.open(
      { store, runner: claude.run, repoRoot: root, settings: SETTINGS },
      storyFile,
      '42',
      'Valider',
      featureFile
    );
    await session.understand();
    expect(claude.requests[0]!.prompt).toContain(
      'Fiche de sa feature, à lire pour le contexte commun : .work/features/LOCAL-F1-inscription.md'
    );
  });

  it('ouvre une session neuve avec le skill, puis la reprend', async () => {
    claude.reply(sampleUnderstanding());
    const session = await open();
    await session.understand();

    const first = claude.requests[0]!;
    expect(first.resume).toBeUndefined();
    expect(first.schema).toBe(UNDERSTANDING_SCHEMA);
    expect(first.prompt.startsWith('/plan-story\n')).toBe(true);
    expect(first.prompt).toContain('.work/new/42-valider-l-email.md');
    expect(first.prompt).toContain('C2 : Un message explique pourquoi');
    expect(first.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(first.model).toBe('opus');
    expect(session.state.sessionId).toBe('session-1');
    expect(session.canDraft).toBe(false);

    await session.setAnswer('Q1', { choice: 'Sous le champ' });
    expect(session.canDraft).toBe(true);

    claude.reply(samplePlan());
    await session.draftPlan();
    const draft = claude.requests[1]!;
    expect(draft.resume).toBe('session-1');
    expect(draft.schema).toBe(PLAN_SCHEMA);
    expect(draft.prompt).toContain('Q1 (Où afficher le message ?) : Sous le champ');
    expect(draft.prompt).toContain('Q2 (Bloquer le bouton ?) : sans réponse');
    expect(draft.prompt).toContain('Dépendances déclarées dans la source : 40');
    expect(session.currentVersion).toBe(1);
    expect(session.state.phase).toBe('planning');
  });

  it('refuse le plan tant qu\'une question bloquante est sans réponse', async () => {
    claude.reply(sampleUnderstanding());
    const session = await open();
    await session.understand();
    await expect(session.draftPlan()).rejects.toThrow(PlanningError);
    expect(claude.requests).toHaveLength(1);
  });

  it('garde une réponse quand la question revient à la relance', async () => {
    claude.reply(sampleUnderstanding());
    const session = await open();
    await session.understand();
    await session.setAnswer('Q1', { text: 'en rouge' });
    await session.setAnswer('Q2', { choice: 'Oui' });

    claude.reply(sampleUnderstanding({ questions: [sampleUnderstanding().questions[0]!] }));
    await session.understand();
    expect(session.state.answers).toEqual({ Q1: { text: 'en rouge' } });
    expect(claude.requests[1]?.prompt).toContain('Q1 (Où afficher le message ?) : en rouge');
  });

  async function planned(): Promise<PlanningSession> {
    claude.reply(sampleUnderstanding(), samplePlan());
    const session = await open();
    await session.understand();
    await session.setAnswer('Q1', { choice: 'Sous le champ' });
    await session.draftPlan();
    return session;
  }

  it('ne retient d\'une reprise que la section commentée, et la redemande à la relecture', async () => {
    const session = await planned();
    for (const s of ALL) {
      await session.setReviewed(s, true);
    }

    claude.reply(
      samplePlan({
        tests: { unit: ['a.spec.ts'], e2e: ['inscription.e2e.ts'] },
        execution: { model: 'opus', complexity: 'high', rationale: 'changé en douce' }
      })
    );
    await session.reviseSection('tests', 'Ajoute un e2e.');

    expect(claude.requests.at(-1)?.prompt).toContain('Ne modifie que cette section (clés JSON : tests)');
    expect(session.currentVersion).toBe(2);
    expect(session.currentPlan?.tests.e2e).toEqual(['inscription.e2e.ts']);
    expect(session.currentPlan?.execution.model).toBe('sonnet');
    expect(session.state.reviewed.tests).toBe(false);
    expect(session.state.reviewed.execution).toBe(true);
    expect(session.canValidate).toBe(false);

    // Les deux versions restent sur disque pour le diff.
    await expect(fs.stat(store.versionPath('42', 1, 'md'))).resolves.toBeTruthy();
    await expect(fs.stat(store.versionPath('42', 2, 'md'))).resolves.toBeTruthy();
  });

  it('reprend là où elle s\'était arrêtée', async () => {
    await planned();
    const reopened = await open();
    expect(reopened.state.sessionId).toBe('session-1');
    expect(reopened.currentVersion).toBe(1);
    expect(reopened.currentPlan).toEqual(samplePlan());
    const history = await store.readHistory('42');
    expect(history.map((h) => h.kind)).toEqual(['compréhension', 'réponses', 'plan v1']);
  });

  it('plafonne les reprises de session', async () => {
    const session = await planned();
    session.state.resumes = SETTINGS.maxResumes;
    await expect(session.reviseSection('tests', 'encore')).rejects.toThrow(/Plafond/);
  });

  it('passe en ready après relecture complète, et retire la fiche de new/', async () => {
    const session = await planned();
    expect(session.canValidate).toBe(false);
    for (const s of ALL) {
      await session.setReviewed(s, true);
    }
    expect(session.canValidate).toBe(true);

    const target = await session.validate(work);
    expect(target).toBe(path.join(work, 'ready', '42-valider-l-email.md'));
    await expect(fs.stat(storyFile)).rejects.toThrow();
    const parsed = matter(await fs.readFile(target, 'utf8'));
    expect(parsed.data.plan).toBe('plans/42/v1.json');
    expect(session.state.phase).toBe('validated');
    await expect(session.understand()).rejects.toThrow(/déjà passée en ready/);
  });

  it('refuse la validation tant que la forme a une erreur', async () => {
    claude.reply(sampleUnderstanding(), samplePlan({ dependencies: [] }));
    const session = await open();
    await session.understand();
    await session.setAnswer('Q1', { choice: 'x' });
    await session.draftPlan();
    for (const s of ALL) {
      await session.setReviewed(s, true);
    }
    expect(session.checks().some((c) => c.severity === 'error')).toBe(true);
    await expect(session.validate(work)).rejects.toThrow(PlanningError);
  });

  it('repart d\'une session neuve après un redémarrage', async () => {
    const session = await planned();
    await session.restart();
    claude.reply(sampleUnderstanding());
    await session.understand();
    expect(claude.requests.at(-1)?.resume).toBeUndefined();
    expect(session.currentVersion).toBe(1);
  });
});
