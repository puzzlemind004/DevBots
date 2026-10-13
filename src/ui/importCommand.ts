/**
 * La commande d'import : un identifiant suffit pour remplir `.work/new`.
 *
 * Rien n'est écrit dans la source.
 */

import * as vscode from 'vscode';
import type { SourceKind } from '../core/model.js';
import type { ImportResult } from '../core/workDir.js';
import { WorkDir } from '../core/workDir.js';
import { ConfigError, createSource } from '../sources/factory.js';
import { readConfig, sourceLabel } from '../util/config.js';

export interface ImportContext {
  repoRoot: string;
  repoUri: vscode.Uri;
  secrets: vscode.SecretStorage;
  log: vscode.LogOutputChannel;
  onImported: () => void;
}

export async function runImport(ctx: ImportContext): Promise<void> {
  const config = readConfig(ctx.repoUri);
  const label = sourceLabel(config.sourceKind);

  const rootId = await vscode.window.showInputBox({
    title: `DevBots — importer depuis ${label}`,
    prompt: promptFor(config.sourceKind),
    placeHolder: config.sourceKind === 'github' ? '42, #42 ou une URL d\'issue' : '1234 ou une URL de work item',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'Un identifiant est attendu.')
  });
  if (!rootId) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Import depuis ${label}`,
      cancellable: true
    },
    async (progress, token) => {
      try {
        progress.report({ message: 'connexion…' });
        const source = await createSource(config, ctx.secrets, ctx.repoRoot);
        await source.probe();

        progress.report({ message: 'lecture de la hiérarchie…' });
        const tickets = await source.fetchTree(rootId, token);
        if (token.isCancellationRequested) {
          return;
        }

        // Seules les stories deviennent des fiches : les epics et features ne
        // servent qu'à retrouver la hiérarchie et le parent.
        const stories = tickets.filter((t) => t.level === 'story');
        if (stories.length === 0) {
          vscode.window.showWarningMessage(
            `Aucune story trouvée sous ${rootId}. Vérifie que l'élément a bien des enfants.`
          );
          return;
        }

        progress.report({ message: `écriture de ${stories.length} fiche(s)…` });
        const workDir = new WorkDir(vscode.Uri.joinPath(ctx.repoUri, config.workDir).fsPath);
        const results = await workDir.importTickets(stories, config.sourceKind);

        ctx.onImported();
        reportResults(results, config.sourceKind, ctx.log);
      } catch (err) {
        await reportError(err, ctx.log);
      }
    }
  );
}

function promptFor(kind: SourceKind): string {
  return kind === 'github'
    ? "Numéro de l'issue parente. Ses sub-issues deviennent les stories de .work/new."
    : "ID de l'epic ou de la feature. Ses user stories deviennent les fiches de .work/new.";
}

function reportResults(
  results: ImportResult[],
  source: SourceKind,
  log: vscode.LogOutputChannel
): void {
  const created = results.filter((r) => r.outcome === 'created').length;
  const unchanged = results.filter((r) => r.outcome === 'unchanged').length;
  const needsReview = results.filter((r) => r.outcome === 'needsReview');

  for (const result of results) {
    log.info(`[${source}] ${result.sourceId} ${result.outcome} — ${result.title}`);
  }

  const parts: string[] = [];
  if (created > 0) {
    parts.push(`${created} fiche(s) écrite(s)`);
  }
  if (unchanged > 0) {
    parts.push(`${unchanged} inchangée(s)`);
  }
  if (needsReview.length > 0) {
    parts.push(`${needsReview.length} à revoir`);
  }
  const summary = parts.length > 0 ? parts.join(', ') : 'rien à importer';

  if (needsReview.length > 0) {
    // Une story déjà planifiée qui a changé dans la source n'est pas écrasée.
    vscode.window.showWarningMessage(
      `Import terminé : ${summary}. Les stories ${needsReview
        .map((r) => r.sourceId)
        .join(', ')} ont changé dans la source depuis leur planification.`
    );
  } else {
    vscode.window.showInformationMessage(`Import terminé : ${summary}.`);
  }
}

async function reportError(err: unknown, log: vscode.LogOutputChannel): Promise<void> {
  if (err instanceof ConfigError) {
    log.warn(err.message);
    const action = err.settingId ? 'Ouvrir les paramètres' : undefined;
    const chosen = await vscode.window.showErrorMessage(
      err.message,
      ...(action ? [action] : [])
    );
    if (chosen === action && err.settingId) {
      await vscode.commands.executeCommand('workbench.action.openSettings', err.settingId);
    }
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);
  const chosen = await vscode.window.showErrorMessage(`Import impossible : ${message}`, 'Voir le journal');
  if (chosen === 'Voir le journal') {
    log.show();
  }
}
