/**
 * La suppression d'une fiche du panneau, story ou feature, après une saisie
 * ratée par exemple.
 *
 * La fiche part à la corbeille : une erreur se rattrape. L'atelier de `plans/`
 * reste, et un ticket importé redevient proposé au prochain import. Rien n'est
 * supprimé chez la source.
 */

import * as vscode from 'vscode';
import type { FlowNode } from './flowTree.js';

export interface DeleteContext {
  log: vscode.LogOutputChannel;
  onDeleted: () => void;
}

export async function deleteCard(ctx: DeleteContext, node?: FlowNode): Promise<void> {
  if (node?.kind !== 'story' && node?.kind !== 'feature') {
    return;
  }
  const card = node.kind === 'story' ? node.story : node.feature;
  const id = card.frontmatter.source_id;

  const details: string[] = ['La fiche part à la corbeille.'];
  if (node.kind === 'feature' && node.stories.length > 0) {
    details.push(`Ses ${node.stories.length} story(s) de New restent, sans feature.`);
  }
  if (card.frontmatter.source !== 'local') {
    details.push("Le ticket reste dans la source et sera de nouveau proposé à l'import.");
  }
  const what = node.kind === 'story' ? 'la story' : 'la feature';
  const confirmed = await vscode.window.showWarningMessage(
    `Supprimer ${what} ${id} — ${card.title} ?`,
    { modal: true, detail: details.join('\n') },
    'Supprimer'
  );
  if (confirmed !== 'Supprimer') {
    return;
  }

  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(card.filePath), { useTrash: true });
    ctx.log.info(`${node.kind} ${id} supprimée : ${card.filePath}`);
    ctx.onDeleted();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error(`Suppression de ${id} : ${message}`);
    vscode.window.showErrorMessage(`Impossible de supprimer ${id} : ${message}`);
  }
}
