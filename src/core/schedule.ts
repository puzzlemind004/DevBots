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
    const common = commonFiles(story, ctx.stories.get(other.storyId));
    if (common.length > 0) {
      reasons.push(`fichiers communs avec ${other.storyId} : ${shortList(common)}`);
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

/** La place d'une story de Ready dans l'ordre de lancement. */
export interface ReadyPlace {
  /**
   * 1 : peut partir maintenant. n : après les stories qu'elle attend.
   * `null` : ne partira pas sans ton arbitrage (dépendance absente du flux,
   * cycle de dépendances, ou dépendance elle-même dans ce cas).
   */
  step: number | null;
  /** Ce qu'elle attend, en phrases. Vide à l'étape 1. */
  reasons: string[];
}

/**
 * L'ordre de lancement des stories de Ready qui ne sont pas encore parties.
 *
 * Les stories d'une même étape peuvent partir ensemble : aucune n'attend
 * l'autre, aucune ne partage de fichier avec une autre. L'étape 1 est ce que
 * `blockers` laisse partir aujourd'hui ; les suivantes supposent les
 * précédentes mergées. Une story en file compte comme partie : ses fichiers
 * sont pris.
 *
 * Attendre une story en dev, en file ou encore dans New repousse à l'étape 2,
 * comme partager un fichier avec une story en dev. Deux stories qui partagent
 * un fichier ne sont jamais à la même étape : la première de `ids` garde sa
 * place, l'autre descend.
 *
 * @param ids Les stories à placer, toutes présentes dans `ctx.stories`, dans
 * l'ordre de préférence.
 */
export function readyOrder(ctx: ScheduleContext, ids: string[]): Map<string, ReadyPlace> {
  const pending = new Set(ids);
  const committed = Object.values(ctx.state.stories).filter(
    (r) => r.status === 'queued' || ACTIVE_STATUSES.includes(r.status)
  );
  const places = new Map<string, ReadyPlace>();
  const steps = new Map<string, number>();
  const waits = new Map<string, string[]>();
  const floors = new Map<string, number>();
  const reasons = new Map<string, string[]>();

  for (const id of ids) {
    const story = ctx.stories.get(id)!;
    const view = dependencyView(story, ctx.state.dependencyOverrides[id]);
    const open = view.waitOn.filter((d) => !ctx.doneIds.has(d));
    waits.set(id, open.filter((d) => pending.has(d)));
    const said: string[] = [];
    let blocked = false;
    for (const dep of open.filter((d) => !pending.has(d))) {
      if (!ctx.knownIds.has(dep)) {
        blocked = true;
        said.push(`attend ${dep}, absente du flux`);
      } else if (committed.some((r) => r.storyId === dep)) {
        said.push(`attend ${dep}, en cours`);
      } else {
        said.push(`attend ${dep}, pas encore planifiée`);
      }
    }
    for (const run of committed) {
      const common = commonFiles(story, ctx.stories.get(run.storyId));
      if (run.storyId !== id && common.length > 0) {
        said.push(`fichiers communs avec ${run.storyId}, en cours : ${shortList(common)}`);
      }
    }
    reasons.set(id, said);
    if (blocked) {
      places.set(id, { step: null, reasons: said });
    } else {
      floors.set(id, said.length > 0 ? 2 : 1);
    }
  }

  // Tri topologique : à chaque tour, la story prête à placer de plus petite
  // étape, la première de `ids` à égalité.
  const settled = (dep: string): boolean => places.has(dep);
  let remaining = ids.filter((id) => !places.has(id));
  for (;;) {
    const available = remaining.filter((id) => waits.get(id)!.every(settled));
    if (available.length === 0) {
      break;
    }
    const stepOf = (id: string): number =>
      Math.max(floors.get(id)!, ...waits.get(id)!.map((d) => (steps.get(d) ?? 0) + 1));
    const next = available.reduce((best, id) => (stepOf(id) < stepOf(best) ? id : best));
    remaining = remaining.filter((id) => id !== next);

    const said = reasons.get(next)!;
    const deps = waits.get(next)!;
    said.push(...deps.map((d) => `attend ${d}`));
    if (deps.some((d) => places.get(d)!.step === null)) {
      places.set(next, { step: null, reasons: said });
      continue;
    }
    const story = ctx.stories.get(next)!;
    let step = stepOf(next);
    for (;;) {
      const clash = [...steps].find(([other, s]) => s === step && commonFiles(story, ctx.stories.get(other)).length > 0);
      if (!clash) {
        break;
      }
      said.push(`après ${clash[0]}, fichiers communs : ${shortList(commonFiles(story, ctx.stories.get(clash[0])))}`);
      step += 1;
    }
    steps.set(next, step);
    places.set(next, { step, reasons: said });
  }

  // Ce qui reste s'attend en boucle, ou attend une story qui s'attend en boucle.
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean =>
    waits.get(from)!.some(
      (d) => d === target || (remaining.includes(d) && !seen.has(d) && reaches(d, target, seen.add(d)))
    );
  for (const id of remaining) {
    const looped = waits.get(id)!.filter((d) => remaining.includes(d) && reaches(d, id));
    places.set(id, {
      step: null,
      reasons: [
        ...reasons.get(id)!,
        ...waits.get(id)!.map((d) => `attend ${d}`),
        looped.length > 0 ? `cycle de dépendances avec ${looped.join(', ')}` : 'attend un cycle de dépendances'
      ]
    });
  }
  return places;
}

function commonFiles(story: SchedulableStory, other: SchedulableStory | undefined): string[] {
  const theirs = other?.files ?? [];
  return story.files.filter((f) => theirs.includes(f));
}

function shortList(files: string[]): string {
  return `${files.slice(0, 3).join(', ')}${files.length > 3 ? '…' : ''}`;
}
