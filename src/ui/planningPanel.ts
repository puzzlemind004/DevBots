/**
 * L'atelier de planification : un onglet par story, dans l'éditeur.
 *
 * Mince par construction : toute la logique vit dans `core/planning.ts`. Le
 * panneau relaie les gestes de la page vers la session et renvoie l'état à
 * afficher après chaque changement.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { ClaudeError, createClaudeRunner } from '../core/claudeCli.js';
import type { Answer, PlanSection } from '../core/plan.js';
import { PLAN_SECTIONS, PlanShapeError } from '../core/plan.js';
import { PlanningError, PlanningSession } from '../core/planning.js';
import { PlanStore } from '../core/planStore.js';
import { resolveTemplate, TemplateError } from '../core/templates.js';
import { WorkDir, type StoryFile } from '../core/workDir.js';
import { readConfig } from '../util/config.js';

export interface PlanningContext {
  extensionUri: vscode.Uri;
  repoUri: vscode.Uri;
  log: vscode.LogOutputChannel;
  /** Appelé après un passage en ready, pour rafraîchir le panneau latéral. */
  onChanged: () => void;
}

/** Les messages que la page envoie. */
type Inbound =
  | { type: 'ready' }
  | { type: 'understand' }
  | { type: 'answer'; id: string; answer: Answer }
  | { type: 'draft' }
  | { type: 'revise'; section: PlanSection; comment: string }
  | { type: 'reviewed'; section: PlanSection; value: boolean }
  | { type: 'reviewAll' }
  | { type: 'validate' }
  | { type: 'cancel' }
  | { type: 'restart' }
  | { type: 'openStory' }
  | { type: 'openVersion'; version: number }
  | { type: 'diff'; from: number; to: number };

export class PlanningPanel {
  private static readonly open = new Map<string, PlanningPanel>();

  private busy: string | undefined;
  private error: string | undefined;
  private abort: AbortController | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly session: PlanningSession,
    private readonly store: PlanStore,
    private readonly workRoot: string,
    private readonly ctx: PlanningContext
  ) {
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((msg: Inbound) => void this.handle(msg));
    panel.onDidDispose(() => {
      // Fermer l'onglet arrête l'appel en cours : rien ne tourne sans témoin.
      this.abort?.abort();
      PlanningPanel.open.delete(session.state.storyId);
    });
  }

  /** Ouvre l'atelier d'une story, ou ramène au premier plan celui déjà ouvert. */
  static async show(story: StoryFile, ctx: PlanningContext): Promise<void> {
    const storyId = story.frontmatter.source_id;
    const existing = PlanningPanel.open.get(storyId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    if (story.folder !== 'new') {
      vscode.window.showInformationMessage("Seules les stories de New se planifient dans l'atelier.");
      return;
    }

    const config = readConfig(ctx.repoUri);
    const workRoot = vscode.Uri.joinPath(ctx.repoUri, config.workDir).fsPath;
    const store = new PlanStore(path.join(workRoot, 'plans'));
    const feature = await new WorkDir(workRoot).findFeature(story.frontmatter.parent);
    const session = await PlanningSession.open(
      {
        store,
        runner: createClaudeRunner(config.claudeExecutable),
        repoRoot: ctx.repoUri.fsPath,
        settings: {
          skill: config.planningSkill,
          model: config.planningModel,
          maxResumes: config.planningMaxResumes
        }
      },
      story.filePath,
      storyId,
      story.title,
      feature?.filePath
    );

    const panel = vscode.window.createWebviewPanel(
      'devbots.planning',
      `Plan · ${storyId}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'resources', 'planning')]
      }
    );
    panel.iconPath = new vscode.ThemeIcon('lightbulb-sparkle');
    PlanningPanel.open.set(storyId, new PlanningPanel(panel, session, store, workRoot, ctx));
  }

  private async handle(msg: Inbound): Promise<void> {
    const s = this.session;
    switch (msg.type) {
      case 'ready':
        return this.post();
      case 'understand':
        return this.run(s.state.understanding ? 'Claude relit tes réponses…' : 'Claude lit la story et le code…', (signal) =>
          s.understand(signal)
        );
      case 'answer':
        return this.quiet(() => s.setAnswer(msg.id, msg.answer));
      case 'draft':
        return this.run('Claude rédige le plan…', (signal) => s.draftPlan(signal));
      case 'revise':
        return this.run('Claude reprend la section…', (signal) => s.reviseSection(msg.section, msg.comment, signal));
      case 'reviewed':
        return this.quiet(() => s.setReviewed(msg.section, msg.value));
      case 'reviewAll':
        return this.quiet(() => s.setAllReviewed());
      case 'cancel':
        this.abort?.abort();
        return;
      case 'restart':
        return this.confirmRestart();
      case 'validate':
        return this.validate();
      case 'openStory':
        return this.openFile(s.storyFile);
      case 'openVersion':
        return this.openFile(this.store.versionPath(s.state.storyId, msg.version, 'md'));
      case 'diff':
        return this.diff(msg.from, msg.to);
    }
  }

  /** Un appel à Claude : la page passe en attente, avec un bouton pour annuler. */
  private async run(label: string, action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = label;
    this.error = undefined;
    this.abort = new AbortController();
    await this.post();
    const started = Date.now();
    try {
      await action(this.abort.signal);
      this.ctx.log.info(`Planification ${this.session.state.storyId} : ${label} (${Math.round((Date.now() - started) / 1000)} s).`);
    } catch (err) {
      this.error = describe(err);
      if (!(err instanceof ClaudeError && err.cancelled)) {
        this.ctx.log.error(`Planification ${this.session.state.storyId} : ${this.error}`);
      }
    } finally {
      this.busy = undefined;
      this.abort = undefined;
      await this.post();
    }
  }

  /** Un geste local, sans appel à Claude. */
  private async quiet(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      this.error = undefined;
    } catch (err) {
      this.error = describe(err);
    }
    await this.post();
  }

  private async confirmRestart(): Promise<void> {
    const chosen = await vscode.window.showWarningMessage(
      'Recommencer la planification dans une session neuve ? Les réponses sont effacées ; les versions du plan restent consultables.',
      { modal: true },
      'Recommencer'
    );
    if (chosen === 'Recommencer') {
      await this.quiet(() => this.session.restart());
    }
  }

  private async validate(): Promise<void> {
    const config = readConfig(this.ctx.repoUri);
    let template: string;
    try {
      template = (
        await resolveTemplate('plan', {
          repoRoot: this.ctx.repoUri.fsPath,
          workRoot: this.workRoot,
          setting: config.planningTemplate
        })
      ).content;
    } catch (err) {
      this.error =
        err instanceof TemplateError
          ? `${err.message} Corrige le paramètre devbots.planning.template, ou vide-le pour utiliser templates/plan.md du dossier de travail, sinon le gabarit par défaut.`
          : describe(err);
      await this.post();
      return;
    }
    try {
      const target = await this.session.validate(this.workRoot, template);
      this.error = undefined;
      this.ctx.onChanged();
      await this.post();
      const chosen = await vscode.window.showInformationMessage(
        `Story ${this.session.state.storyId} passée en ready.`,
        'Ouvrir la fiche'
      );
      if (chosen === 'Ouvrir la fiche') {
        await this.openFile(target);
      }
    } catch (err) {
      this.error = describe(err);
      await this.post();
    }
  }

  private async openFile(filePath: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    } catch {
      vscode.window.showWarningMessage(`Fichier introuvable : ${filePath}`);
    }
  }

  private async diff(from: number, to: number): Promise<void> {
    const id = this.session.state.storyId;
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(this.store.versionPath(id, from, 'md')),
      vscode.Uri.file(this.store.versionPath(id, to, 'md')),
      `Plan ${id} : v${from} ↔ v${to}`,
      { viewColumn: vscode.ViewColumn.Beside, preview: true }
    );
  }

  /** L'état complet à afficher. La page ne garde rien d'autre que ses brouillons de saisie. */
  private async post(): Promise<void> {
    const s = this.session;
    const history = await this.store.readHistory(s.state.storyId);
    await this.panel.webview.postMessage({
      type: 'state',
      state: {
        storyId: s.state.storyId,
        title: s.state.title,
        phase: s.state.phase,
        busy: this.busy ?? null,
        error: this.error ?? null,
        hasSession: Boolean(s.state.sessionId),
        resumes: s.state.resumes,
        understanding: s.state.understanding ?? null,
        answers: s.state.answers,
        answersUnsent: s.answersUnsent,
        canDraft: s.canDraft,
        plan: s.currentPlan ?? null,
        criteria: s.context.criteria,
        version: s.currentVersion ?? null,
        versions: s.state.versions,
        checks: s.checks(),
        reviewed: s.state.reviewed,
        sections: PLAN_SECTIONS,
        canValidate: s.canValidate,
        history: history.slice(-30)
      }
    });
  }

  private html(): string {
    const webview = this.panel.webview;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'resources', 'planning');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'planning.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'planning.css'));
    const nonce = makeNonce();
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Plan</title>
</head>
<body>
<main id="app"><p class="muted">Chargement…</p></main>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function describe(err: unknown): string {
  if (err instanceof PlanningError || err instanceof ClaudeError) {
    return err.message;
  }
  if (err instanceof PlanShapeError) {
    return `Réponse de Claude mal formée : ${err.message} Relance l'étape.`;
  }
  return err instanceof Error ? err.message : String(err);
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
