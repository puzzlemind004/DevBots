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

export interface FileChange {
  status: 'added' | 'modified' | 'deleted';
  /** Relatif au dépôt, avec des barres obliques. */
  path: string;
}

/** Ce dont l'orchestrateur se sert : de quoi lui donner un faux git en test. */
export type StoryGit = Pick<
  Git,
  | 'currentBranch'
  | 'ensureBranch'
  | 'ensureWorktree'
  | 'exclude'
  | 'headCommit'
  | 'revParse'
  | 'mergeBase'
  | 'commitAll'
  | 'changedFiles'
  | 'diffStat'
  | 'diff'
  | 'abortInProgress'
  | 'isAncestor'
  | 'integrate'
  | 'fastForward'
  | 'removeWorktree'
  | 'deleteBranch'
>;

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
    return this.revParse('HEAD', cwd);
  }

  /** Le commit que désigne `ref`. */
  revParse(ref: string, cwd = this.repoRoot): Promise<string> {
    return this.run(['rev-parse', ref], cwd);
  }

  /** Le dernier ancêtre commun de `a` et `b`. */
  mergeBase(cwd: string, a: string, b: string): Promise<string> {
    return this.run(['merge-base', a, b], cwd);
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
   *
   * Pendant l'intégration de la branche de feature (un merge en cours), le
   * commit conclut le merge, mais pas tant qu'un fichier en conflit garde ses
   * marqueurs.
   */
  async commitAll(cwd: string, message: string): Promise<string | undefined> {
    const merging = await this.mergeInProgress(cwd);
    if (merging) {
      const left = await filesWithMarkers(cwd, await this.conflictedFiles(cwd));
      if (left.length > 0) {
        throw new GitError(`marqueurs de conflit restants dans ${left.join(', ')}`);
      }
    }
    await this.run(['add', '--all'], cwd);
    if (!merging && (await this.succeeds(['diff', '--cached', '--quiet'], cwd))) {
      return undefined;
    }
    await this.run(['commit', '--quiet', '-m', message], cwd);
    return this.headCommit(cwd);
  }

  /** Vrai si `ancestor` est déjà contenu dans `ref`. */
  isAncestor(ancestor: string, ref: string, cwd = this.repoRoot): Promise<boolean> {
    return this.succeeds(['merge-base', '--is-ancestor', ancestor, ref], cwd);
  }

  mergeInProgress(cwd: string): Promise<boolean> {
    return this.succeeds(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], cwd);
  }

  /** Les fichiers en conflit, pas encore marqués comme résolus. */
  async conflictedFiles(cwd: string): Promise<string[]> {
    return lines(await this.run(['diff', '--name-only', '--diff-filter=U'], cwd));
  }

  /**
   * Annule un rebase ou un merge laissé en plan, par un arrêt brutal par
   * exemple. Rend vrai s'il y en avait un.
   */
  async abortInProgress(cwd: string): Promise<boolean> {
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      const p = path.resolve(cwd, await this.run(['rev-parse', '--git-path', dir], cwd));
      if (await isDirectory(p)) {
        await this.run(['rebase', '--abort'], cwd);
        return true;
      }
    }
    if (await this.mergeInProgress(cwd)) {
      await this.run(['merge', '--abort'], cwd);
      return true;
    }
    return false;
  }

  /**
   * Intègre `base` dans la branche du worktree : rebase si l'historique est
   * linéaire, merge s'il contient déjà un merge (un rebase le déferait et
   * rejouerait les conflits déjà résolus).
   *
   * En cas de conflit, le rebase est annulé et remplacé par un merge laissé
   * en cours, conflits compris : l'agent de dev les résout dans les fichiers,
   * et le commit suivant conclut le merge. Rend les fichiers en conflit, vide
   * si l'intégration a réussi.
   */
  async integrate(cwd: string, base: string): Promise<string[]> {
    const merges = await this.run(['rev-list', '--merges', `${base}..HEAD`], cwd);
    if (merges === '') {
      try {
        await this.run(['rebase', '--quiet', base], cwd);
        return [];
      } catch (err) {
        if (!(err instanceof GitError)) {
          throw err;
        }
        await this.abortInProgress(cwd);
      }
    }
    try {
      await this.run(['merge', '--no-ff', '--no-commit', base], cwd);
    } catch (err) {
      if (!(err instanceof GitError)) {
        throw err;
      }
    }
    const conflicts = await this.conflictedFiles(cwd);
    if (conflicts.length === 0 && (await this.mergeInProgress(cwd))) {
      // Le merge passe là où le rebase, commit par commit, butait.
      await this.run(['commit', '--quiet', '--no-edit'], cwd);
    }
    return conflicts;
  }

  /** Le dossier où la branche est extraite (le dépôt ou un worktree), s'il y en a un. */
  async checkedOutIn(branch: string): Promise<string | undefined> {
    const out = await this.run(['worktree', 'list', '--porcelain']);
    let dir: string | undefined;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        dir = line.slice('worktree '.length).trim();
      } else if (line.trim() === `branch refs/heads/${branch}` && dir) {
        return path.resolve(dir);
      }
    }
    return undefined;
  }

  /**
   * Avance `branch` jusqu'à `commit`, en fast-forward seulement. Extraite
   * quelque part, la branche avance par un merge `--ff-only` dans ce dossier,
   * qui refuse d'écraser des modifications en cours ; sinon, la référence est
   * déplacée, à condition de ne pas avoir bougé entre-temps.
   */
  async fastForward(branch: string, commit: string): Promise<void> {
    const dir = await this.checkedOutIn(branch);
    if (dir) {
      await this.run(['merge', '--ff-only', '--quiet', commit], dir);
      return;
    }
    const current = await this.run(['rev-parse', `refs/heads/${branch}`]);
    if (!(await this.isAncestor(current, commit))) {
      throw new GitError(`${branch} a avancé : elle n'est plus contenue dans ${commit.slice(0, 8)}.`);
    }
    await this.run(['update-ref', `refs/heads/${branch}`, commit, current]);
  }

  /** Supprime un worktree, fichiers ignorés (`node_modules`, `.devbots/`) compris. */
  async removeWorktree(dir: string): Promise<void> {
    await this.run(['worktree', 'remove', '--force', dir]);
  }

  async deleteBranch(name: string): Promise<void> {
    await this.run(['branch', '-D', name]);
  }

  /**
   * Les fichiers modifiés entre `from` et `to`, ou jusqu'à l'arbre de travail
   * de `cwd` sans `to`. Un renommage compte comme une suppression et un ajout.
   */
  async changes(cwd: string, from: string, to?: string): Promise<FileChange[]> {
    const out = await this.run(['diff', '--name-status', '--no-renames', '-z', from, ...(to ? [to] : [])], cwd);
    const parts = out.split('\0').map((p) => p.trim()).filter(Boolean);
    const result: FileChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]!.charAt(0);
      result.push({
        status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified',
        path: parts[i + 1]!
      });
    }
    return result;
  }

  /** Le contenu d'un fichier à une révision, vide s'il n'y existe pas. */
  async show(cwd: string, ref: string, file: string): Promise<string> {
    try {
      return (await exec('git', ['show', `${ref}:${file}`], { cwd, raw: true })).stdout;
    } catch (err) {
      if (err instanceof ExecError) {
        return '';
      }
      throw err;
    }
  }

  /** Les fichiers modifiés depuis `base`, commits du worktree compris. */
  async changedFiles(cwd: string, base: string): Promise<string[]> {
    return lines(await this.run(['diff', '--name-only', base, 'HEAD'], cwd));
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

function lines(out: string): string[] {
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Parmi ces fichiers, ceux qui gardent des marqueurs de conflit. */
async function filesWithMarkers(cwd: string, files: string[]): Promise<string[]> {
  const left: string[] = [];
  for (const file of files) {
    try {
      if (/^(<{7}|>{7})( |$)/m.test(await fs.readFile(path.join(cwd, file), 'utf8'))) {
        left.push(file);
      }
    } catch {
      // Supprimé par l'agent : plus de marqueur.
    }
  }
  return left;
}
