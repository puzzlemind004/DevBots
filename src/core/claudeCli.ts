/**
 * Vérification du CLI Claude Code.
 *
 * L'extension lance le `claude` installé sur le poste et n'appelle jamais l'API :
 * elle ne manipule aucun identifiant. La seule chose à vérifier au démarrage est
 * donc que le CLI est présent et dans une version connue.
 */

import { exec, ExecError } from '../util/exec.js';

/**
 * Version minimale retenue pour la phase 1.
 *
 * Le dev des phases suivantes repose sur `--output-format stream-json`,
 * `--resume` et `--json-schema` : la borne sera relevée quand ces options
 * seront réellement utilisées.
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
