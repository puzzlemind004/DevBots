import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import matter from 'gray-matter';
import { WorkDir } from '../../src/core/workDir.js';
import type { Ticket } from '../../src/core/model.js';

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    sourceId: '42',
    level: 'story',
    title: 'Valider un email',
    description: 'Description.',
    acceptanceCriteria: '- Un critère',
    state: 'open',
    revision: 'rev-1',
    webUrl: 'https://github.com/acme/web/issues/42',
    dependencies: [],
    attachments: [],
    ...overrides
  };
}

describe('WorkDir', () => {
  let root: string;
  let workDir: WorkDir;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'devbots-test-'));
    workDir = new WorkDir(path.join(root, '.work'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('crée les trois dossiers du flux', async () => {
    await workDir.ensureFolders();
    for (const folder of ['new', 'ready', 'done']) {
      const stat = await fs.stat(path.join(root, '.work', folder));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it('rend une liste vide quand le dossier n\'existe pas', async () => {
    expect(await workDir.listStories('new')).toEqual([]);
  });

  it('écrit une fiche par story dans new/', async () => {
    const results = await workDir.importTickets([ticket(), ticket({ sourceId: '43' })], 'github');
    expect(results.map((r) => r.outcome)).toEqual(['created', 'created']);
    const stories = await workDir.listStories('new');
    expect(stories).toHaveLength(2);
    expect(stories[0]?.frontmatter.source_id).toBe('42');
  });

  it('trie les stories numériquement', async () => {
    await workDir.importTickets(
      [ticket({ sourceId: '100' }), ticket({ sourceId: '9' })],
      'github'
    );
    const ids = (await workDir.listStories('new')).map((s) => s.frontmatter.source_id);
    expect(ids).toEqual(['9', '100']);
  });

  it('laisse une story inchangée quand la révision est la même', async () => {
    await workDir.importTickets([ticket()], 'github');
    const results = await workDir.importTickets([ticket()], 'github');
    expect(results[0]?.outcome).toBe('unchanged');
  });

  it('réécrit une fiche encore dans new/ quand la source a changé', async () => {
    await workDir.importTickets([ticket()], 'github');
    const results = await workDir.importTickets(
      [ticket({ revision: 'rev-2', title: 'Titre corrigé' })],
      'github'
    );
    expect(results[0]?.outcome).toBe('created');
    const stories = await workDir.listStories('new');
    // La fiche est réécrite sous son nom d'origine : pas de doublon.
    expect(stories).toHaveLength(1);
    expect(stories[0]?.frontmatter.source_rev).toBe('rev-2');
  });

  it('marque « à revoir » une story déjà passée en ready au lieu de l\'écraser', async () => {
    await workDir.importTickets([ticket()], 'github');
    // La story part en planification : la fiche passe dans ready/ avec son plan.
    const newPath = path.join(root, '.work', 'new', '42-valider-un-email.md');
    const readyPath = path.join(root, '.work', 'ready', '42-valider-un-email.md');
    const original = await fs.readFile(newPath, 'utf8');
    await fs.writeFile(readyPath, `${original}\n## Plan validé\n\n1. Écrire le validateur\n`, 'utf8');
    await fs.rm(newPath);

    const results = await workDir.importTickets([ticket({ revision: 'rev-2' })], 'github');
    expect(results[0]?.outcome).toBe('needsReview');

    const parsed = matter(await fs.readFile(readyPath, 'utf8'));
    expect(parsed.data.needs_review).toBe(true);
    expect(parsed.data.source_rev_seen).toBe('rev-2');
    // Le plan déjà écrit survit au marquage.
    expect(parsed.content).toContain('Écrire le validateur');
    // Et la story ne réapparaît pas dans new/.
    expect(await workDir.listStories('new')).toEqual([]);
  });

  it('ignore une fiche illisible sans casser la liste', async () => {
    await workDir.ensureFolders();
    await fs.writeFile(
      path.join(root, '.work', 'new', 'casse.md'),
      '---\nsource_id: [non: fermé\n',
      'utf8'
    );
    await workDir.importTickets([ticket()], 'github');
    const stories = await workDir.listStories('new');
    expect(stories.map((s) => s.frontmatter.source_id)).toEqual(['42']);
  });

  it('indexe toutes les fiches du flux par identifiant de source', async () => {
    await workDir.importTickets([ticket(), ticket({ sourceId: '43' })], 'github');
    const index = await workDir.indexBySourceId();
    expect([...index.keys()].sort()).toEqual(['42', '43']);
  });
});
