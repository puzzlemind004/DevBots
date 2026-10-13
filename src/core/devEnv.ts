/**
 * L'environnement d'un worktree : installation des dépendances.
 *
 * Chaque worktree a son propre `node_modules`. Avec pnpm, le store est
 * partagé : l'installation est rapide et prend peu de disque.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * La commande d'installation d'un worktree.
 *
 * @param setting Le paramètre `devbots.dev.installCommand` : vide pour
 * détecter d'après le fichier de verrouillage, `none` pour ne rien installer.
 * @returns La commande et ses arguments, ou `undefined` s'il n'y a rien à faire.
 */
export async function installCommand(
  dir: string,
  setting: string
): Promise<string[] | undefined> {
  const configured = setting.trim();
  if (configured.toLowerCase() === 'none') {
    return undefined;
  }
  if (configured) {
    return configured.split(/\s+/);
  }
  if (await exists(path.join(dir, 'pnpm-lock.yaml'))) {
    return ['pnpm', 'install', '--frozen-lockfile'];
  }
  if (await exists(path.join(dir, 'yarn.lock'))) {
    return ['yarn', 'install', '--frozen-lockfile'];
  }
  if (await exists(path.join(dir, 'package-lock.json'))) {
    return ['npm', 'ci'];
  }
  if (await exists(path.join(dir, 'package.json'))) {
    return ['npm', 'install'];
  }
  return undefined;
}

/**
 * Les règles de permission Bash de l'agent de dev, depuis la liste de
 * commandes autorisées : `npm run build` autorise `npm run build` et ses
 * variantes (`npm run build -- --configuration=x`).
 */
export function bashRules(commands: readonly string[]): string[] {
  return commands
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => `Bash(${c}:*)`);
}

/**
 * Refusées dans tous les cas, même si une règle trop large les laissait
 * passer : rien ne sort du poste, rien ne bouge les branches, aucun serveur.
 */
export const DENIED_COMMANDS = [
  'Bash(git push:*)',
  'Bash(git merge:*)',
  'Bash(git rebase:*)',
  'Bash(git checkout:*)',
  'Bash(git switch:*)',
  'Bash(git reset:*)',
  'Bash(git worktree:*)',
  'Bash(git commit:*)',
  'Bash(ng serve:*)',
  'Bash(npx ng serve:*)',
  'Bash(npm start:*)'
];

/** Commandes autorisées par défaut : build, tests sans mode watch, lint, git en lecture. */
export const DEFAULT_ALLOWED_COMMANDS = [
  'npx ng build',
  'npx ng test --watch=false',
  'npm run build',
  'npm test',
  'npm run test',
  'npm run lint',
  'git status',
  'git diff',
  'git log',
  'git show'
];

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
