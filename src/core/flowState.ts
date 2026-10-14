/**
 * `state.json` : l'état du flux au-delà de Ready.
 *
 * Les dossiers restent la source de vérité pour New, Ready et Done : une story
 * de `ready/` sans entrée ici est simplement prête. Dès qu'elle part en dev,
 * son parcours (file d'attente, dev, revue, supervision, attente de ton feu
 * vert) est tenu ici, avec ce qu'il faut pour reprendre : branche, worktree,
 * session de l'agent, boucles de correction.
 *
 * L'extension est seule à écrire ce fichier, une écriture à la fois.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { readJson, replaceFile } from '../util/files.js';
import type { CrReview, StepResult } from './supervision.js';

/**
 * Les états d'une story après Ready. `new`, `planning` et `ready` se lisent
 * dans les dossiers et dans `plans/`, sans entrée ici.
 */
export type FlowStatus =
  | 'queued'
  | 'in_dev'
  | 'ai_review'
  | 'pre_pr_check'
  | 'awaiting_human'
  | 'merging'
  | 'done'
  | 'blocked';

/** Les états où un processus tourne pour la story. */
export const RUNNING_STATUSES: readonly FlowStatus[] = ['in_dev', 'ai_review', 'pre_pr_check'];

/** Les états où la story occupe ses fichiers : pas de story parallèle sur les mêmes. */
export const ACTIVE_STATUSES: readonly FlowStatus[] = [
  'in_dev',
  'ai_review',
  'pre_pr_check',
  'awaiting_human',
  'merging',
  'blocked'
];

export type CheckStatus = 'passed' | 'failed' | 'not_run';

/** Une commande de `devbots.dev.checkCommands`, lancée par l'extension après la session. */
export interface CheckRun {
  command: string;
  passed: boolean;
  /** La fin de la sortie, en cas d'échec. */
  output?: string;
}

/** Ce que l'agent de dev déclare à la fin d'une session, d'après sa sortie structurée. */
export interface DevReport {
  status: 'done' | 'blocked';
  summary: string;
  build: CheckStatus;
  tests: CheckStatus;
  testsDetail: string;
  lint: CheckStatus;
  blockedReason: string;
  /** Commit fait par l'extension après la session, absent si rien n'a changé. */
  commit?: string;
  /** Refus du commit par un hook du dépôt : une correction pour l'agent. */
  commitError?: string;
  /** Les checks lancés par l'extension après la session : ils font foi sur le statut déclaré. */
  checks?: CheckRun[];
  permissionDenials: string[];
  at: string;
}

export interface StoryRun {
  storyId: string;
  title: string;
  status: FlowStatus;
  /** Modèle de l'agent de dev, choisi au lancement. */
  model: string;
  /** Branche de la feature, ou la branche de base pour une story sans feature. */
  baseBranch: string;
  branch: string;
  worktree: string;
  devSessionId?: string;
  /** Boucles de correction déjà faites (revue du CR ou supervision). */
  loops: number;
  queuedAt: string;
  startedAt?: string;
  updatedAt: string;
  lastDev?: DevReport;
  /** Pourquoi la story est bloquée, ou en attente dans la file. */
  reason?: string;
  /** Corrections restées en suspens au plafond de boucles, reprises à la relance. */
  pendingCorrections?: string;
  /**
   * Ce que la dernière revue a demandé, pendant une boucle de correction : la
   * revue suivante vérifie ces points sur le diff de la correction, sans tout
   * relire. Effacé à « À valider » et à chaque nouveau travail demandé.
   */
  verification?: Verification;
  /** Coût estimé des sessions depuis le dernier lancement, comparé au budget de la story. */
  costUsd?: number;
  /** Fiches créées par le tri des problèmes. */
  followUps: string[];
  /** Port de l'application lancée pour ta revue, propre au worktree. */
  servePort?: number;
  /** Le merge, une fois fait : la story y occupe `mergeBase..mergeCommit`. */
  mergedAt?: string;
  mergeCommit?: string;
  mergeBase?: string;
}

export interface Verification {
  /** Le commit relu : le diff de la correction part de lui. */
  commit: string;
  /** La dernière revue du CR faite par Claude, absente si elle n'a pas encore tourné. */
  crReview?: CrReview;
  /** Les derniers résultats des étapes de supervision. */
  results: StepResult[];
}

export interface FlowState {
  version: 1;
  stories: Record<string, StoryRun>;
  /**
   * Tes arbitrages sur les dépendances déclarées, par story puis par
   * dépendance : `wait` la respecte même infirmée par le plan, `ignore` la lève
   * même confirmée.
   */
  dependencyOverrides: Record<string, Record<string, 'wait' | 'ignore'>>;
}

export function emptyFlowState(): FlowState {
  return { version: 1, stories: {}, dependencyOverrides: {} };
}

export class FlowStateStore {
  /** Les écritures s'enchaînent : deux mises à jour ne s'écrasent jamais. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  async read(): Promise<FlowState> {
    const parsed = await readJson<Partial<FlowState>>(this.filePath);
    if (!parsed) {
      return emptyFlowState();
    }
    return {
      version: 1,
      stories: parsed.stories ?? {},
      dependencyOverrides: parsed.dependencyOverrides ?? {}
    };
  }

  /**
   * Lit, modifie et réécrit l'état, à la suite des mises à jour en cours.
   * Rend ce que `change` rend.
   */
  update<T>(change: (state: FlowState) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const state = await this.read();
      const result = change(state);
      await this.write(state);
      return result;
    });
    // Une mise à jour en échec ne bloque pas les suivantes.
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Modifie l'entrée d'une story. Sans entrée, la story a quitté le flux : rien n'est fait. */
  patch(storyId: string, change: Partial<StoryRun>): Promise<StoryRun | undefined> {
    return this.update((state) => {
      const run = state.stories[storyId];
      if (!run) {
        return undefined;
      }
      Object.assign(run, change, { updatedAt: new Date().toISOString() });
      return { ...run };
    });
  }

  private async write(state: FlowState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await replaceFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

/** Le libellé d'un état, pour le panneau et les notifications. */
export function statusLabel(status: FlowStatus): string {
  switch (status) {
    case 'queued':
      return "file d'attente";
    case 'in_dev':
      return 'en dev';
    case 'ai_review':
      return 'revue du CR';
    case 'pre_pr_check':
      return 'supervision';
    case 'awaiting_human':
      return 'à valider';
    case 'merging':
      return 'merge';
    case 'done':
      return 'terminée';
    case 'blocked':
      return 'bloquée';
  }
}
