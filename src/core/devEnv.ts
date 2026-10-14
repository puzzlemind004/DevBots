/**
 * L'environnement d'un worktree : installation des dépendances.
 *
 * Chaque worktree a son propre `node_modules`. Avec pnpm, le store est
 * partagé : l'installation est rapide et prend peu de disque.
 */

import { type Dirent, promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Une installation à lancer : la commande et le dossier où la lancer. */
export interface InstallStep {
  cwd: string;
  command: string[];
}

/** Profondeur de recherche des projets en sous-dossier (`apps/web` : 2). */
const PROJECT_SEARCH_DEPTH = 2;

/** Dossiers où l'on ne cherche jamais de projet. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out']);

/**
 * Les installations d'un worktree.
 *
 * Un projet à la racine suffit : ses workspaces éventuels s'installent avec
 * lui. Sinon, chaque projet trouvé en sous-dossier (`apps/web`,
 * `packages/api`…) a la sienne.
 *
 * @param setting Le paramètre `devbots.dev.installCommand` : vide pour
 * détecter d'après le fichier de verrouillage, `none` pour ne rien installer.
 * Une commande renseignée est lancée à la racine du worktree.
 */
export async function installSteps(dir: string, setting: string): Promise<InstallStep[]> {
  const configured = setting.trim();
  if (configured.toLowerCase() === 'none') {
    return [];
  }
  if (configured) {
    return [{ cwd: dir, command: configured.split(/\s+/) }];
  }
  const root = await detectCommand(dir);
  if (root) {
    return [{ cwd: dir, command: root }];
  }
  return findProjects(dir, PROJECT_SEARCH_DEPTH);
}

async function findProjects(dir: string, depth: number): Promise<InstallStep[]> {
  if (depth === 0) {
    return [];
  }
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const steps: InstallStep[] = [];
  const subdirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIPPED_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();
  for (const name of subdirs) {
    const sub = path.join(dir, name);
    const command = await detectCommand(sub);
    if (command) {
      steps.push({ cwd: sub, command });
    } else {
      steps.push(...(await findProjects(sub, depth - 1)));
    }
  }
  return steps;
}

/** La commande d'installation d'un dossier, d'après son fichier de verrouillage. */
async function detectCommand(dir: string): Promise<string[] | undefined> {
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
