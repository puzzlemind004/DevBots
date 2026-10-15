/**
 * Le code qu'un agent en lecture seule doit lire pour une story pas encore
 * développée : celui de la branche sur laquelle son dev partira.
 *
 * Une story d'une feature se développe et se merge sur la branche de sa
 * feature. Dès que cette branche existe, c'est elle qu'il faut lire, pas la
 * branche extraite dans le dépôt : elle contient les stories déjà mergées.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Git } from './git.js';
import { featureBranchName, refSafeId } from './git.js';

export interface StoryBase {
  /** La branche d'où part la branche de feature : `devbots.git.baseBranch`, sinon la branche extraite. */
  base: string;
  /** La branche sur laquelle la story se développe et se merge : celle de sa feature, sinon `base`. */
  baseBranch: string;
}

/** La feature parente, réduite à ce qui nomme sa branche. */
export interface FeatureRef {
  id: string;
  title: string;
}

/** Les branches d'une story, partagées entre la planification et le dev. */
export async function storyBase(
  git: Pick<Git, 'currentBranch'>,
  baseSetting: string,
  feature?: FeatureRef
): Promise<StoryBase> {
  const base = baseSetting || (await git.currentBranch());
  return { base, baseBranch: feature ? featureBranchName(feature.id, feature.title) : base };
}

/** Qui lit : chacun son worktree, pour que l'un ne supprime pas celui de l'autre. */
export type ReadPurpose = 'plan' | 'verify';

/** Le worktree détaché où se lit le code d'une story avant son dev. */
export function readCheckoutDir(worktreeRoot: string, storyId: string, purpose: ReadPurpose): string {
  return path.join(worktreeRoot, `.${purpose}-${refSafeId(storyId)}`);
}

export interface CodeCheckout {
  /** Le dossier à donner comme `cwd` à l'agent. */
  dir: string;
  /** Ce qui y est extrait. */
  ref: string;
  /** Vrai quand `dir` est un worktree détaché propre à cette lecture, à supprimer après. */
  detached: boolean;
}

export interface CheckoutOptions {
  repoRoot: string;
  worktreeRoot: string;
  storyId: string;
  purpose: ReadPurpose;
  baseSetting: string;
  feature?: FeatureRef;
}

/**
 * Le dossier où lire le code de la story, à jour.
 *
 * Sans feature, sur la branche extraite dans le dépôt : le dépôt lui-même.
 * Sinon, un worktree détaché, rafraîchi à chaque appel, sur la branche de
 * feature si elle existe, sur celle d'où elle partira sinon. Le dossier d'une
 * story de feature ne change donc jamais, même quand sa branche de feature
 * apparaît : une session Claude, rangée par dossier, peut toujours reprendre.
 */
export async function codeCheckout(
  git: Pick<Git, 'currentBranch' | 'branchExists' | 'checkedOutIn' | 'ensureDetachedWorktree'>,
  options: CheckoutOptions
): Promise<CodeCheckout> {
  const { base, baseBranch } = await storyBase(git, options.baseSetting, options.feature);
  const ref = options.feature && (await git.branchExists(baseBranch)) ? baseBranch : base;
  if (!options.feature) {
    const checkedOut = await git.checkedOutIn(ref);
    if (checkedOut && samePath(checkedOut, options.repoRoot)) {
      return { dir: options.repoRoot, ref, detached: false };
    }
  }
  const dir = readCheckoutDir(options.worktreeRoot, options.storyId, options.purpose);
  await git.ensureDetachedWorktree(dir, ref);
  return { dir, ref, detached: true };
}

/** Supprime le worktree de lecture d'une story, s'il existe. */
export async function removeReadCheckout(
  git: Pick<Git, 'removeWorktree'>,
  worktreeRoot: string,
  storyId: string,
  purpose: ReadPurpose
): Promise<void> {
  const dir = readCheckoutDir(worktreeRoot, storyId, purpose);
  try {
    await fs.access(dir);
  } catch {
    return;
  }
  await git.removeWorktree(dir);
}

/** Deux chemins vers le même dossier. Sous Windows, la casse ne compte pas (`c:` et `C:`). */
export function samePath(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
