/**
 * L'ordonnancement : quelles stories de la file peuvent partir en dev.
 *
 * Purement déterministe, sans Claude. Deux règles :
 *
 * 1. une dépendance n'est attendue que si le plan l'a confirmée (les deux
 *    stories touchent des fichiers ou des contrats communs) ; une dépendance
 *    infirmée est « parallélisable d'après le code ». Tu peux trancher
 *    autrement, story par story ;
 * 2. deux stories qui touchent un même fichier ne sont jamais en dev en même
 *    temps : la seconde attend que la première soit mergée.
 */

import type { StoryFrontmatter } from './model.js';
import { ACTIVE_STATUSES, RUNNING_STATUSES, type FlowState, type StoryRun } from './flowState.js';

/** Ce que l'ordonnancement lit d'une fiche de `ready/`. */
export interface SchedulableStory {
  id: string;
  /** Dépendances déclarées par la source. */
  declared: string[];
  confirmed: string[];
  refuted: string[];
  files: string[];
}

export function schedulable(
  frontmatter: Partial<StoryFrontmatter> & { source_id: string }
): SchedulableStory {
  return {
    id: frontmatter.source_id,
    declared: strings(frontmatter.dependencies),
    confirmed: strings(frontmatter.dependencies_confirmed),
    refuted: strings(frontmatter.dependencies_refuted),
    files: strings(frontmatter.files).map(normalizeFile)
  };
}

export interface DependencyView {
  /** Dépendances à attendre. */
  waitOn: string[];
  /** Dépendances déclarées que le plan a infirmées, et que tu n'as pas rétablies. */
  parallelizable: string[];
  /** Dépendances confirmées que tu as levées. */
  ignored: string[];
}

/**
 * Les dépendances retenues pour une story, tes arbitrages compris.
 *
 * Une dépendance déclarée sans verdict (une fiche issue du tri, par exemple)
 * est attendue : dans le doute, on ne parallélise pas.
 */
export function dependencyView(
  story: SchedulableStory,
  overrides: Record<string, 'wait' | 'ignore'> = {}
): DependencyView {
  const all = unique([...story.declared, ...story.confirmed, ...story.refuted]);
  const view: DependencyView = { waitOn: [], parallelizable: [], ignored: [] };
  for (const dep of all) {
    const override = overrides[dep];
    const refuted = story.refuted.includes(dep) && !story.confirmed.includes(dep);
    if (override === 'ignore') {
      view.ignored.push(dep);
    } else if (override === 'wait' || !refuted) {
      view.waitOn.push(dep);
    } else {
      view.parallelizable.push(dep);
    }
  }
  return view;
}

export interface ScheduleContext {
  state: FlowState;
  /** Les stories de `done/`. */
  doneIds: ReadonlySet<string>;
  /** Toutes les stories connues du flux, tous dossiers confondus. */
  knownIds: ReadonlySet<string>;
  /** Les fiches de `ready/`, par identifiant. */
  stories: ReadonlyMap<string, SchedulableStory>;
}

/**
 * Ce qui empêche une story de partir en dev, en phrases. Vide : elle peut partir.
 *
 * @param others Les stories qui occupent leurs fichiers ; par défaut, celles
 * de `state.json` dans un état actif.
 */
export function blockers(
  story: SchedulableStory,
  ctx: ScheduleContext,
  others: StoryRun[] = activeRuns(ctx.state)
): string[] {
  const reasons: string[] = [];
  const view = dependencyView(story, ctx.state.dependencyOverrides[story.id]);
  for (const dep of view.waitOn) {
    if (ctx.doneIds.has(dep)) {
      continue;
    }
    reasons.push(ctx.knownIds.has(dep) ? `attend ${dep}` : `attend ${dep}, absente du flux`);
  }
  for (const other of others) {
    if (other.storyId === story.id) {
      continue;
    }
    const theirs = ctx.stories.get(other.storyId)?.files ?? [];
    const common = story.files.filter((f) => theirs.includes(f));
    if (common.length > 0) {
      reasons.push(`fichiers communs avec ${other.storyId} : ${common.slice(0, 3).join(', ')}${common.length > 3 ? '…' : ''}`);
    }
  }
  return reasons;
}

export interface Selection {
  /** Les stories à lancer maintenant, dans l'ordre de la file. */
  start: string[];
  /** Les stories qui restent en file, avec la raison. */
  waiting: Map<string, string>;
}

/**
 * Choisit dans la file, par ordre d'arrivée, les stories à lancer sans
 * dépasser le plafond d'agents.
 *
 * Une story choisie occupe aussitôt ses fichiers : la suivante qui les partage
 * attend, même si elles étaient toutes deux en file.
 */
export function pickNext(ctx: ScheduleContext, maxParallel: number): Selection {
  const runs = Object.values(ctx.state.stories);
  const running = runs.filter((r) => RUNNING_STATUSES.includes(r.status));
  let capacity = Math.max(0, maxParallel - running.length);
  const occupying = activeRuns(ctx.state);
  const queued = runs
    .filter((r) => r.status === 'queued')
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));

  const pick: Selection = { start: [], waiting: new Map() };
  for (const run of queued) {
    const story = ctx.stories.get(run.storyId);
    if (!story) {
      pick.waiting.set(run.storyId, "fiche absente de ready/");
      continue;
    }
    const reasons = blockers(story, ctx, occupying);
    if (reasons.length > 0) {
      pick.waiting.set(run.storyId, reasons.join(' ; '));
      continue;
    }
    if (capacity === 0) {
      pick.waiting.set(run.storyId, `plafond de ${maxParallel} agent${maxParallel > 1 ? 's' : ''} atteint`);
      continue;
    }
    capacity -= 1;
    pick.start.push(run.storyId);
    occupying.push(run);
  }
  return pick;
}

function activeRuns(state: FlowState): StoryRun[] {
  return Object.values(state.stories).filter((r) => ACTIVE_STATUSES.includes(r.status));
}

/** `src\app\a.ts` et `./src/app/a.ts` désignent le même fichier que `src/app/a.ts`. */
export function normalizeFile(file: string): string {
  return file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
