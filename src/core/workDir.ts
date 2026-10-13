/**
 * Lecture et écriture du dossier `.work`.
 *
 * Le format existant ne change pas : `new/`, `ready/`, `done/` contiennent une
 * fiche markdown par story, `features/` les features, `plans/` garde les
 * ateliers de planification, `runs/` les journaux, CR et rapports du dev, et
 * `state.json` le parcours des stories après Ready.
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

/** Ce qu'un import a fait d'un ticket. */
export type ImportOutcome = 'created' | 'unchanged' | 'needsReview';

export interface ImportResult {
  sourceId: string;
  title: string;
  outcome: ImportOutcome;
  filePath: string;
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
   * Une story déjà présente dont la révision a changé dans la source n'est pas
   * écrasée : elle est marquée « à revoir », où qu'elle se trouve dans le flux.
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

      if (!known) {
        const filePath = path.join(this.folderPath('new'), storyFileName(ticket));
        await fs.writeFile(filePath, renderStoryCard(ticket, source, importedAt), 'utf8');
        results.push({ sourceId: ticket.sourceId, title: ticket.title, outcome: 'created', filePath });
        continue;
      }

      if (known.frontmatter.source_rev === ticket.revision) {
        results.push({
          sourceId: ticket.sourceId,
          title: ticket.title,
          outcome: 'unchanged',
          filePath: known.filePath
        });
        continue;
      }

      // La story a bougé dans la source. Une fiche encore dans `new/` peut être
      // réécrite sans rien perdre ; au-delà, un plan ou un CR existe : on marque.
      if (known.folder === 'new') {
        await fs.writeFile(known.filePath, renderStoryCard(ticket, source, importedAt), 'utf8');
        results.push({
          sourceId: ticket.sourceId,
          title: ticket.title,
          outcome: 'created',
          filePath: known.filePath
        });
      } else {
        await this.markNeedsReview(known, ticket.revision);
        results.push({
          sourceId: ticket.sourceId,
          title: ticket.title,
          outcome: 'needsReview',
          filePath: known.filePath
        });
      }
    }
    return results;
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

  /**
   * Ajoute `needs_review` au frontmatter, sans toucher au corps de la fiche :
   * le plan et les échanges déjà faits sur cette story restent intacts.
   */
  private async markNeedsReview(story: StoryFile, newRevision: string): Promise<void> {
    const raw = await fs.readFile(story.filePath, 'utf8');
    const parsed = matter(raw);
    const data = {
      ...(parsed.data as Record<string, unknown>),
      needs_review: true,
      source_rev_seen: newRevision
    };
    await fs.writeFile(story.filePath, matter.stringify(parsed.content, data), 'utf8');
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
