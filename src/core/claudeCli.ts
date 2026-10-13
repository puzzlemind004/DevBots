/**
 * Vérification du CLI Claude Code, et appels non interactifs (`claude -p`).
 *
 * L'extension lance le `claude` installé sur le poste et n'appelle jamais l'API :
 * elle ne manipule aucun identifiant. La seule chose à vérifier au démarrage est
 * donc que le CLI est présent et dans une version connue.
 */

import { exec, ExecError } from '../util/exec.js';

/**
 * Version minimale vérifiée au démarrage.
 *
 * L'atelier de planification repose sur `--output-format json`, `--resume` et
 * `--json-schema`, éprouvés avec la 2.1.296. La borne exacte d'apparition de
 * `--json-schema` n'est pas vérifiée : à relever si une version plus ancienne
 * échoue.
 */
export const MIN_CLAUDE_VERSION = '2.0.0';

export interface ClaudeStatus {
  installed: boolean;
  version?: string;
  versionOk: boolean;
  /** Message à montrer tel quel quand quelque chose manque. */
  problem?: string;
}

export async function checkClaude(executable: string): Promise<ClaudeStatus> {
  let raw: string;
  try {
    const result = await exec(executable, ['--version'], { timeoutMs: 15_000 });
    raw = result.stdout;
  } catch (err) {
    const detail = err instanceof ExecError ? err.message : String(err);
    return {
      installed: false,
      versionOk: false,
      problem: `Claude Code est introuvable (« ${executable} »). Installe-le, ou corrige le paramètre devbots.claude.executable. Détail : ${detail}`
    };
  }

  const version = parseVersion(raw);
  if (!version) {
    return {
      installed: true,
      versionOk: false,
      problem: `La version de Claude Code n'a pas pu être lue dans « ${raw} ».`
    };
  }

  if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
    return {
      installed: true,
      version,
      versionOk: false,
      problem: `Claude Code ${version} est trop ancien : version ${MIN_CLAUDE_VERSION} au minimum.`
    };
  }

  return { installed: true, version, versionOk: true };
}

/** `2.1.296 (Claude Code)` donne `2.1.296`. */
export function parseVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

/** Compare deux versions sémantiques. Négatif si `a` est antérieur à `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* Appels non interactifs : `claude -p`                                */
/* ------------------------------------------------------------------ */

/** Un appel à Claude dont la réponse suit un schéma JSON imposé. */
export interface ClaudeRequest {
  prompt: string;
  /** Dossier de travail : la racine du dépôt, pour que les skills et le CLAUDE.md soient chargés. */
  cwd: string;
  schema: object;
  model?: string;
  /** Session à reprendre. Absente : session neuve, l'équivalent d'un /clear. */
  resume?: string;
  /** Outils disponibles. Une liste vide n'en laisse aucun. */
  tools: readonly string[];
  appendSystemPrompt?: string;
  signal?: AbortSignal;
}

export interface ClaudeResponse {
  sessionId: string;
  /** Le `structured_output` du CLI, à valider par l'appelant. */
  output: unknown;
  costUsd?: number;
}

export type ClaudeRunner = (request: ClaudeRequest) => Promise<ClaudeResponse>;

export class ClaudeError extends Error {
  constructor(
    message: string,
    readonly cancelled = false
  ) {
    super(message);
    this.name = 'ClaudeError';
  }
}

/**
 * Les arguments de `claude` pour une requête.
 *
 * Le prompt passe par l'entrée standard : ni limite de longueur de ligne de
 * commande sous Windows, ni risque qu'une option à valeurs multiples l'avale.
 * `--bare` n'est jamais utilisé : il contourne la connexion par abonnement.
 */
export function buildClaudeArgs(request: ClaudeRequest): string[] {
  const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(request.schema)];
  if (request.model) {
    args.push('--model', request.model);
  }
  if (request.resume) {
    args.push('--resume', request.resume);
  }
  args.push('--tools', request.tools.join(','));
  if (request.tools.length > 0) {
    args.push('--allowedTools', request.tools.join(','));
  }
  if (request.appendSystemPrompt) {
    args.push('--append-system-prompt', request.appendSystemPrompt);
  }
  return args;
}

/** Lit la sortie `--output-format json` du CLI. */
export function parseClaudeResult(stdout: string): ClaudeResponse {
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(lastJsonLine(stdout)) as Record<string, unknown>;
  } catch {
    throw new ClaudeError(`Réponse illisible de Claude Code : ${truncate(stdout, 300)}`);
  }
  if (result.is_error === true || (result.subtype && result.subtype !== 'success')) {
    const detail = typeof result.result === 'string' && result.result ? result.result : String(result.subtype);
    throw new ClaudeError(`Claude Code a échoué : ${truncate(detail, 500)}`);
  }
  if (typeof result.session_id !== 'string') {
    throw new ClaudeError('Réponse de Claude Code sans identifiant de session.');
  }
  if (result.structured_output === undefined || result.structured_output === null) {
    throw new ClaudeError("Claude Code n'a pas renvoyé de réponse structurée.");
  }
  return {
    sessionId: result.session_id,
    output: result.structured_output,
    costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined
  };
}

export function createClaudeRunner(executable: string): ClaudeRunner {
  return async (request) => {
    try {
      const { stdout } = await exec(executable, buildClaudeArgs(request), {
        cwd: request.cwd,
        input: request.prompt,
        signal: request.signal
      });
      return parseClaudeResult(stdout);
    } catch (err) {
      if (err instanceof ClaudeError) {
        throw err;
      }
      if (err instanceof ExecError) {
        if (err.cancelled) {
          throw new ClaudeError('Appel à Claude annulé.', true);
        }
        // En échec, le CLI écrit souvent tout de même son JSON de résultat.
        if (err.result.stdout.trim().startsWith('{')) {
          return parseClaudeResult(err.result.stdout);
        }
        throw new ClaudeError(err.message);
      }
      throw err;
    }
  };
}

/** Le CLI peut écrire des avertissements avant le JSON : seule la dernière ligne compte. */
function lastJsonLine(stdout: string): string {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? '';
    if (line.startsWith('{')) {
      return line;
    }
  }
  return stdout.trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
