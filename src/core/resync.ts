/**
 * La resynchronisation : relire chez la source les stories déjà importées,
 * sans repasser par la liste à cocher.
 *
 * Une fiche de `new/` est réécrite ; plus loin dans le flux, une story dont la
 * révision a changé est marquée « à revoir », et la version reçue attend ta
 * décision dans `sources/<id>.incoming.md` : garder le plan, ou replanifier.
 */

import type { CancellationLike, SourceKind, TicketSource } from './model.js';
import type { PlanStore } from './planStore.js';
import type { ImportResult, StoryFile, WorkDir } from './workDir.js';

/** Les états terminaux des processus standard, chez les deux sources. */
const CLOSED_STATES = new Set(['closed', 'done', 'removed']);

export interface ResyncReport {
  /** Une ligne par story relue. */
  results: ImportResult[];
  /** Stories absentes de la réponse : supprimées, inaccessibles ou écartées par le filtre d'auteur. */
  missing: string[];
  /** Stories fermées dans la source alors qu'elles ne sont pas dans Done. */
  closed: string[];
}

/**
 * Relit les stories de `new/` et `ready/` venues de cette source. Celles de
 * `done/` sont closes pour le flux, les fiches locales n'ont pas de source.
 */
export async function resyncStories(
  workDir: WorkDir,
  source: Pick<TicketSource, 'kind' | 'fetchTickets'>,
  cancellation?: CancellationLike
): Promise<ResyncReport> {
  const stories = [...(await workDir.listStories('new')), ...(await workDir.listStories('ready'))].filter(
    (s) => s.frontmatter.source === source.kind
  );
  if (stories.length === 0) {
    return { results: [], missing: [], closed: [] };
  }
  const ids = stories.map((s) => s.frontmatter.source_id);
  const wanted = new Set(ids);
  // Seules les stories demandées sont écrites : une source qui en rendrait
  // d'autres ne doit pas créer de fiche par ce chemin.
  const tickets = (await source.fetchTickets(ids, cancellation)).filter((t) => wanted.has(t.sourceId));
  if (cancellation?.isCancellationRequested) {
    return { results: [], missing: [], closed: [] };
  }
  const found = new Set(tickets.map((t) => t.sourceId));
  return {
    results: await workDir.importTickets(tickets, source.kind),
    missing: ids.filter((id) => !found.has(id)),
    closed: tickets.filter((t) => CLOSED_STATES.has(t.state.trim().toLowerCase())).map((t) => t.sourceId)
  };
}

/** Les stories dont un changement vient d'apparaître : ce que mérite une notification. */
export function freshChanges(report: ResyncReport): ImportResult[] {
  return report.results.filter((r) => r.outcome === 'needsReview' && r.fresh === true);
}

/**
 * Replanifier : la fiche revient dans `new/` réécrite d'après la source, et
 * l'atelier rouvre sur elle. Rend le chemin de la fiche de `new/`.
 */
export async function replanFromSource(
  workDir: WorkDir,
  plans: PlanStore,
  story: StoryFile,
  source: SourceKind | 'local' | undefined
): Promise<string> {
  const target = await workDir.returnToNew(story);
  await plans.reopen(
    story.frontmatter.source_id,
    `La story a changé dans ${source === 'azureDevOps' ? 'Azure DevOps' : source === 'github' ? 'GitHub' : 'la source'} : elle revient dans new/, le plan est à revoir. Les versions précédentes restent consultables.`
  );
  return target;
}
