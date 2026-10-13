/**
 * Lecture et écriture du dossier `.work`.
 *
 * Le format existant ne change pas : `new/`, `ready/`, `done/` contiennent une
 * fiche markdown par story, `features/` les features, `plans/` garde les
 * ateliers de planification, `runs/` les journaux, CR et rapports du dev, et
 * `state.json` le parcours des stories après Ready. `sources/` garde, pour
 * chaque story importée, la version de la source qui sert de référence à la
 * resynchronisation.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';
import type { FeatureFrontmatter, SourceKind, StoryFrontmatter, Ticket } from './model.js';
import {
  cardFileName,
  renderImportedFeatureCard,
  renderStoryCard,
  storyFileName
} from './storyCard.js';
import {
  LOCAL_FEATURE_PREFIX,
  LOCAL_STORY_PREFIX,
  nextLocalId,
  renderFeatureCard,
  renderLocalStoryCard
} from './localCards.js';
import { safeId } from './planStore.js';

/** Les groupes du panneau qui correspondent à un dossier sur disque. */
export type StoryFolder = 'new' | 'ready' | 'done';

export const STORY_FOLDERS: readonly StoryFolder[] = ['new', 'ready', 'done'];

/**
 * Une fiche lue sur disque.
 *
 * `source_id` est garanti : une fiche sans identifiant de source ne serait
 * rattachable ni à son ticket ni au graphe de dépendances, donc elle est écartée
 * à la lecture.
 */
export interface StoryFile {
  /** Chemin absolu du fichier. */
  filePath: string;
  folder: StoryFolder;
  frontmatter: Partial<StoryFrontmatter> & { source_id: string };
  title: string;
}

/** Une fiche de feature lue dans `features/`. */
export interface FeatureFile {
  filePath: string;
  frontmatter: Partial<FeatureFrontmatter> & { source_id: string };
  title: string;
}

/** Une fiche saisie à la main, juste écrite. */
export interface CreatedCard {
  id: string;
  filePath: string;
}

/**
 * Ce qu'un import ou une resynchronisation a fait d'un ticket : fiche créée,
 * réécrite dans `new/`, inchangée (au plus son frontmatter rafraîchi), ou
 * marquée « à revoir ».
 */
export type ImportOutcome = 'created' | 'updated' | 'unchanged' | 'needsReview';

export interface ImportResult {
  sourceId: string;
  title: string;
  outcome: ImportOutcome;
  filePath: string;
  /** Pour `needsReview` : vrai quand ce changement n'avait pas encore été signalé. */
  fresh?: boolean;
}

export class WorkDir {
  constructor(private readonly root: string) {}

  /** Chemin absolu d'un des dossiers du flux. */
  folderPath(folder: StoryFolder): string {
    return path.join(this.root, folder);
  }

  /** Dossier des planifications : `.work/plans/<id>/`. */
  plansPath(): string {
    return path.join(this.root, 'plans');
  }

  /** Dossier des features saisies à la main : `.work/features/`. */
  featuresPath(): string {
    return path.join(this.root, 'features');
  }

  async ensureFolders(): Promise<void> {
    for (const folder of STORY_FOLDERS) {
      await fs.mkdir(this.folderPath(folder), { recursive: true });
    }
  }

  /** Toutes les fiches d'un dossier, triées par identifiant de source. */
  async listStories(folder: StoryFolder): Promise<StoryFile[]> {
    const cards = await readCards<StoryFrontmatter>(this.folderPath(folder));
    return cards.map((card) => ({ ...card, folder }));
  }

  /** Les features de `features/`, triées par identifiant. */
  async listFeatures(): Promise<FeatureFile[]> {
    return readCards<FeatureFrontmatter>(this.featuresPath());
  }

  /** La fiche d'une feature, d'après l'identifiant porté par le `parent` d'une story. */
  async findFeature(id: string | null | undefined): Promise<FeatureFile | undefined> {
    if (id === undefined || id === null) {
      return undefined;
    }
    return (await this.listFeatures()).find((f) => f.frontmatter.source_id === String(id));
  }

  /** Crée une feature `LOCAL-F<n>` pré-remplie. */
  async createFeature(title: string, createdAt = new Date()): Promise<CreatedCard> {
    const taken = (await this.listFeatures()).map((f) => f.frontmatter.source_id);
    const id = nextLocalId(LOCAL_FEATURE_PREFIX, taken);
    await fs.mkdir(this.featuresPath(), { recursive: true });
    const filePath = path.join(this.featuresPath(), cardFileName(id, title));
    // `wx` : une fiche existante n'est jamais écrasée.
    await fs.writeFile(filePath, renderFeatureCard({ id, title, createdAt }), {
      encoding: 'utf8',
      flag: 'wx'
    });
    return { id, filePath };
  }

  /**
   * Crée une story `LOCAL-<n>` pré-remplie dans `new/`.
   *
   * Les identifiants déjà vus dans `plans/` comptent aussi : une story
   * supprimée laisse son atelier, que la suivante ne doit pas reprendre.
   */
  async createLocalStory(
    title: string,
    parent: string | null,
    createdAt = new Date()
  ): Promise<CreatedCard> {
    return this.createLocalCard('new', title, (id) =>
      renderLocalStoryCard({ id, title, parent, createdAt })
    );
  }

  /**
   * Écrit une fiche `LOCAL-<n>` dans `new/` ou `ready/`, rendue par `render`
   * une fois l'identifiant attribué. Sert aux fiches nées du tri des problèmes.
   */
  async createLocalCard(
    folder: 'new' | 'ready',
    title: string,
    render: (id: string) => string
  ): Promise<CreatedCard> {
    await this.ensureFolders();
    const taken = [...(await this.indexBySourceId()).keys(), ...(await this.planIds())];
    const id = nextLocalId(LOCAL_STORY_PREFIX, taken);
    const filePath = path.join(this.folderPath(folder), cardFileName(id, title));
    // `wx` : une fiche existante n'est jamais écrasée.
    await fs.writeFile(filePath, render(id), { encoding: 'utf8', flag: 'wx' });
    return { id, filePath };
  }

  /** La fiche d'une story, où qu'elle soit dans le flux. */
  async findStory(id: string): Promise<StoryFile | undefined> {
    return (await this.indexBySourceId()).get(id);
  }

  /**
   * Passe une fiche dans `done/`, avec ce que le merge ajoute à son
   * frontmatter. Le corps (la story et son plan) reste intact.
   */
  async moveToDone(
    story: StoryFile,
    merge: Pick<StoryFrontmatter, 'merged_at' | 'merge_commit' | 'merged_into'>
  ): Promise<string> {
    await this.ensureFolders();
    const parsed = matter(await fs.readFile(story.filePath, 'utf8'));
    const target = path.join(this.folderPath('done'), path.basename(story.filePath));
    const data = { ...(parsed.data as Record<string, unknown>), ...merge };
    // `wx` : une fiche de done/ n'est jamais écrasée.
    await fs.writeFile(target, matter.stringify(parsed.content, data), { encoding: 'utf8', flag: 'wx' });
    await fs.rm(story.filePath);
    return target;
  }

  /** Dossier des exécutions : `.work/runs/<id>/` (journal, CR, rapport). */
  runsPath(): string {
    return path.join(this.root, 'runs');
  }

  /** `.work/state.json` : l'état du flux après Ready. */
  statePath(): string {
    return path.join(this.root, 'state.json');
  }

  get rootPath(): string {
    return this.root;
  }

  /** Les dossiers d'atelier de `plans/`, nommés d'après l'identifiant de la story. */
  private async planIds(): Promise<string[]> {
    try {
      return await fs.readdir(this.plansPath());
    } catch (err) {
      if (isMissing(err)) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Écrit les tickets dans `new/`.
   *
   * Une story déjà présente n'est réécrite que si elle est encore dans `new/`.
   * Plus loin dans le flux, un plan ou un CR existe : si sa révision a changé
   * dans la source, elle est marquée « à revoir », où qu'elle se trouve.
   */
  async importTickets(
    tickets: Ticket[],
    source: SourceKind,
    importedAt = new Date()
  ): Promise<ImportResult[]> {
    await this.ensureFolders();
    const existing = await this.indexBySourceId();
    const results: ImportResult[] = [];

    for (const ticket of tickets) {
      const known = existing.get(ticket.sourceId);
      if (known) {
        results.push(await this.syncStory(known, ticket, source, importedAt));
        continue;
      }
      const filePath = path.join(this.folderPath('new'), storyFileName(ticket));
      const card = renderStoryCard(ticket, source, importedAt);
      await fs.writeFile(filePath, card, 'utf8');
      await this.writeReference(ticket.sourceId, card);
      results.push({ sourceId: ticket.sourceId, title: ticket.title, outcome: 'created', filePath });
    }
    return results;
  }

  /** `.work/sources/` : la version de la source qui sert de référence, story par story. */
  sourcesPath(): string {
    return path.join(this.root, 'sources');
  }

  /** La fiche telle que la source la donnait à la dernière version acceptée. */
  referencePath(storyId: string): string {
    return path.join(this.sourcesPath(), `${safeId(storyId)}.md`);
  }

  /** La version reçue de la source, en attente de ta décision. */
  incomingPath(storyId: string): string {
    return path.join(this.sourcesPath(), `${safeId(storyId)}.incoming.md`);
  }

  /**
   * Le changement est sans effet sur le plan : la version reçue devient la
   * référence, la fiche garde son contenu et perd sa marque.
   */
  async acceptSourceChange(story: StoryFile): Promise<void> {
    const id = story.frontmatter.source_id;
    const incoming = await readOptional(this.incomingPath(id));
    if (incoming !== undefined) {
      await this.writeReference(id, incoming);
      await fs.rm(this.incomingPath(id), { force: true });
    }
    await this.updateFrontmatter(story.filePath, (data) => {
      if (data.source_rev_seen !== undefined) {
        data.source_rev = data.source_rev_seen;
      }
      delete data.needs_review;
      delete data.source_rev_seen;
    });
  }

  /**
   * Renvoie une story de `ready/` dans `new/`, réécrite d'après la version
   * reçue de la source : son plan est à refaire. Rend le chemin de la fiche.
   */
  async returnToNew(story: StoryFile): Promise<string> {
    const id = story.frontmatter.source_id;
    if (story.folder !== 'ready') {
      throw new Error(`${id} n'est pas dans ready/ : seule une story planifiée se replanifie.`);
    }
    const incoming = await readOptional(this.incomingPath(id));
    if (incoming === undefined) {
      throw new Error(`Aucune version reçue de la source pour ${id} : lance d'abord la resynchronisation.`);
    }
    const target = path.join(this.folderPath('new'), path.basename(story.filePath));
    // `wx` : une fiche de new/ n'est jamais écrasée.
    await fs.writeFile(target, incoming, { encoding: 'utf8', flag: 'wx' });
    await this.writeReference(id, incoming);
    await fs.rm(this.incomingPath(id), { force: true });
    await fs.rm(story.filePath);
    return target;
  }

  /**
   * Confronte une fiche connue à ce que la source en dit aujourd'hui.
   *
   * Le repère est la révision : tout changement compte, y compris un
   * commentaire GitHub ou un champ qu'Azure DevOps ne reporte pas dans la
   * fiche. La référence de `sources/` ne sert qu'à montrer la différence.
   */
  private async syncStory(
    known: StoryFile,
    received: Ticket,
    source: SourceKind,
    at: Date
  ): Promise<ImportResult> {
    const id = received.sourceId;
    // Une story relue seule ne connaît pas toujours son parent : on garde le sien.
    const ticket =
      received.parentId === undefined &&
      known.frontmatter.parent !== undefined &&
      known.frontmatter.parent !== null
        ? { ...received, parentId: String(known.frontmatter.parent) }
        : received;
    const card = renderStoryCard(ticket, source, at);
    const result = { sourceId: id, title: ticket.title, filePath: known.filePath };

    if (known.frontmatter.source_rev === ticket.revision) {
      if ((await readOptional(this.referencePath(id))) === undefined) {
        // Même révision qu'à l'import : ce contenu est la référence qui manquait.
        await this.writeReference(id, card);
      }
      return { ...result, outcome: 'unchanged' };
    }

    if (known.folder === 'new') {
      // Ni plan ni CR : la fiche est réécrite sous son nom d'origine.
      await fs.writeFile(known.filePath, card, 'utf8');
      await this.writeReference(id, card);
      await fs.rm(this.incomingPath(id), { force: true });
      return { ...result, outcome: 'updated' };
    }

    const fresh = known.frontmatter.source_rev_seen !== ticket.revision;
    await fs.mkdir(this.sourcesPath(), { recursive: true });
    await fs.writeFile(this.incomingPath(id), card, 'utf8');
    // Le corps de la fiche ne bouge pas : le plan et les échanges restent intacts.
    await this.updateFrontmatter(known.filePath, (data) => {
      data.needs_review = true;
      data.source_rev_seen = ticket.revision;
      data.state = ticket.state;
    });
    return { ...result, outcome: 'needsReview', fresh };
  }

  private async writeReference(storyId: string, card: string): Promise<void> {
    await fs.mkdir(this.sourcesPath(), { recursive: true });
    await fs.writeFile(this.referencePath(storyId), card, 'utf8');
  }

  /** Retouche le frontmatter d'une fiche, sans toucher à son corps. */
  private async updateFrontmatter(
    filePath: string,
    edit: (data: Record<string, unknown>) => void
  ): Promise<void> {
    const parsed = matter(await fs.readFile(filePath, 'utf8'));
    const data = { ...(parsed.data as Record<string, unknown>) };
    edit(data);
    await fs.writeFile(filePath, matter.stringify(parsed.content, data), 'utf8');
  }

  /**
   * Écrit dans `features/` les tickets qui regroupent des stories.
   *
   * Une feature ne porte ni plan ni échange : une révision nouvelle la réécrit
   * sur place, sans marquage « à revoir ».
   */
  async importFeatures(
    tickets: Ticket[],
    source: SourceKind,
    importedAt = new Date()
  ): Promise<ImportResult[]> {
    const existing = new Map(
      (await this.listFeatures()).map((f) => [f.frontmatter.source_id, f] as const)
    );
    const results: ImportResult[] = [];
    for (const ticket of tickets) {
      const known = existing.get(ticket.sourceId);
      const result = { sourceId: ticket.sourceId, title: ticket.title };
      if (known?.frontmatter.source_rev === ticket.revision) {
        results.push({ ...result, outcome: 'unchanged', filePath: known.filePath });
        continue;
      }
      await fs.mkdir(this.featuresPath(), { recursive: true });
      const filePath = known?.filePath ?? path.join(this.featuresPath(), storyFileName(ticket));
      await fs.writeFile(filePath, renderImportedFeatureCard(ticket, source, importedAt), 'utf8');
      results.push({ ...result, outcome: 'created', filePath });
    }
    return results;
  }

  /** Index de toutes les fiches du flux, par identifiant de source. */
  async indexBySourceId(): Promise<Map<string, StoryFile>> {
    const index = new Map<string, StoryFile>();
    for (const folder of STORY_FOLDERS) {
      for (const story of await this.listStories(folder)) {
        index.set(story.frontmatter.source_id, story);
      }
    }
    return index;
  }
}

/** Une fiche lue sur disque, avant d'être rattachée à son dossier. */
interface Card<T> {
  filePath: string;
  frontmatter: Partial<T> & { source_id: string };
  title: string;
}

/** Les fiches markdown d'un dossier, triées par identifiant. Un dossier absent est vide. */
async function readCards<T extends { title: string }>(dir: string): Promise<Array<Card<T>>> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (isMissing(err)) {
      return [];
    }
    throw err;
  }

  const cards: Array<Card<T>> = [];
  for (const name of names) {
    if (!name.endsWith('.md')) {
      continue;
    }
    const card = await readCard<T>(path.join(dir, name));
    if (card) {
      cards.push(card);
    }
  }
  return cards.sort((a, b) => compareIds(a.frontmatter.source_id, b.frontmatter.source_id));
}

async function readCard<T extends { title: string }>(
  filePath: string
): Promise<Card<T> | undefined> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = matter(raw);
    const data = parsed.data as Partial<T> & { source_id?: unknown };
    // Sans identifiant de source, la fiche n'est pas exploitable par le flux.
    if (data.source_id === undefined || data.source_id === null) {
      return undefined;
    }
    const frontmatter = { ...data, source_id: String(data.source_id) };
    return {
      filePath,
      frontmatter,
      title: frontmatter.title ?? firstHeading(parsed.content) ?? path.basename(filePath, '.md')
    };
  } catch {
    // Une fiche illisible ne doit pas casser le panneau : on l'ignore.
    return undefined;
  }
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (isMissing(err)) {
      return undefined;
    }
    throw err;
  }
}

function firstHeading(content: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim();
}

/**
 * Trie numériquement quand les deux identifiants sont des nombres, sinon
 * alphabétiquement, numéros compris dans l'ordre (`LOCAL-2` avant `LOCAL-10`).
 */
function compareIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) {
    return na - nb;
  }
  return a.localeCompare(b, undefined, { numeric: true });
}

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
