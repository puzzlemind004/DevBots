/**
 * Les opérations git de l'orchestrateur : branches, worktrees, commits, diff.
 *
 * Tout passe par `git` lancé sans shell : un nom de branche tiré d'un titre de
 * ticket ne peut rien injecter. Les noms eux-mêmes sont réduits à
 * `[A-Za-z0-9._/-]` avant d'arriver ici.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { exec, ExecError } from '../util/exec.js';
import { slugify } from './storyCard.js';

/** Dossier propre à DevBots dans chaque worktree, exclu de git. */
export const DEVBOTS_DIR = '.devbots';

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

/** Un identifiant de story utilisable dans un nom de branche ou de dossier. */
export function refSafeId(id: string): string {
  return id.replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/** `feature/30-inscription-par-email`. */
export function featureBranchName(featureId: string, title: string): string {
  return `feature/${refSafeId(featureId)}-${slugify(title, 40)}`;
}

/** `story/42-valider-l-email`. */
export function storyBranchName(storyId: string, title: string): string {
  return `story/${refSafeId(storyId)}-${slugify(title, 40)}`;
}

/** Le dossier du worktree d'une story, sous la racine des worktrees. */
export function worktreeDir(root: string, storyId: string, title: string): string {
  return path.join(root, `${refSafeId(storyId)}-${slugify(title, 30)}`);
}

/** La racine par défaut : un dossier voisin du dépôt, `<dépôt>.worktrees`. */
export function defaultWorktreeRoot(repoRoot: string): string {
  return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}.worktrees`);
}

export class Git {
  constructor(private readonly repoRoot: string) {}

  /** Lance git dans `cwd` (le dépôt par défaut) et rend sa sortie. */
  async run(args: string[], cwd = this.repoRoot): Promise<string> {
    try {
      return (await exec('git', args, { cwd })).stdout;
    } catch (err) {
      if (err instanceof ExecError) {
        throw new GitError(`git ${args[0]} : ${err.result.stderr || err.message}`);
      }
      throw err;
    }
  }

  /** Vrai si la commande réussit. Pour les questions dont la réponse est le code de sortie. */
  private async succeeds(args: string[], cwd = this.repoRoot): Promise<boolean> {
    try {
      await exec('git', args, { cwd });
      return true;
    } catch (err) {
      if (err instanceof ExecError) {
        return false;
      }
      throw err;
    }
  }

  currentBranch(): Promise<string> {
    return this.run(['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  branchExists(name: string): Promise<boolean> {
    return this.succeeds(['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
  }

  /** Crée la branche depuis `from` si elle n'existe pas. Rend vrai si elle a été créée. */
  async ensureBranch(name: string, from: string): Promise<boolean> {
    if (await this.branchExists(name)) {
      return false;
    }
    await this.run(['branch', name, from]);
    return true;
  }

  /**
   * Le worktree de la story, créé avec sa branche au besoin.
   *
   * Un worktree déjà présent est réutilisé tel quel : une relance après un
   * arrêt reprend le travail en cours au lieu de l'écraser.
   */
  async ensureWorktree(dir: string, branch: string, from: string): Promise<'created' | 'reused'> {
    if (await isDirectory(dir)) {
      if (!(await this.succeeds(['rev-parse', '--is-inside-work-tree'], dir))) {
        throw new GitError(`${dir} existe mais n'est pas un worktree git.`);
      }
      return 'reused';
    }
    await fs.mkdir(path.dirname(dir), { recursive: true });
    if (await this.branchExists(branch)) {
      await this.run(['worktree', 'add', dir, branch]);
    } else {
      await this.run(['worktree', 'add', '-b', branch, dir, from]);
    }
    return 'created';
  }

  headCommit(cwd = this.repoRoot): Promise<string> {
    return this.run(['rev-parse', 'HEAD'], cwd);
  }

  /**
   * Ajoute un motif à `info/exclude` du dépôt, partagé par tous ses worktrees.
   * Rien n'est écrit dans le `.gitignore` versionné.
   */
  async exclude(pattern: string): Promise<void> {
    const commonDir = path.resolve(this.repoRoot, await this.run(['rev-parse', '--git-common-dir']));
    const file = path.join(commonDir, 'info', 'exclude');
    let content = '';
    try {
      content = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
    if (content.split(/\r?\n/).includes(pattern)) {
      return;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    const sep = content === '' || content.endsWith('\n') ? '' : '\n';
    await fs.appendFile(file, `${sep}${pattern}\n`, 'utf8');
  }

  /**
   * Commite tout ce qui a changé dans le worktree. Rend le commit, ou
   * `undefined` quand il n'y avait rien à commiter.
   */
  async commitAll(cwd: string, message: string): Promise<string | undefined> {
    await this.run(['add', '--all'], cwd);
    if (await this.succeeds(['diff', '--cached', '--quiet'], cwd)) {
      return undefined;
    }
    await this.run(['commit', '--quiet', '-m', message], cwd);
    return this.headCommit(cwd);
  }

  /** Les fichiers modifiés depuis `base`, commits du worktree compris. */
  async changedFiles(cwd: string, base: string): Promise<string[]> {
    const out = await this.run(['diff', '--name-only', base, 'HEAD'], cwd);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  diffStat(cwd: string, base: string): Promise<string> {
    return this.run(['diff', '--stat', base, 'HEAD'], cwd);
  }

  diff(cwd: string, base: string): Promise<string> {
    return this.run(['diff', base, 'HEAD'], cwd);
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
