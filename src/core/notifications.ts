/**
 * Ce qui mérite une notification, selon le niveau choisi.
 *
 * Le panneau, la barre d'état et le badge de l'icône DevBots disent toujours
 * tout ; les notifications n'en sont qu'un écho, réglable.
 */

import type { FlowStatus, StoryRun } from './flowState.js';

/**
 * `all` : tout ce qui se passe. `actions` : seulement ce qui attend un geste
 * de ta part. `none` : rien, le badge suffit.
 */
export type NotificationLevel = 'all' | 'actions' | 'none';

/** Les moments du flux qui peuvent donner lieu à une notification. */
export type NotificationKind =
  | 'awaitingHuman'
  | 'blocked'
  | 'mergeFailed'
  | 'returned'
  | 'merged'
  | 'mergedWithWarning'
  | 'sourceChanged';

/** Ceux qui demandent un geste : revue, relance, décision sur un changement, nettoyage à finir. */
const ACTIONS: ReadonlySet<NotificationKind> = new Set([
  'awaitingHuman',
  'blocked',
  'mergeFailed',
  'mergedWithWarning',
  'sourceChanged'
]);

export function shouldNotify(level: NotificationLevel, kind: NotificationKind): boolean {
  if (level === 'none') {
    return false;
  }
  return level === 'all' || ACTIONS.has(kind);
}

/** Les états d'une story du flux qui attendent ton geste. */
const WAITING: ReadonlySet<FlowStatus> = new Set(['awaiting_human', 'blocked']);

/**
 * Le nombre affiché sur l'icône DevBots : les stories qui t'attendent, à
 * valider, bloquées ou à revoir. Une story compte une fois.
 */
export function waitingCount(runs: StoryRun[], needsReview: string[]): number {
  const ids = new Set(runs.filter((r) => WAITING.has(r.status)).map((r) => r.storyId));
  for (const id of needsReview) {
    ids.add(id);
  }
  return ids.size;
}
