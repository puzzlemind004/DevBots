/**
 * Lecture et écriture du dossier `.work`.
 *
 * Le format existant ne change pas : `new/`, `ready/`, `done/` contiennent une
 * fiche markdown par story, et `state.json` (phase 3) tiendra l'état du flux.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';
import type { SourceKind, StoryFrontmatter, Ticket } from './model.js';
import { renderStoryCard, storyFileName } from './storyCard.js';

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

  async ensureFolders(): Promise<void> {
    for (const folder of STORY_FOLDERS) {
      await fs.mkdir(this.folderPath(folder), { recursive: true });
    }
  }

  /** Toutes les fiches d'un dossier, triées par identifiant de source. */
  async listStories(folder: StoryFolder): Promise<StoryFile[]> {
    const dir = this.folderPath(folder);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if (isMissing(err)) {
        return [];
      }
      throw err;
    }

    const stories: StoryFile[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) {
        continue;
      }
      const filePath = path.join(dir, name);
      const story = await this.readStory(filePath, folder);
      if (story) {
        stories.push(story);
      }
    }
    return stories.sort((a, b) => compareIds(a.frontmatter.source_id, b.frontmatter.source_id));
  }

  private async readStory(filePath: string, folder: StoryFolder): Promise<StoryFile | undefined> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = matter(raw);
      const data = parsed.data as Partial<StoryFrontmatter>;
      // Sans identifiant de source, la fiche n'est pas exploitable par le flux.
      if (data.source_id === undefined || data.source_id === null) {
        return undefined;
      }
      const frontmatter = { ...data, source_id: String(data.source_id) };
      return {
        filePath,
        folder,
        frontmatter,
        title: frontmatter.title ?? firstHeading(parsed.content) ?? path.basename(filePath, '.md')
      };
    } catch {
      // Une fiche illisible ne doit pas casser le panneau : on l'ignore.
      return undefined;
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

function firstHeading(content: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim();
}

/** Trie numériquement quand les deux identifiants sont des nombres, sinon alphabétiquement. */
function compareIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) {
    return na - nb;
  }
  return a.localeCompare(b);
}

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
