/**
 * Un faux git en mémoire, pour les tests de l'orchestrateur : branches,
 * worktrees et commits, sans lancer un seul processus.
 *
 * Les worktrees sont de vrais dossiers, où l'agent écrit ses fichiers ; un
 * commit en prend une photo. Le merge (rebase, conflits, fast-forward) n'est
 * pas simulé : ces tests-là tournent sur un vrai dépôt.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FileChange, StoryGit } from '../../src/core/git.js';

interface Commit {
  parent?: string;
  message: string;
  /** Chemin relatif, avec des barres obliques → contenu. */
  files: Map<string, string>;
}

export class FakeGit implements StoryGit {
  private readonly commits = new Map<string, Commit>();
  private readonly branches = new Map<string, string>();
  /** Dossier → branche extraite. */
  private readonly checkouts = new Map<string, string>();
  private readonly excluded: string[] = [];

  constructor(
    private readonly repoRoot: string,
    files: Record<string, string> = {}
  ) {
    this.branches.set('main', this.newCommit({ message: 'init', files: new Map(Object.entries(files)) }));
    this.checkouts.set(path.resolve(repoRoot), 'main');
  }

  /** Les messages des `n` derniers commits de la branche, du plus récent au plus ancien. */
  log(branch: string, n: number): string[] {
    const messages: string[] = [];
    for (let id: string | undefined = this.branches.get(branch); id && messages.length < n; id = this.commit(id).parent) {
      messages.push(this.commit(id).message);
    }
    return messages;
  }

  hasBranch(name: string): boolean {
    return this.branches.has(name);
  }

  /* ------------------------------------------------------------ */

  async currentBranch(): Promise<string> {
    return this.checkouts.get(path.resolve(this.repoRoot))!;
  }

  async branchExists(name: string): Promise<boolean> {
    return this.branches.has(name);
  }

  async checkedOutIn(branch: string): Promise<string | undefined> {
    return [...this.checkouts].find(([, b]) => b === branch)?.[0];
  }

  async ensureBranch(name: string, from: string): Promise<boolean> {
    if (this.branches.has(name)) {
      return false;
    }
    this.branches.set(name, this.resolve(from, this.repoRoot));
    return true;
  }

  async ensureWorktree(dir: string, branch: string, from: string): Promise<'created' | 'reused'> {
    if (this.checkouts.has(path.resolve(dir))) {
      return 'reused';
    }
    await this.ensureBranch(branch, from);
    for (const [file, content] of this.commit(this.branches.get(branch)!).files) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await fs.writeFile(path.join(dir, file), content, 'utf8');
    }
    await fs.mkdir(dir, { recursive: true });
    this.checkouts.set(path.resolve(dir), branch);
    return 'created';
  }

  async exclude(pattern: string): Promise<void> {
    this.excluded.push(pattern.replace(/^\/+/, ''));
  }

  async headCommit(cwd = this.repoRoot): Promise<string> {
    return this.resolve('HEAD', cwd);
  }

  async revParse(ref: string, cwd = this.repoRoot): Promise<string> {
    return this.resolve(ref, cwd);
  }

  async mergeBase(cwd: string, a: string, b: string): Promise<string> {
    const ancestors = new Set(this.ancestry(this.resolve(a, cwd)));
    const common = this.ancestry(this.resolve(b, cwd)).find((id) => ancestors.has(id));
    if (!common) {
      throw new Error(`FakeGit : pas d'ancêtre commun à ${a} et ${b}.`);
    }
    return common;
  }

  async commitAll(cwd: string, message: string): Promise<string | undefined> {
    const branch = this.branchAt(cwd);
    const parent = this.branches.get(branch)!;
    const files = await this.snapshot(cwd);
    if (sameFiles(files, this.commit(parent).files)) {
      return undefined;
    }
    const id = this.newCommit({ parent, message, files });
    this.branches.set(branch, id);
    return id;
  }

  async changedFiles(cwd: string, base: string): Promise<string[]> {
    return (await this.changes(cwd, base)).map((c) => c.path);
  }

  async diffStat(cwd: string, base: string): Promise<string> {
    return (await this.changes(cwd, base)).map((c) => ` ${c.path} | ${c.status}`).join('\n');
  }

  async diff(cwd: string, base: string): Promise<string> {
    const from = this.commit(this.resolve(base, cwd)).files;
    const to = this.commit(this.resolve('HEAD', cwd)).files;
    return (await this.changes(cwd, base))
      .map(({ path: file }) =>
        [
          `diff --git a/${file} b/${file}`,
          ...linesOf(from.get(file)).map((l) => `-${l}`),
          ...linesOf(to.get(file)).map((l) => `+${l}`)
        ].join('\n')
      )
      .join('\n');
  }

  abortInProgress(): Promise<boolean> {
    return notSimulated('abortInProgress');
  }

  isAncestor(): Promise<boolean> {
    return notSimulated('isAncestor');
  }

  integrate(): Promise<string[]> {
    return notSimulated('integrate');
  }

  fastForward(): Promise<void> {
    return notSimulated('fastForward');
  }

  removeWorktree(): Promise<void> {
    return notSimulated('removeWorktree');
  }

  deleteBranch(): Promise<void> {
    return notSimulated('deleteBranch');
  }

  /* ------------------------------------------------------------ */

  private newCommit(commit: Commit): string {
    const id = (this.commits.size + 1).toString(16).padStart(40, '0');
    this.commits.set(id, commit);
    return id;
  }

  private commit(id: string): Commit {
    const commit = this.commits.get(id);
    if (!commit) {
      throw new Error(`FakeGit : commit inconnu ${id}.`);
    }
    return commit;
  }

  private branchAt(cwd: string): string {
    const branch = this.checkouts.get(path.resolve(cwd));
    if (!branch) {
      throw new Error(`FakeGit : ${cwd} n'est pas un worktree.`);
    }
    return branch;
  }

  private resolve(ref: string, cwd: string): string {
    const id = ref === 'HEAD' ? this.branches.get(this.branchAt(cwd))! : (this.branches.get(ref) ?? ref);
    this.commit(id); // Lève si la référence n'existe pas.
    return id;
  }

  /** Le commit et ses ancêtres, du plus récent au plus ancien. */
  private ancestry(id: string): string[] {
    const ids: string[] = [];
    for (let at: string | undefined = id; at; at = this.commit(at).parent) {
      ids.push(at);
    }
    return ids;
  }

  private async changes(cwd: string, base: string): Promise<FileChange[]> {
    const from = this.commit(this.resolve(base, cwd)).files;
    const to = this.commit(this.resolve('HEAD', cwd)).files;
    const result: FileChange[] = [];
    for (const file of [...new Set([...from.keys(), ...to.keys()])].sort()) {
      if (from.get(file) !== to.get(file)) {
        result.push({ status: !from.has(file) ? 'added' : !to.has(file) ? 'deleted' : 'modified', path: file });
      }
    }
    return result;
  }

  /** Les fichiers suivis du worktree : tout, sauf `.git` et les motifs exclus. */
  private async snapshot(dir: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const walk = async (rel: string): Promise<void> => {
      for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
        const file = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.name === '.git' || this.excluded.some((p) => `${file}/`.startsWith(p))) {
          continue;
        }
        if (entry.isDirectory()) {
          await walk(file);
        } else {
          files.set(file, await fs.readFile(path.join(dir, file), 'utf8'));
        }
      }
    };
    await walk('');
    return files;
  }
}

function sameFiles(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([file, content]) => b.get(file) === content);
}

function linesOf(content: string | undefined): string[] {
  return content === undefined ? [] : content.replace(/\n$/, '').split('\n');
}

function notSimulated(name: string): never {
  throw new Error(`FakeGit : ${name} n'est pas simulé, ce test doit tourner sur un vrai dépôt.`);
}
