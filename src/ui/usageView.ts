/**
 * La vue « Usage Claude » du panneau : la session (5 h) et la semaine de
 * l'abonnement, avec leurs heures de réinitialisation.
 *
 * Le relevé arrive avec chaque agent que DevBots lance ; le bouton de la vue
 * en fait un à la demande. Il est gardé dans le `globalState` : l'abonnement
 * est celui du poste, pas celui d'un dépôt.
 *
 * Une webview plutôt qu'un arbre : le panneau latéral est étroit, chaque
 * fenêtre s'y empile en carte (titre, jauge, réinitialisation) au lieu d'une
 * ligne tronquée.
 */

import * as vscode from 'vscode';
import {
  ageLabel,
  mergeSnapshots,
  probeUsage,
  windowView,
  type UsageSnapshot,
  type UsageWindow
} from '../core/usage.js';
import { readConfig } from '../util/config.js';

const STATE_KEY = 'devbots.usage';
const VIEW_ID = 'devbots.usage';

/** Seuils de couleur de la jauge, en pourcentage consommé. */
const WARNING_AT = 75;
const DANGER_AT = 90;

export class UsageViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private probing: Promise<void> | undefined;
  /** Les heures relatives (« dans 2 h 05 ») vieillissent : la vue se redessine chaque minute. */
  private readonly ticker = setInterval(() => this.render(), 60_000);

  constructor(
    private readonly memento: vscode.Memento,
    private readonly scope: vscode.Uri,
    private readonly log: vscode.LogOutputChannel
  ) {}

  register(): vscode.Disposable[] {
    return [
      vscode.window.registerWebviewViewProvider(VIEW_ID, this),
      vscode.commands.registerCommand('devbots.refreshUsage', () => this.refresh())
    ];
  }

  dispose(): void {
    clearInterval(this.ticker);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message.type === 'refresh') {
        void this.refresh();
      }
    });
    view.onDidChangeVisibility(() => this.render());
    view.onDidDispose(() => {
      this.view = undefined;
    });
    this.render();
  }

  /** Un relevé venu d'un agent. */
  record(snapshot: UsageSnapshot): void {
    const merged = mergeSnapshots(this.snapshot, snapshot);
    void this.memento.update(STATE_KEY, merged);
    this.render();
  }

  /** Un relevé à la demande : un appel minimal à haiku. */
  refresh(): Promise<void> {
    // Deux clics rapprochés ne font qu'un appel.
    this.probing ??= Promise.resolve(
      vscode.window.withProgress({ location: { viewId: VIEW_ID }, title: "Relevé de l'usage Claude" }, async () => {
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
      this.render();
    });
    this.render();
    return this.probing;
  }

  private get snapshot(): UsageSnapshot | undefined {
    return this.memento.get<UsageSnapshot>(STATE_KEY);
  }

  private render(): void {
    if (!this.view?.visible) {
      return;
    }
    this.view.webview.html = this.html();
  }

  private html(): string {
    const webview = this.view!.webview;
    const nonce = makeNonce();
    const snapshot = this.snapshot;
    const busy = this.probing !== undefined;
    const button = `<button data-refresh${busy ? ' disabled' : ''}>${busy ? 'Relevé en cours…' : 'Relever maintenant'}</button>`;

    let body: string;
    if (!snapshot) {
      body = `<p class="muted">Aucun relevé pour l’instant. Il arrive avec le premier agent lancé, ou par un appel minimal à haiku.</p>${button}`;
    } else {
      const parts: string[] = [];
      if (snapshot.status === 'rejected') {
        parts.push(
          '<div class="alert"><strong>Plafond atteint</strong><span>Les appels à Claude échouent jusqu’à la réinitialisation de la fenêtre pleine.</span></div>'
        );
      }
      if (snapshot.session) {
        parts.push(card('Session', 'fenêtre glissante de 5 h', snapshot.session));
      }
      if (snapshot.week) {
        parts.push(card('Semaine', 'fenêtre de 7 jours', snapshot.week));
      }
      const at = new Date(snapshot.at).toLocaleString('fr-FR');
      parts.push(
        `<footer><span class="muted" title="Relevé du ${at}">Relevé ${ageLabel(snapshot.at)}</span>${button}` +
          '<p class="note">Chiffres du compte entier (Claude Code, claude.ai), pas seulement de DevBots. Ils se mettent à jour à chaque agent lancé.</p></footer>'
      );
      body = parts.join('');
    }

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">${STYLE}</style>
<title>Usage Claude</title>
</head>
<body>
<main>${body}</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-refresh]:not([disabled])')) vscode.postMessage({ type: 'refresh' });
});
</script>
</body>
</html>`;
  }
}

/** Une fenêtre en carte : titre et pourcentage, jauge, réinitialisation. */
function card(label: string, span: string, window: UsageWindow): string {
  const view = windowView(window);
  const level = view.percent >= DANGER_AT ? 'danger' : view.percent >= WARNING_AT ? 'warning' : 'ok';
  const fill = Math.max(0, Math.min(100, view.percent));
  const detail = view.elapsed
    ? `<div class="line">Réinitialisée ${view.resetLabel}</div><div class="line muted">Le prochain relevé dira où elle en est.</div>`
    : `<div class="line">Réinitialisation ${view.resetLabel}</div><div class="line muted">${view.resetIn} · ${100 - fill} % restants</div>`;
  // La jauge est un SVG : la CSP refuse les attributs `style`, pas ceux d'un `rect`.
  return `<section class="card ${level}">
<header><span class="title">${label}</span><span class="percent">${view.elapsed ? '—' : `${view.percent} %`}</span></header>
<div class="span muted">${span}</div>
<svg class="gauge" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${view.percent} % consommés">
<rect class="track" width="100" height="6" rx="3"/><rect class="fill" width="${fill}" height="6" rx="3"/>
</svg>
${detail}
</section>`;
}

const STYLE = `
body { padding: 8px 12px 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
main { display: flex; flex-direction: column; gap: 10px; }
.muted { color: var(--vscode-descriptionForeground); }
.card { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 6px;
  background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); }
.card header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.title { font-weight: 600; text-transform: uppercase; letter-spacing: .04em; font-size: .85em; }
.percent { font-size: 1.6em; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.1; }
.span { font-size: .85em; margin-top: -2px; }
.gauge { width: 100%; height: 6px; margin: 6px 0 4px; display: block; }
.track { fill: var(--vscode-input-background, rgba(128,128,128,.2)); }
.ok .fill { fill: var(--vscode-charts-green, #3fb950); }
.warning .fill { fill: var(--vscode-charts-yellow, #d29922); }
.warning .percent { color: var(--vscode-charts-yellow, #d29922); }
.danger .fill { fill: var(--vscode-charts-red, #f85149); }
.danger .percent { color: var(--vscode-charts-red, #f85149); }
.line { font-size: .92em; }
.alert { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; border-radius: 6px;
  border-left: 3px solid var(--vscode-errorForeground);
  background: var(--vscode-inputValidation-errorBackground, rgba(248,81,73,.1)); }
footer { display: flex; flex-direction: column; gap: 8px; margin-top: 2px; }
button { width: 100%; padding: 5px 10px; border: none; border-radius: 2px; cursor: pointer;
  color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font: inherit; }
button:hover:not([disabled]) { background: var(--vscode-button-secondaryHoverBackground); }
button[disabled] { opacity: .6; cursor: default; }
.note { margin: 0; font-size: .8em; color: var(--vscode-descriptionForeground); }
`;

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
