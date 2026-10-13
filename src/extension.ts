/**
 * Point d'entrée de l'extension DevBots.
 *
 * Phase 1 : paramètres, connecteurs de tickets, import vers `.work/new`,
 * panneau latéral en lecture, vérification du CLI Claude Code.
 */

import * as vscode from 'vscode';
import { WorkDir } from './core/workDir.js';
import { checkClaude } from './core/claudeCli.js';
import { FlowTreeProvider, type FlowNode } from './ui/flowTree.js';
import { runImport } from './ui/importCommand.js';
import {
  CONFIG_SECTION,
  deleteSecret,
  getSecret,
  readConfig,
  setSecret,
  sourceLabel
} from './util/config.js';
import type { SourceKind } from './core/model.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('DevBots', { log: true });
  context.subscriptions.push(log);

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    log.warn("Aucun dossier ouvert : l'extension reste inactive.");
    return;
  }

  const config = readConfig(folder.uri);
  const workDirPath = vscode.Uri.joinPath(folder.uri, config.workDir).fsPath;
  const tree = new FlowTreeProvider(new WorkDir(workDirPath));

  const view = vscode.window.createTreeView<FlowNode>('devbots.flow', {
    treeDataProvider: tree,
    showCollapseAll: true
  });
  context.subscriptions.push(view);

  // Le panneau se rafraîchit seul quand une fiche de `.work` change.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, `${config.workDir}/**/*.md`)
  );
  watcher.onDidCreate(() => tree.refresh(), undefined, context.subscriptions);
  watcher.onDidDelete(() => tree.refresh(), undefined, context.subscriptions);
  watcher.onDidChange(() => tree.refresh(), undefined, context.subscriptions);
  context.subscriptions.push(watcher);

  // Un changement de dossier de travail recrée le WorkDir du panneau.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION, folder.uri)) {
        const next = readConfig(folder.uri);
        tree.setWorkDir(new WorkDir(vscode.Uri.joinPath(folder.uri, next.workDir).fsPath));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('devbots.importTickets', () =>
      runImport({
        repoRoot: folder.uri.fsPath,
        repoUri: folder.uri,
        secrets: context.secrets,
        log,
        onImported: () => tree.refresh()
      })
    ),
    vscode.commands.registerCommand('devbots.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('devbots.openStory', async (filePath: string) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand('devbots.openInSource', async (node: FlowNode) => {
      if (node?.kind !== 'story') {
        return;
      }
      const url = node.story.frontmatter.web_url;
      if (!url) {
        vscode.window.showWarningMessage("Cette fiche ne porte pas de lien vers la source.");
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand('devbots.setToken', () => promptForToken(context, folder.uri)),
    vscode.commands.registerCommand('devbots.clearToken', () => clearToken(context, folder.uri)),
    vscode.commands.registerCommand('devbots.checkClaude', () =>
      reportClaudeStatus(folder.uri, log, true)
    )
  );

  // Vérification silencieuse au démarrage : elle ne parle qu'en cas de problème.
  void reportClaudeStatus(folder.uri, log, false);
  log.info(`DevBots actif sur ${folder.name} (source : ${sourceLabel(config.sourceKind)}).`);
}

export function deactivate(): void {
  // Les ressources sont libérées par context.subscriptions.
}

async function promptForToken(
  context: vscode.ExtensionContext,
  scope: vscode.Uri
): Promise<void> {
  const kind = await pickSource(scope);
  if (!kind) {
    return;
  }
  const token = await vscode.window.showInputBox({
    title: `Jeton ${sourceLabel(kind)}`,
    prompt:
      kind === 'github'
        ? 'Jeton à granularité fine, limité à la lecture des issues. Laisse vide pour utiliser la connexion GitHub de VS Code.'
        : 'PAT Azure DevOps limité à la lecture des work items.',
    password: true,
    ignoreFocusOut: true
  });
  if (!token) {
    return;
  }
  await setSecret(context.secrets, kind, token.trim());
  vscode.window.showInformationMessage(`Jeton ${sourceLabel(kind)} enregistré dans le SecretStorage.`);
}

async function clearToken(context: vscode.ExtensionContext, scope: vscode.Uri): Promise<void> {
  const kind = await pickSource(scope);
  if (!kind) {
    return;
  }
  const existing = await getSecret(context.secrets, kind);
  if (!existing) {
    vscode.window.showInformationMessage(`Aucun jeton ${sourceLabel(kind)} enregistré.`);
    return;
  }
  await deleteSecret(context.secrets, kind);
  vscode.window.showInformationMessage(`Jeton ${sourceLabel(kind)} effacé.`);
}

/** `kind` est réservé par QuickPickItem : la source voyage dans `source`. */
interface SourcePick extends vscode.QuickPickItem {
  source: SourceKind;
}

async function pickSource(scope: vscode.Uri): Promise<SourceKind | undefined> {
  const current = readConfig(scope).sourceKind;
  const items: SourcePick[] = [
    {
      label: 'GitHub',
      source: 'github',
      description: current === 'github' ? 'source du dépôt' : ''
    },
    {
      label: 'Azure DevOps',
      source: 'azureDevOps',
      description: current === 'azureDevOps' ? 'source du dépôt' : ''
    }
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Quelle source ?',
    ignoreFocusOut: true
  });
  return picked?.source;
}

async function reportClaudeStatus(
  scope: vscode.Uri,
  log: vscode.LogOutputChannel,
  verbose: boolean
): Promise<void> {
  const { claudeExecutable } = readConfig(scope);
  const status = await checkClaude(claudeExecutable);

  if (status.versionOk) {
    log.info(`Claude Code ${status.version} détecté.`);
    if (verbose) {
      vscode.window.showInformationMessage(`Claude Code ${status.version} est prêt.`);
    }
    return;
  }

  log.warn(status.problem ?? 'Claude Code indisponible.');
  const chosen = await vscode.window.showWarningMessage(
    status.problem ?? 'Claude Code indisponible.',
    'Ouvrir les paramètres'
  );
  if (chosen === 'Ouvrir les paramètres') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'devbots.claude.executable');
  }
}
