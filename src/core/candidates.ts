/**
 * Ce que la liste d'import n'a plus besoin de proposer.
 */

import type { TicketCandidate } from './model.js';

/** Une fiche déjà dans `.work` : son identifiant et celui de son parent. */
export interface KnownCard {
  sourceId: string;
  parent?: string | null;
}

/**
 * Les candidats dont l'import n'apporterait rien de neuf.
 *
 * Une story l'est dès que sa fiche existe. Un parent l'est quand chacun de ses
 * enfants a sa fiche, et qu'un enfant qui regroupe lui-même des stories est
 * complet à son tour ; le nombre d'enfants donné par la source fait foi. Faute
 * de le connaître, ou sans enfant, un parent reste proposé.
 */
export function alreadyImported(
  candidates: TicketCandidate[],
  stories: KnownCard[],
  features: KnownCard[]
): Set<string> {
  const storyIds = new Set(stories.map((s) => s.sourceId));
  const childrenOf = new Map<string, string[]>();
  for (const card of [...stories, ...features]) {
    if (card.parent !== undefined && card.parent !== null) {
      const parent = String(card.parent);
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), card.sourceId]);
    }
  }
  const listed = new Map(candidates.map((c) => [c.sourceId, c]));

  const complete = (id: string, seen: Set<string>): boolean => {
    const candidate = listed.get(id);
    // Un enfant absent de la liste (fermé, ou au-delà du plafond) vient de
    // `.work` : sa fiche existe, il est donc là.
    if (candidate === undefined) {
      return true;
    }
    if (candidate.level === 'story' || (candidate.level === undefined && !candidate.childCount)) {
      return storyIds.has(id);
    }
    if (seen.has(id) || !candidate.childCount) {
      return false;
    }
    const children = childrenOf.get(id) ?? [];
    const next = new Set(seen).add(id);
    return (
      children.length >= candidate.childCount && children.every((child) => complete(child, next))
    );
  };

  return new Set(candidates.filter((c) => complete(c.sourceId, new Set())).map((c) => c.sourceId));
}
