/**
 * La vue « Usage Claude » du panneau : la session (5 h) et la semaine de
 * l'abonnement, avec leurs heures de réinitialisation.
 *
 * Le relevé arrive avec chaque agent que DevBots lance ; le bouton de la vue
 * en fait un à la demande. Il est gardé dans le `globalState` : l'abonnement
 * est celui du poste, pas celui d'un dépôt.
 */

import * as vscode from 'vscode';
import {
  ageLabel,
  mergeSnapshots,
  probeUsage,
  usageBar,
  windowView,
  type UsageSnapshot,
  type UsageWindow
} from '../core/usage.js';
import { readConfig } from '../util/config.js';

const STATE_KEY = 'devbots.usage';

/** Seuils de couleur de la jauge, en pourcentage consommé. */
const WARNING_AT = 75;
const DANGER_AT = 90;

type UsageNode =
  | { kind: 'window'; label: string; window: UsageWindow; span: string }
  | { kind: 'rejected' }
  | { kind: 'age'; at: string }
  | { kind: 'empty' };

export class UsageViewProvider implements vscode.TreeDataProvider<UsageNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<UsageNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private probing: Promise<void> | undefined;
  /** Les heures relatives (« dans 2 h 05 ») vieillissent : la vue se redessine chaque minute. */
  private readonly ticker = setInterval(() => this.changed.fire(undefined), 60_000);

  constructor(
    private readonly memento: vscode.Memento,
    private readonly scope: vscode.Uri,
    private readonly log: vscode.LogOutputChannel
  ) {}

  register(): vscode.Disposable[] {
    return [
      vscode.window.createTreeView('devbots.usage', { treeDataProvider: this }),
      vscode.commands.registerCommand('devbots.refreshUsage', () => this.refresh())
    ];
  }

  dispose(): void {
    clearInterval(this.ticker);
    this.changed.dispose();
  }

  /** Un relevé venu d'un agent. */
  record(snapshot: UsageSnapshot): void {
    const merged = mergeSnapshots(this.snapshot, snapshot);
    void this.memento.update(STATE_KEY, merged);
    this.changed.fire(undefined);
  }

  /** Un relevé à la demande : un appel minimal à haiku. */
  refresh(): Promise<void> {
    // Deux clics rapprochés ne font qu'un appel.
    this.probing ??= Promise.resolve(
      vscode.window.withProgress({ location: { viewId: 'devbots.usage' }, title: "Relevé de l'usage Claude" }, async () => {
        try {
          this.record(await probeUsage(readConfig(this.scope).claudeExecutable));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(message);
          vscode.window.showWarningMessage(message);
        }
      })
    ).finally(() => {
      this.probing = undefined;
    });
    return this.probing;
  }

  private get snapshot(): UsageSnapshot | undefined {
    return this.memento.get<UsageSnapshot>(STATE_KEY);
  }

  getChildren(element?: UsageNode): UsageNode[] {
    if (element) {
      return [];
    }
    const snapshot = this.snapshot;
    if (!snapshot) {
      return [{ kind: 'empty' }];
    }
    const nodes: UsageNode[] = [];
    if (snapshot.status === 'rejected') {
      nodes.push({ kind: 'rejected' });
    }
    if (snapshot.session) {
      nodes.push({ kind: 'window', label: 'Session', window: snapshot.session, span: 'fenêtre glissante de 5 h' });
    }
    if (snapshot.week) {
      nodes.push({ kind: 'window', label: 'Semaine', window: snapshot.week, span: 'fenêtre de 7 jours' });
    }
    nodes.push({ kind: 'age', at: snapshot.at });
    return nodes;
  }

  getTreeItem(node: UsageNode): vscode.TreeItem {
    switch (node.kind) {
      case 'empty': {
        const item = new vscode.TreeItem('Relever l’usage maintenant');
        item.iconPath = new vscode.ThemeIcon('refresh');
        item.tooltip = 'Aucun relevé pour l’instant. Il arrive avec le premier agent lancé, ou par un appel minimal à haiku.';
        item.command = { command: 'devbots.refreshUsage', title: 'Relever' };
        return item;
      }
      case 'rejected': {
        const item = new vscode.TreeItem('Plafond atteint');
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
        item.tooltip = 'Les appels à Claude échouent jusqu’à la réinitialisation de la fenêtre pleine.';
        return item;
      }
      case 'age': {
        const item = new vscode.TreeItem(`Relevé ${ageLabel(node.at)}`);
        item.iconPath = new vscode.ThemeIcon('history');
        item.tooltip = new vscode.MarkdownString(
          [
            `Relevé du ${new Date(node.at).toLocaleString('fr-FR')}.`,
            '',
            'Les chiffres valent pour tout le compte (Claude Code, claude.ai), pas seulement pour DevBots. Ils se mettent à jour à chaque agent lancé ; un clic en fait un relevé frais, au prix d’un appel minimal à haiku.'
          ].join('\n')
        );
        item.command = { command: 'devbots.refreshUsage', title: 'Relever' };
        return item;
      }
      case 'window': {
        const view = windowView(node.window);
        const item = new vscode.TreeItem(`${node.label} ${view.percent} %`);
        item.description = view.elapsed
          ? `réinitialisée ${view.resetLabel}`
          : `${usageBar(view.percent)}  reset ${view.resetLabel}`;
        const color =
          view.percent >= DANGER_AT ? 'list.errorForeground' : view.percent >= WARNING_AT ? 'list.warningForeground' : undefined;
        item.iconPath = new vscode.ThemeIcon(
          node.label === 'Session' ? 'watch' : 'calendar',
          color ? new vscode.ThemeColor(color) : undefined
        );
        item.tooltip = new vscode.MarkdownString(
          view.elapsed
            ? `**${node.label}** (${node.span}) : réinitialisée ${view.resetLabel}. Le prochain relevé dira où elle en est.`
            : `**${node.label}** (${node.span}) : ${view.percent} % consommés, ${100 - Math.min(100, view.percent)} % restants.\n\nRéinitialisation ${view.resetLabel}, ${view.resetIn}.`
        );
        return item;
      }
    }
  }
}
