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
