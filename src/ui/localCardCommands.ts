/**
 * Les commandes de saisie à la main : nouvelle feature, nouvelle story.
 *
 * Elles demandent le strict minimum (un titre, une feature), écrivent une fiche
 * pré-remplie et l'ouvrent dans l'éditeur : le reste se complète en markdown.
 */

import * as vscode from 'vscode';
import type { CreatedCard, FeatureFile } from '../core/workDir.js';
import { WorkDir } from '../core/workDir.js';
import { readConfig } from '../util/config.js';
import type { FlowNode } from './flowTree.js';

export interface LocalCardContext {
  repoUri: vscode.Uri;
  log: vscode.LogOutputChannel;
  onCreated: () => void;
}

export async function newFeature(ctx: LocalCardContext): Promise<void> {
  const title = await askTitle('Nouvelle feature', "Titre de la feature, par exemple « Inscription par email »");
  if (!title) {
    return;
  }
  await create(ctx, 'feature', (workDir) => workDir.createFeature(title));
}

/**
 * Lancée depuis une feature du panneau, la story lui est rattachée d'office ;
 * sinon, on demande la feature, avec la possibilité d'en créer une au passage.
 */
export async function newStory(ctx: LocalCardContext, node?: FlowNode): Promise<void> {
  let parent: string | null;
  if (node?.kind === 'feature') {
    parent = node.feature.frontmatter.source_id;
  } else {
    const picked = await pickFeature(await workDirOf(ctx.repoUri).listFeatures());
    if (picked === undefined) {
      return;
    }
    if (picked === 'new') {
      const featureTitle = await askTitle('Nouvelle feature', 'Titre de la feature qui portera la story');
      if (!featureTitle) {
        return;
      }
      // La feature se complète plus tard : seule la story s'ouvre dans l'éditeur.
      const feature = await create(ctx, 'feature', (w) => w.createFeature(featureTitle), false);
      if (!feature) {
        return;
      }
      parent = feature.id;
    } else {
      parent = picked;
    }
  }

  const title = await askTitle('Nouvelle story', 'Titre de la story, par exemple « Valider le format de l\'email »');
  if (!title) {
    return;
  }
  await create(ctx, 'story', (w) => w.createLocalStory(title, parent));
}

interface FeaturePick extends vscode.QuickPickItem {
  /** Identifiant de la feature, `null` pour aucune, `'new'` pour en créer une. */
  choice: string | null;
}

async function pickFeature(features: FeatureFile[]): Promise<string | null | 'new' | undefined> {
  const items: FeaturePick[] = [
    { label: '$(add) Nouvelle feature…', choice: 'new' },
    { label: '$(circle-slash) Aucune feature', choice: null }
  ];
  if (features.length > 0) {
    items.push({ label: 'Features', kind: vscode.QuickPickItemKind.Separator, choice: null });
    items.push(
      ...features.map((f) => ({
        label: `$(layers) ${f.title}`,
        description: f.frontmatter.source_id,
        choice: f.frontmatter.source_id
      }))
    );
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: 'DevBots — nouvelle story',
    placeHolder: 'À quelle feature rattacher la story ?',
    matchOnDescription: true,
    ignoreFocusOut: true
  });
  return picked === undefined ? undefined : picked.choice;
}

async function askTitle(title: string, prompt: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: `DevBots — ${title.toLowerCase()}`,
    prompt,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Un titre est attendu.')
  });
  return value?.trim() || undefined;
}

/** Écrit la fiche, rafraîchit le panneau et, par défaut, ouvre la fiche à compléter. */
async function create(
  ctx: LocalCardContext,
  what: 'feature' | 'story',
  write: (workDir: WorkDir) => Promise<CreatedCard>,
  open = true
): Promise<CreatedCard | undefined> {
  try {
    const created = await write(workDirOf(ctx.repoUri));
    ctx.log.info(`[local] ${what} ${created.id} créée : ${created.filePath}`);
    ctx.onCreated();
    if (open) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(created.filePath));
      await vscode.window.showTextDocument(doc, { preview: false });
    }
    return created;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error(`Création d'une ${what} : ${message}`);
    vscode.window.showErrorMessage(`Impossible de créer la ${what} : ${message}`);
    return undefined;
  }
}

function workDirOf(repoUri: vscode.Uri): WorkDir {
  return new WorkDir(vscode.Uri.joinPath(repoUri, readConfig(repoUri).workDir).fsPath);
}
