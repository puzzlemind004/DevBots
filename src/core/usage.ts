/**
 * L'usage de l'abonnement Claude : la fenêtre de session (5 h) et la semaine.
 *
 * Chaque appel `claude -p` en `stream-json` émet un `rate_limit_event` qui
 * porte, pour chaque fenêtre, la part consommée et l'heure de réinitialisation,
 * telles que l'API les renvoie dans ses en-têtes. L'extension les relève au
 * passage des agents, sans manipuler le moindre identifiant : ce sont les
 * chiffres de `/usage`, pour tout le compte, pas seulement pour DevBots.
 *
 * Faute d'agent en cours, `probeUsage` fait un appel minimal (haiku, aucun
 * outil, aucune session gardée) pour obtenir un relevé frais.
 */

import * as os from 'node:os';
import { subscriptionEnv } from './claudeCli.js';
import { exec, ExecError } from '../util/exec.js';

export interface UsageWindow {
  /** Part de la fenêtre consommée, de 0 à 1 (au-delà de 1 si le plafond est dépassé). */
  utilization: number;
  /** Réinitialisation de la fenêtre, en ISO. */
  resetsAt: string;
}

export interface UsageSnapshot {
  /** Fenêtre glissante de 5 h : la « session » de `/usage`. */
  session?: UsageWindow;
  /** Fenêtre de 7 jours. */
  week?: UsageWindow;
  /** `rejected` : un plafond est atteint, les appels échouent jusqu'à sa réinitialisation. */
  status: 'allowed' | 'allowed_warning' | 'rejected';
  /** Heure du relevé, en ISO. */
  at: string;
}

/**
 * Lit une ligne de `stream-json`. Rend un relevé pour un `rate_limit_event`
 * qui porte au moins une fenêtre, `undefined` pour tout le reste.
 */
export function parseRateLimitLine(line: string, now = new Date()): UsageSnapshot | undefined {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (event.type !== 'rate_limit_event') {
    return undefined;
  }
  const info = (event.rate_limit_info ?? {}) as Record<string, unknown>;
  const windows = (info.unifiedWindows ?? {}) as Record<string, unknown>;
  let session = readWindow(windows.five_hour);
  let week = readWindow(windows.seven_day);
  // Sans le détail par fenêtre, l'événement ne parle que de la fenêtre la plus contraignante.
  const top = readWindow({ utilization: info.utilization, resetsAt: info.resetsAt });
  if (top && info.rateLimitType === 'five_hour') {
    session ??= top;
  } else if (top && info.rateLimitType === 'seven_day') {
    week ??= top;
  }
  if (!session && !week) {
    return undefined;
  }
  const status =
    info.status === 'rejected' || info.status === 'allowed_warning' ? info.status : 'allowed';
  return { session, week, status, at: now.toISOString() };
}

/**
 * Le relevé le plus récent, complété par le précédent : un événement qui ne
 * donne qu'une fenêtre ne fait pas oublier l'autre, tant qu'elle court.
 */
export function mergeSnapshots(
  previous: UsageSnapshot | undefined,
  next: UsageSnapshot,
  now = new Date()
): UsageSnapshot {
  const keep = (w: UsageWindow | undefined): UsageWindow | undefined =>
    w && new Date(w.resetsAt).getTime() > now.getTime() ? w : undefined;
  return {
    ...next,
    session: next.session ?? keep(previous?.session),
    week: next.week ?? keep(previous?.week)
  };
}

/** Ce que le panneau affiche d'une fenêtre. */
export interface WindowView {
  /** Pourcentage entier consommé ; 0 une fois la fenêtre réinitialisée. */
  percent: number;
  /** Vrai quand l'heure de réinitialisation est passée depuis le relevé. */
  elapsed: boolean;
  /** « à 15:30 », « demain à 09:00 », « ven. 17 oct. à 14:00 ». */
  resetLabel: string;
  /** « dans 2 h 05 », « dans 3 j ». */
  resetIn: string;
}

export function windowView(window: UsageWindow, now = new Date()): WindowView {
  const reset = new Date(window.resetsAt);
  const elapsed = reset.getTime() <= now.getTime();
  return {
    percent: elapsed ? 0 : Math.round(window.utilization * 100),
    elapsed,
    resetLabel: dayLabel(reset, now),
    resetIn: elapsed ? 'passée' : `dans ${duration(reset.getTime() - now.getTime())}`
  };
}

/** « il y a 3 min », « il y a 2 h ». */
export function ageLabel(at: string, now = new Date()): string {
  const ms = now.getTime() - new Date(at).getTime();
  return ms < 60_000 ? "à l'instant" : `il y a ${duration(ms)}`;
}

/**
 * Les arguments du relevé à la demande : haiku, aucun outil, un seul tour,
 * aucune session gardée sur disque. Le prompt passe par l'entrée standard.
 */
export function probeArgs(): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    'haiku',
    '--tools',
    '',
    '--max-turns',
    '1',
    '--no-session-persistence'
  ];
}

/**
 * Un relevé frais, au prix d'un appel minimal. Lancé hors du dépôt, pour ne
 * pas charger son `CLAUDE.md`.
 */
export async function probeUsage(executable: string, signal?: AbortSignal): Promise<UsageSnapshot> {
  let stdout: string;
  try {
    ({ stdout } = await exec(executable, probeArgs(), {
      cwd: os.tmpdir(),
      env: subscriptionEnv(process.env),
      input: 'Réponds seulement : ok',
      timeoutMs: 90_000,
      signal
    }));
  } catch (err) {
    // Un plafond atteint fait échouer l'appel, mais l'événement est déjà écrit.
    if (!(err instanceof ExecError)) {
      throw err;
    }
    stdout = err.result.stdout;
    if (!stdout.includes('rate_limit_event')) {
      throw new Error(`Relevé de l'usage impossible : ${err.message}`);
    }
  }
  let snapshot: UsageSnapshot | undefined;
  for (const line of stdout.split('\n')) {
    const found = parseRateLimitLine(line.trim());
    if (found) {
      snapshot = mergeSnapshots(snapshot, found);
    }
  }
  if (!snapshot) {
    throw new Error(
      "Claude Code n'a pas donné l'usage de l'abonnement. Une connexion par clé d'API n'a ni session ni semaine à relever."
    );
  }
  return snapshot;
}

function readWindow(value: unknown): UsageWindow | undefined {
  const w = (value ?? {}) as { utilization?: unknown; resetsAt?: unknown };
  if (typeof w.utilization !== 'number' || typeof w.resetsAt !== 'number' || !Number.isFinite(w.resetsAt)) {
    return undefined;
  }
  // `resetsAt` est en secondes depuis l'époque Unix.
  return { utilization: w.utilization, resetsAt: new Date(w.resetsAt * 1000).toISOString() };
}

function dayLabel(date: Date, now: Date): string {
  const time = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
  if (days === 0) {
    return `à ${time}`;
  }
  if (days === 1) {
    return `demain à ${time}`;
  }
  const day = date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day} à ${time}`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** « 2 h 05 », « 12 min », « 3 j 4 h ». */
function duration(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ${String(minutes % 60).padStart(2, '0')}`;
  }
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} j ${hours % 24} h` : `${days} j`;
}
