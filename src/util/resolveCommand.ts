/**
 * Résolution d'une commande avant son lancement sans shell.
 *
 * Sous Windows, `spawn` sans shell ne trouve que les `.exe` et `.com` : une
 * installation npm de Claude Code n'expose qu'un `claude.cmd`, et Node refuse
 * de lancer un `.cmd` sans shell. Plutôt que de passer par `cmd.exe`, qui
 * réinterpréterait les arguments, on lit le lanceur npm pour y trouver le
 * `.exe` qu'il appelle.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const DIRECT_EXTENSIONS = ['.exe', '.com'];
const SHIM_EXTENSIONS = ['.cmd', '.bat'];

/**
 * Rend un chemin lançable par `spawn` sans shell, ou la commande telle quelle
 * quand rien de mieux n'est trouvé (hors Windows, toujours).
 */
export async function resolveCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  if (platform !== 'win32') {
    return command;
  }
  for (const candidate of candidatePaths(command, env)) {
    const ext = path.extname(candidate).toLowerCase();
    if (!(await isFile(candidate))) {
      continue;
    }
    if (DIRECT_EXTENSIONS.includes(ext)) {
      return candidate;
    }
    if (SHIM_EXTENSIONS.includes(ext)) {
      const target = shimTarget(await fs.readFile(candidate, 'utf8'), path.dirname(candidate));
      if (target && (await isFile(target))) {
        return target;
      }
    }
  }
  return command;
}

/** Les chemins à essayer, dans l'ordre de recherche de Windows. */
function candidatePaths(command: string, env: NodeJS.ProcessEnv): string[] {
  const hasDir = command.includes('/') || command.includes('\\');
  const ext = path.extname(command).toLowerCase();
  const extensions = ext ? [''] : [...DIRECT_EXTENSIONS, ...SHIM_EXTENSIONS];
  const dirs = hasDir ? [''] : (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  return dirs.flatMap((dir) => extensions.map((e) => path.join(dir, command + e)));
}

/**
 * Le `.exe` appelé par un lanceur npm (`cmd-shim`), s'il en appelle un.
 *
 * La ligne utile ressemble à `"%dp0%\node_modules\...\claude.exe"   %*`.
 * Un lanceur qui passe par `node` n'a pas d'exécutable natif : il est ignoré.
 */
export function shimTarget(content: string, shimDir: string): string | undefined {
  const match = /"%~?dp0%?\\([^"]+\.exe)"/i.exec(content);
  if (!match?.[1] || /(^|\\)node\.exe$/i.test(match[1])) {
    return undefined;
  }
  return path.win32.join(shimDir, match[1]);
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}
