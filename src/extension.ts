/**
 * Point d'entrée de l'extension DevBots.
 *
 * Phase 1 : paramètres, connecteurs de tickets, import vers `.work/new`, saisie
 * à la main de features et de stories, suppression d'une fiche, panneau latéral,
 * vérification du CLI Claude Code.
 * Phase 2 : atelier de planification, de New à Ready ; gabarits du dépôt.
 * Phase 3 : state.json, worktrees, agents de dev, revue des CR, étapes de
 * supervision et tri des problèmes, de Ready à « À valider ».
 * Phase 4 : ta revue (diff, worktree, application, retours), feu vert, merge
 * séquentiel dans la branche de la feature, nettoyage, passage dans Done.
 * Phase 5 : resynchronisation avec la source et décision sur les stories
 * « à revoir », niveau de notifications et badge, paquet `.vsix`.
 */

import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import { WorkDir, type StoryFile } from './core/workDir.js';
import { checkClaude } from './core/claudeCli.js';
import { isIncomplete } from './core/localCards.js';
import { FlowTreeProvider, type FlowNode } from './ui/flowTree.js';
import { runImport } from './ui/importCommand.js';
import { deleteCard } from './ui/deleteCommand.js';
import { newFeature, newStory } from './ui/localCardCommands.js';
import { PlanningPanel } from './ui/planningPanel.js';
import { customizeTemplates } from './ui/templatesCommand.js';
import { DevController } from './ui/devController.js';
import { SourceSync } from './ui/resyncCommand.js';
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

  // Le panneau se rafraîchit seul quand une fiche ou un atelier de `.work` change.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, `${config.workDir}/**/*.{md,json}`)
  );
  const dev = new DevController({ repoUri: folder.uri, log, refresh: () => tree.refresh() });
  context.subscriptions.push(dev, ...dev.register());
  dev.setBadgeView(view);

  // Le badge suit les fiches : une story marquée « à revoir » le fait bouger.
  let indicatorsTimer: ReturnType<typeof setTimeout> | undefined;
  const onWorkChanged = (): void => {
    tree.refresh();
    clearTimeout(indicatorsTimer);
    indicatorsTimer = setTimeout(() => dev.updateIndicators(), 300);
  };
  watcher.onDidCreate(onWorkChanged, undefined, context.subscriptions);
  watcher.onDidDelete(onWorkChanged, undefined, context.subscriptions);
  watcher.onDidChange(onWorkChanged, undefined, context.subscriptions);
  context.subscriptions.push(watcher, { dispose: () => clearTimeout(indicatorsTimer) });

  const sync = new SourceSync({ repoUri: folder.uri, secrets: context.secrets, log, refresh: onWorkChanged });
  context.subscriptions.push(sync, ...sync.register());

  // Un changement de dossier de travail recrée le WorkDir du panneau.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.workDir`, folder.uri)) {
        const next = readConfig(folder.uri);
        tree.setWorkDir(new WorkDir(vscode.Uri.joinPath(folder.uri, next.workDir).fsPath));
        dev.onWorkDirChanged();
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
    vscode.commands.registerCommand('devbots.newFeature', () =>
      newFeature({ repoUri: folder.uri, log, onCreated: () => tree.refresh() })
    ),
    vscode.commands.registerCommand('devbots.newStory', (node?: FlowNode) =>
      newStory({ repoUri: folder.uri, log, onCreated: () => tree.refresh() }, node)
    ),
    vscode.commands.registerCommand('devbots.deleteCard', (node?: FlowNode) =>
      deleteCard({ log, onDeleted: () => tree.refresh() }, node)
    ),
    vscode.commands.registerCommand('devbots.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('devbots.planStory', async (node?: FlowNode) => {
      const story = node?.kind === 'story' ? node.story : await pickNewStory(folder.uri);
      if (!story || !(await confirmComplete(story))) {
        return;
      }
      try {
        await PlanningPanel.show(story, {
          extensionUri: context.extensionUri,
          repoUri: folder.uri,
          log,
          onChanged: () => tree.refresh()
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Ouverture de l'atelier : ${message}`);
        vscode.window.showErrorMessage(`Impossible d'ouvrir l'atelier : ${message}`);
      }
    }),
    vscode.commands.registerCommand('devbots.openStory', async (filePath: string) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand('devbots.openInSource', async (node: FlowNode) => {
      const url =
        node?.kind === 'story'
          ? node.story.frontmatter.web_url
          : node?.kind === 'feature'
            ? node.feature.frontmatter.web_url
            : undefined;
      if (node?.kind === 'group') {
        return;
      }
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
    ),
    vscode.commands.registerCommand('devbots.customizeTemplates', () =>
      customizeTemplates({ repoUri: folder.uri, log })
    )
  );

  // Vérification silencieuse au démarrage : elle ne parle qu'en cas de problème.
  void reportClaudeStatus(folder.uri, log, false);
  void dev.start().catch((err: unknown) => {
    log.error(`Reprise du flux de dev : ${err instanceof Error ? err.message : String(err)}`);
  });
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

interface StoryPick extends vscode.QuickPickItem {
  story: StoryFile;
}

async function pickNewStory(scope: vscode.Uri): Promise<StoryFile | undefined> {
  const workDir = new WorkDir(vscode.Uri.joinPath(scope, readConfig(scope).workDir).fsPath);
  const stories = await workDir.listStories('new');
  if (stories.length === 0) {
    vscode.window.showInformationMessage(
      "Aucune story dans New. Importe des tickets ou ajoute une story à la main d'abord."
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick<StoryPick>(
    stories.map((story) => ({
      label: `${story.frontmatter.source_id} — ${story.title}`,
      story
    })),
    { title: 'Quelle story planifier ?', matchOnDescription: true }
  );
  return picked?.story;
}

/**
 * Une fiche saisie à la main garde ses mentions « À compléter » tant qu'elle
 * n'est pas remplie : Claude planifierait sur du vide. On le signale.
 */
async function confirmComplete(story: StoryFile): Promise<boolean> {
  const raw = await fs.readFile(story.filePath, 'utf8');
  if (!isIncomplete(raw)) {
    return true;
  }
  const chosen = await vscode.window.showWarningMessage(
    `La fiche ${story.frontmatter.source_id} contient encore des mentions « À compléter ».`,
    'Compléter la fiche',
    'Planifier quand même'
  );
  if (chosen === 'Compléter la fiche') {
    await vscode.commands.executeCommand('devbots.openStory', story.filePath);
  }
  return chosen === 'Planifier quand même';
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
