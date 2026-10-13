/**
 * « Personnaliser les gabarits » : dépose les gabarits par défaut dans le
 * dossier du flux et les ouvre, pour que le dépôt les adapte.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { ejectTemplates } from '../core/templates.js';
import { readConfig } from '../util/config.js';

export interface TemplatesContext {
  repoUri: vscode.Uri;
  log: vscode.LogOutputChannel;
}

export async function customizeTemplates(ctx: TemplatesContext): Promise<void> {
  const config = readConfig(ctx.repoUri);
  const workRoot = vscode.Uri.joinPath(ctx.repoUri, config.workDir).fsPath;

  let result;
  try {
    result = await ejectTemplates(workRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error(`Gabarits : ${message}`);
    vscode.window.showErrorMessage(`Impossible d'écrire les gabarits : ${message}`);
    return;
  }

  for (const filePath of [...result.written, ...result.kept]) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  const names = (files: string[]) => files.map((f) => path.basename(f)).join(', ');
  const parts: string[] = [];
  if (result.written.length) {
    parts.push(`Gabarits par défaut déposés : ${names(result.written)}.`);
  }
  if (result.kept.length) {
    parts.push(`Déjà présents, laissés tels quels : ${names(result.kept)}.`);
  }
  if (config.planningTemplate) {
    parts.push(`Le paramètre devbots.planning.template (${config.planningTemplate}) reste prioritaire pour le plan.`);
  }
  vscode.window.showInformationMessage(parts.join(' '));
}
