import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import matter from 'gray-matter';
import { WorkDir } from '../../src/core/workDir.js';
import { PlanStore, newPlanningState } from '../../src/core/planStore.js';
import { freshChanges, replanFromSource, resyncStories } from '../../src/core/resync.js';
import { shouldNotify, waitingCount } from '../../src/core/notifications.js';
import type { StoryRun } from '../../src/core/flowState.js';
import type { Ticket } from '../../src/core/model.js';

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    sourceId: '42',
    level: 'story',
    title: 'Valider un email',
    description: 'Description.',
    acceptanceCriteria: '- Un critère',
    state: 'Active',
    revision: '1',
    webUrl: 'https://dev.azure.com/acme/web/_workitems/edit/42',
    dependencies: [],
    attachments: [],
    ...overrides
  };
}

/** Une fausse source : les tickets qu'elle connaît, et la trace des lectures. */
function fakeSource(tickets: Ticket[]) {
  const reads: string[][] = [];
  return {
    reads,
    kind: 'azureDevOps' as const,
    async fetchTickets(ids: string[]) {
      reads.push(ids);
      return tickets.filter((t) => ids.includes(t.sourceId));
    }
  };
}

describe('resynchronisation', () => {
  let root: string;
  let work: string;
  let workDir: WorkDir;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'devbots-resync-'));
    work = path.join(root, '.work');
    workDir = new WorkDir(work);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Importe la story puis la passe dans ready/, avec un plan dans son corps. */
  async function planned(t: Ticket = ticket()): Promise<string> {
    await workDir.importTickets([t], 'azureDevOps');
    const newPath = path.join(work, 'new', '42-valider-un-email.md');
    const readyPath = path.join(work, 'ready', '42-valider-un-email.md');
    const card = matter(await fs.readFile(newPath, 'utf8'));
    await fs.writeFile(
      readyPath,
      matter.stringify(`${card.content}\n## Plan validé\n\n1. Écrire le validateur\n`, {
        ...(card.data as Record<string, unknown>),
        plan: 'plans/42/v1.json'
      }),
      'utf8'
    );
    await fs.rm(newPath);
    return readyPath;
  }

  it("garde la référence de la source à l'import", async () => {
    await workDir.importTickets([ticket()], 'azureDevOps');
    expect(await fs.readFile(workDir.referencePath('42'), 'utf8')).toContain('Valider un email');
  });

  it('laisse intacte une story dont la révision n’a pas bougé', async () => {
    const readyPath = await planned();
    const before = await fs.readFile(readyPath, 'utf8');
    const [result] = await workDir.importTickets([ticket()], 'azureDevOps');
    expect(result?.outcome).toBe('unchanged');
    expect(await fs.readFile(readyPath, 'utf8')).toBe(before);
  });

  it('marque à revoir dès que la révision change, même si la fiche est identique (un commentaire)', async () => {
    const readyPath = await planned();
    const [result] = await workDir.importTickets([ticket({ revision: '2', state: 'Resolved' })], 'azureDevOps');
    expect(result).toMatchObject({ outcome: 'needsReview', fresh: true });
    const data = matter(await fs.readFile(readyPath, 'utf8')).data;
    expect(data).toMatchObject({ needs_review: true, source_rev: '1', source_rev_seen: '2', state: 'Resolved' });
  });

  it('marque à revoir une story planifiée dont le contenu a changé, et garde la version reçue', async () => {
    const readyPath = await planned();
    const [first] = await workDir.importTickets([ticket({ revision: '2', description: 'Nouvelle règle.' })], 'azureDevOps');
    expect(first).toMatchObject({ outcome: 'needsReview', fresh: true });

    const parsed = matter(await fs.readFile(readyPath, 'utf8'));
    expect(parsed.data).toMatchObject({ needs_review: true, source_rev_seen: '2', source_rev: '1' });
    expect(parsed.content).toContain('Écrire le validateur');
    expect(await fs.readFile(workDir.incomingPath('42'), 'utf8')).toContain('Nouvelle règle.');

    // Relue une seconde fois, la même révision n'est plus une nouvelle.
    const [again] = await workDir.importTickets([ticket({ revision: '2', description: 'Nouvelle règle.' })], 'azureDevOps');
    expect(again).toMatchObject({ outcome: 'needsReview', fresh: false });
  });

  it('écrit la référence qui manque à une story importée avant la resynchronisation', async () => {
    await planned();
    await fs.rm(workDir.referencePath('42'));
    const [same] = await workDir.importTickets([ticket()], 'azureDevOps');
    expect(same?.outcome).toBe('unchanged');
    expect(await fs.readFile(workDir.referencePath('42'), 'utf8')).toContain('Description.');
  });

  it('garder le plan : la version reçue devient la référence, la fiche reste intacte', async () => {
    const readyPath = await planned();
    await workDir.importTickets([ticket({ revision: '2', description: 'Nouvelle règle.' })], 'azureDevOps');
    const story = await workDir.findStory('42');
    await workDir.acceptSourceChange(story!);

    const parsed = matter(await fs.readFile(readyPath, 'utf8'));
    expect(parsed.data.needs_review).toBeUndefined();
    expect(parsed.data.source_rev_seen).toBeUndefined();
    expect(parsed.data.source_rev).toBe('2');
    expect(parsed.data.plan).toBe('plans/42/v1.json');
    expect(await fs.readFile(workDir.referencePath('42'), 'utf8')).toContain('Nouvelle règle.');
    await expect(fs.access(workDir.incomingPath('42'))).rejects.toThrow();
  });

  it("replanifier : la fiche revient dans new/ réécrite, et l'atelier rouvre", async () => {
    await planned();
    const plans = new PlanStore(workDir.plansPath());
    await plans.save({
      ...newPlanningState('42', 'Valider un email'),
      phase: 'validated',
      sessionId: 'session-1',
      reviewed: { steps: true },
      versions: [{ version: 1, createdAt: '2026-10-01T00:00:00Z', reason: 'premier jet' }]
    });
    await workDir.importTickets([ticket({ revision: '2', description: 'Nouvelle règle.' })], 'azureDevOps');

    const target = await replanFromSource(workDir, plans, (await workDir.findStory('42'))!, 'azureDevOps');

    expect(path.dirname(target)).toBe(path.join(work, 'new'));
    expect(await workDir.listStories('ready')).toEqual([]);
    const card = matter(await fs.readFile(target, 'utf8'));
    expect(card.content).toContain('Nouvelle règle.');
    expect(card.data.needs_review).toBeUndefined();
    expect(card.data.plan).toBeUndefined();

    const state = await plans.load('42');
    expect(state?.phase).toBe('understanding');
    expect(state?.sessionId).toBeUndefined();
    expect(state?.reviewed).toEqual({});
    expect(state?.versions).toHaveLength(1);
    expect((await plans.readHistory('42')).at(-1)?.kind).toBe('réouverture');
  });

  it('relit New et Ready de cette source, sans Done ni les fiches locales', async () => {
    await workDir.importTickets([ticket(), ticket({ sourceId: '43', title: 'Autre' })], 'azureDevOps');
    await workDir.createLocalStory('À la main', null);
    await fs.rename(
      path.join(work, 'new', '43-autre.md'),
      path.join(work, 'done', '43-autre.md')
    );
    const source = fakeSource([ticket({ revision: '2', title: 'Valider un email', description: 'Changé.' })]);

    const report = await resyncStories(workDir, source);

    expect(source.reads).toEqual([['42']]);
    expect(report.results.map((r) => [r.sourceId, r.outcome])).toEqual([['42', 'updated']]);
    expect(report.missing).toEqual([]);
  });

  it('signale les stories absentes de la source et celles fermées', async () => {
    await workDir.importTickets([ticket(), ticket({ sourceId: '43', title: 'Autre' })], 'azureDevOps');
    const report = await resyncStories(workDir, fakeSource([ticket({ state: 'Closed' })]));
    expect(report.missing).toEqual(['43']);
    expect(report.closed).toEqual(['42']);
  });

  it('garde le parent d’une story relue seule', async () => {
    await workDir.importTickets([ticket({ parentId: '10' })], 'azureDevOps');
    await resyncStories(workDir, fakeSource([ticket({ revision: '2', description: 'Changé.' })]));
    expect((await workDir.findStory('42'))?.frontmatter.parent).toBe('10');
  });

  it('ne signale en arrière-plan que les changements nouveaux', async () => {
    await planned();
    const changed = fakeSource([ticket({ revision: '2', description: 'Changé.' })]);
    expect(freshChanges(await resyncStories(workDir, changed)).map((r) => r.sourceId)).toEqual(['42']);
    expect(freshChanges(await resyncStories(workDir, changed))).toEqual([]);
  });
});

describe('notifications', () => {
  it('filtre selon le niveau', () => {
    expect(shouldNotify('all', 'merged')).toBe(true);
    expect(shouldNotify('actions', 'merged')).toBe(false);
    expect(shouldNotify('actions', 'returned')).toBe(false);
    expect(shouldNotify('actions', 'awaitingHuman')).toBe(true);
    expect(shouldNotify('actions', 'mergedWithWarning')).toBe(true);
    expect(shouldNotify('actions', 'sourceChanged')).toBe(true);
    expect(shouldNotify('none', 'blocked')).toBe(false);
  });

  it('compte une fois chaque story qui attend, à valider, bloquée ou à revoir', () => {
    const run = (storyId: string, status: StoryRun['status']) => ({ storyId, status }) as StoryRun;
    const runs = [run('1', 'awaiting_human'), run('2', 'blocked'), run('3', 'in_dev'), run('4', 'queued')];
    expect(waitingCount(runs, ['2', '5'])).toBe(3);
  });
});
