/**
 * Fusion des arbres de plusieurs imports en une seule liste de tickets.
 */

import type { Ticket } from './model.js';

/**
 * Concatène les arbres sans doublon.
 *
 * Une issue peut être choisie seule et apparaître aussi sous un parent choisi
 * dans le même import : la version qui connaît son parent l'emporte, pour que
 * la fiche garde son rattachement.
 */
export function mergeTrees(trees: Ticket[][]): Ticket[] {
  const merged = new Map<string, Ticket>();
  for (const tree of trees) {
    for (const ticket of tree) {
      const known = merged.get(ticket.sourceId);
      if (!known || (known.parentId === undefined && ticket.parentId !== undefined)) {
        merged.set(ticket.sourceId, ticket);
      }
    }
  }
  return [...merged.values()];
}

/**
 * Les tickets qui regroupent directement des stories : ils deviennent les
 * fiches de `.work/features`.
 *
 * Le niveau chez la source importe peu : une issue parente GitHub ou un epic
 * qui porte des stories en direct joue, dans le flux, le rôle de feature. Un
 * epic qui ne contient que des features n'en a pas.
 */
export function storyGroups(tickets: Ticket[]): Ticket[] {
  const parents = new Set(
    tickets.filter((t) => t.level === 'story' && t.parentId !== undefined).map((t) => t.parentId)
  );
  return tickets.filter((t) => t.level !== 'story' && parents.has(t.sourceId));
}
