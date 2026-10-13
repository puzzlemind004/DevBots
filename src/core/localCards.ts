/**
 * Les fiches saisies à la main : stories `LOCAL-<n>` et features `LOCAL-F<n>`.
 *
 * Elles naissent pré-remplies, avec des mentions « À compléter » en italique,
 * et s'ouvrent dans l'éditeur. Leur format est celui des fiches importées : les
 * skills et l'atelier les lisent sans distinction.
 */

import type { FeatureFrontmatter, StoryFrontmatter } from './model.js';
import { renderFrontmatter } from './storyCard.js';

export const LOCAL_STORY_PREFIX = 'LOCAL-';
export const LOCAL_FEATURE_PREFIX = 'LOCAL-F';

/** Repère les mentions laissées par le gabarit tant que la fiche n'est pas remplie. */
const TO_COMPLETE = '_À compléter';

/**
 * Le prochain identifiant libre pour un préfixe, d'après ceux déjà pris.
 *
 * Le plus grand numéro plus un : un identifiant supprimé n'est pas réattribué
 * tant qu'un numéro supérieur existe, et `LOCAL-F2` ne compte pas pour `LOCAL-`.
 */
export function nextLocalId(prefix: string, taken: Iterable<string>): string {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  for (const id of taken) {
    const match = pattern.exec(id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `${prefix}${max + 1}`;
}

export interface LocalStoryInput {
  id: string;
  title: string;
  /** Identifiant de la feature, ou `null` pour une story isolée. */
  parent: string | null;
  createdAt: Date;
}

export function renderLocalStoryCard(input: LocalStoryInput): string {
  const fm: StoryFrontmatter = {
    source: 'local',
    source_id: input.id,
    parent: input.parent,
    created_at: input.createdAt.toISOString(),
    title: input.title,
    state: 'open'
  };
  return [
    renderFrontmatter(fm),
    '',
    `# ${input.title}`,
    '',
    '## Description',
    '',
    `${TO_COMPLETE} : le besoin, pour qui, et pourquoi._`,
    '',
    "## Critères d'acceptation",
    '',
    `${TO_COMPLETE} : un critère vérifiable par élément de liste._`,
    ''
  ].join('\n');
}

export interface FeatureInput {
  id: string;
  title: string;
  createdAt: Date;
}

export function renderFeatureCard(input: FeatureInput): string {
  const fm: FeatureFrontmatter = {
    source: 'local',
    source_id: input.id,
    level: 'feature',
    created_at: input.createdAt.toISOString(),
    title: input.title
  };
  return [
    renderFrontmatter(fm),
    '',
    `# ${input.title}`,
    '',
    '## Description',
    '',
    `${TO_COMPLETE} : l'objectif de la feature et le contexte commun à ses stories._`,
    ''
  ].join('\n');
}

/** Vrai tant qu'une mention « À compléter » du gabarit reste dans la fiche. */
export function isIncomplete(rawCard: string): boolean {
  return rawCard.includes(TO_COMPLETE);
}
