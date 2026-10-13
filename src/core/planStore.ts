/**
 * Le dossier d'une planification : `.work/plans/<id>/`.
 *
 * Tout ce qu'il faut pour reprendre le lendemain y est rangé : l'état de
 * l'atelier (`session.json`), chaque version du plan en JSON et en markdown
 * (`v<n>.json`, `v<n>.md`) et l'historique des échanges (`history.jsonl`).
 * La mémoire de la planification vit ici, pas dans une conversation.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Answers, PlanSection, StoryPlan, Understanding } from './plan.js';
import { renderPlanMarkdown } from './planRender.js';

export type PlanningPhase = 'understanding' | 'planning' | 'validated';

export interface PlanVersion {
  version: number;
  createdAt: string;
  /** Pourquoi cette version existe : premier jet, ou section reprise. */
  reason: string;
}

export interface PlanningState {
  storyId: string;
  title: string;
  /** Session Claude Code de l'atelier, reprise par `--resume`. */
  sessionId?: string;
  phase: PlanningPhase;
  understanding?: Understanding;
  answers: Answers;
  versions: PlanVersion[];
  /** Sections cochées par toi lors de la revue de fond. Remises à zéro quand la section change. */
  reviewed: Partial<Record<PlanSection, boolean>>;
  /** Nombre de reprises de la session, plafonné. */
  resumes: number;
  updatedAt: string;
}

export interface HistoryEntry {
  at: string;
  who: 'toi' | 'claude' | 'devbots';
  kind: string;
  text: string;
}

export class PlanStore {
  constructor(private readonly plansRoot: string) {}

  /** Dossier d'une story. L'identifiant est assaini : il vient de la source. */
  dir(storyId: string): string {
    return path.join(this.plansRoot, safeId(storyId));
  }

  async load(storyId: string): Promise<PlanningState | undefined> {
    try {
      const raw = await fs.readFile(path.join(this.dir(storyId), 'session.json'), 'utf8');
      return JSON.parse(raw) as PlanningState;
    } catch (err) {
      if (isMissing(err)) {
        return undefined;
      }
      throw err;
    }
  }

  async save(state: PlanningState): Promise<void> {
    const dir = this.dir(state.storyId);
    await fs.mkdir(dir, { recursive: true });
    state.updatedAt = new Date().toISOString();
    // Écriture puis renommage : un arrêt brutal ne laisse pas un état à moitié écrit.
    const target = path.join(dir, 'session.json');
    await fs.writeFile(`${target}.tmp`, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(`${target}.tmp`, target);
  }

  /** Enregistre une nouvelle version et rend son numéro. */
  async addVersion(state: PlanningState, plan: StoryPlan, reason: string): Promise<number> {
    const version = (state.versions.at(-1)?.version ?? 0) + 1;
    const dir = this.dir(state.storyId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.versionPath(state.storyId, version, 'json'), JSON.stringify(plan, null, 2), 'utf8');
    await fs.writeFile(
      this.versionPath(state.storyId, version, 'md'),
      renderPlanMarkdown(plan, state.title, version),
      'utf8'
    );
    state.versions.push({ version, createdAt: new Date().toISOString(), reason });
    return version;
  }

  async readVersion(storyId: string, version: number): Promise<StoryPlan> {
    const raw = await fs.readFile(this.versionPath(storyId, version, 'json'), 'utf8');
    return JSON.parse(raw) as StoryPlan;
  }

  versionPath(storyId: string, version: number, ext: 'json' | 'md'): string {
    return path.join(this.dir(storyId), `v${version}.${ext}`);
  }

  async appendHistory(storyId: string, entry: Omit<HistoryEntry, 'at'>): Promise<void> {
    const dir = this.dir(storyId);
    await fs.mkdir(dir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    await fs.appendFile(path.join(dir, 'history.jsonl'), `${line}\n`, 'utf8');
  }

  async readHistory(storyId: string): Promise<HistoryEntry[]> {
    try {
      const raw = await fs.readFile(path.join(this.dir(storyId), 'history.jsonl'), 'utf8');
      return raw
        .split('\n')
        .filter((l) => l.trim())
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as HistoryEntry];
          } catch {
            // Une ligne tronquée par un arrêt brutal ne doit pas masquer les autres.
            return [];
          }
        });
    } catch (err) {
      if (isMissing(err)) {
        return [];
      }
      throw err;
    }
  }

  /** Les stories dont une planification est en cours, avec leur phase. */
  async listPhases(): Promise<Map<string, PlanningPhase>> {
    const phases = new Map<string, PlanningPhase>();
    let names: string[];
    try {
      names = await fs.readdir(this.plansRoot);
    } catch (err) {
      if (isMissing(err)) {
        return phases;
      }
      throw err;
    }
    for (const name of names) {
      try {
        const raw = await fs.readFile(path.join(this.plansRoot, name, 'session.json'), 'utf8');
        const state = JSON.parse(raw) as PlanningState;
        phases.set(state.storyId, state.phase);
      } catch {
        // Dossier sans état lisible : ignoré.
      }
    }
    return phases;
  }
}

export function newPlanningState(storyId: string, title: string): PlanningState {
  return {
    storyId,
    title,
    phase: 'understanding',
    answers: {},
    versions: [],
    reviewed: {},
    resumes: 0,
    updatedAt: new Date().toISOString()
  };
}

/** `LOCAL-3` reste `LOCAL-3` ; un séparateur de chemin ou `..` ne passe pas. */
export function safeId(storyId: string): string {
  const cleaned = storyId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return cleaned || '_';
}

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
