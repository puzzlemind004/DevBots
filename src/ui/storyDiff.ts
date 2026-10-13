/**
 * Le diff d'une story dans la vue native de VS Code, fichier par fichier.
 *
 * À valider : la branche de la story contre celle de sa feature, depuis leur
 * point de départ commun. Le côté droit est le fichier du worktree lui-même :
 * tu peux y retoucher le code pendant ta revue. Une story mergée montre ce
 * que son merge a apporté, entre deux commits.
 *
 * Le côté gauche est servi par un fournisseur de contenu qui lit `git show`.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { StoryRun } from '../core/flowState.js';
import { Git } from '../core/git.js';

export const GIT_SCHEME = 'devbots-git';

/** Le contenu d'un fichier à une révision : `devbots-git:/src/a.ts?{"cwd":…,"ref":…}`. */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { cwd, ref } = JSON.parse(uri.query) as { cwd: string; ref: string };
    // Sans révision : le côté vide d'un fichier ajouté ou supprimé.
    if (!ref) {
      return '';
    }
    return new Git(cwd).show(cwd, ref, uri.path.replace(/^\//, ''));
  }
}

function gitUri(cwd: string, ref: string, file: string): vscode.Uri {
  return vscode.Uri.from({ scheme: GIT_SCHEME, path: `/${file}`, query: JSON.stringify({ cwd, ref }) });
}

/** Ouvre le diff de la story. Rend faux, avec un message, quand il n'y a rien à montrer. */
export async function openStoryDiff(run: StoryRun, repoRoot: string): Promise<boolean> {
  let cwd: string;
  let from: string;
  let to: string | undefined;
  if (run.status === 'done') {
    if (!run.mergeBase || !run.mergeCommit) {
      vscode.window.showInformationMessage(`${run.storyId} a été mergée sans que DevBots garde ses commits.`);
      return false;
    }
    cwd = repoRoot;
    from = run.mergeBase;
    to = run.mergeCommit;
  } else {
    if (!run.worktree || !(await isDirectory(run.worktree))) {
      vscode.window.showInformationMessage(`Le worktree de ${run.storyId} n'existe pas (encore).`);
      return false;
    }
    cwd = run.worktree;
    from = await new Git(cwd).run(['merge-base', run.baseBranch, 'HEAD'], cwd);
  }

  const changes = await new Git(cwd).changes(cwd, from, to);
  if (changes.length === 0) {
    vscode.window.showInformationMessage(`Aucun changement dans ${run.storyId}.`);
    return false;
  }
  const resources = changes.map((change) => {
    const left = change.status === 'added' ? gitUri(cwd, '', change.path) : gitUri(cwd, from, change.path);
    const right =
      change.status === 'deleted'
        ? gitUri(cwd, '', change.path)
        : to
          ? gitUri(cwd, to, change.path)
          : vscode.Uri.file(path.join(cwd, change.path));
    return [vscode.Uri.file(path.join(cwd, change.path)), left, right];
  });
  const title =
    run.status === 'done'
      ? `${run.storyId} — mergée dans ${run.baseBranch}`
      : `${run.storyId} — ${run.branch} ↔ ${run.baseBranch}`;
  await vscode.commands.executeCommand('vscode.changes', title, resources);
  return true;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
