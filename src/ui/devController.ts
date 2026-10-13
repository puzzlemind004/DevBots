/**
 * Le dev et la supervision dans VS Code : commandes, journaux en direct, barre
 * d'état et notifications.
 *
 * Mince par construction : l'orchestrateur (`core/orchestrator.ts`) décide de
 * tout ; ce module relaie tes gestes et affiche ce qui se passe.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createClaudeStreamRunner } from '../core/claudeCli.js';
import { FlowStateStore, statusLabel, type StoryRun } from '../core/flowState.js';
import { Orchestrator, type DevSettings, type OrchestratorEvent } from '../core/orchestrator.js';
import { safeId } from '../core/planStore.js';
import { dependencyView, schedulable } from '../core/schedule.js';
import { DEFAULT_SUPERVISION_FILE, SUPERVISION_FILE } from '../core/supervision.js';
import { WorkDir, type StoryFile } from '../core/workDir.js';
import { readConfig } from '../util/config.js';
import type { FlowNode, StoryNode } from './flowTree.js';

export interface DevContext {
  repoUri: vscode.Uri;
  log: vscode.LogOutputChannel;
  /** Rafraîchit le panneau. */
  refresh: () => void;
}

const MODELS = ['opus', 'sonnet', 'haiku'] as const;

export class DevController implements vscode.Disposable {
  private orchestrator: Orchestrator;
  private workDir: WorkDir;
  private readonly journals = new Map<string, vscode.OutputChannel>();
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: DevContext) {
    this.workDir = this.createWorkDir();
    this.orchestrator = this.createOrchestrator();
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.statusBar.command = 'devbots.flow.focus';
    this.disposables.push(this.statusBar);
  }

  /** Au démarrage : bloque les stories orphelines d'une fenêtre fermée, puis relance la file. */
  async start(): Promise<void> {
    const interrupted = await this.orchestrator.recover();
    if (interrupted.length > 0) {
      const chosen = await vscode.window.showWarningMessage(
        `${interrupted.length} story(s) interrompue(s) par la fermeture de VS Code : ${interrupted.join(', ')}. Leur worktree est intact.`,
        'Tout relancer'
      );
      if (chosen === 'Tout relancer') {
        for (const id of interrupted) {
          await this.guard(() => this.orchestrator.retry(id));
        }
      }
    }
    await this.orchestrator.pump();
    await this.updateStatusBar();
  }

  /** Le dossier du flux a changé : on suit, si aucun agent ne tourne. */
  onWorkDirChanged(): void {
    if (this.orchestrator.activeIds.length > 0) {
      this.ctx.log.warn('Dossier du flux modifié pendant que des agents tournent : effet au prochain redémarrage.');
      return;
    }
    this.workDir = this.createWorkDir();
    this.orchestrator = this.createOrchestrator();
  }

  register(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand('devbots.startDev', (node?: FlowNode) => this.startDev(node)),
      vscode.commands.registerCommand('devbots.stopDev', (node?: FlowNode) => this.stopDev(node)),
      vscode.commands.registerCommand('devbots.retryDev', (node?: FlowNode) => this.retryDev(node)),
      vscode.commands.registerCommand('devbots.dequeue', (node?: FlowNode) => this.dequeue(node)),
      vscode.commands.registerCommand('devbots.showJournal', (node?: FlowNode) => this.showJournal(node)),
      vscode.commands.registerCommand('devbots.openReport', (node?: FlowNode) => this.openRunFile(node, 'report.md')),
      vscode.commands.registerCommand('devbots.openCr', (node?: FlowNode) => this.openRunFile(node, 'cr.md')),
      vscode.commands.registerCommand('devbots.decideDependency', (node?: FlowNode) => this.decideDependency(node)),
      vscode.commands.registerCommand('devbots.reclassify', (node?: FlowNode) => this.reclassify(node)),
      vscode.commands.registerCommand('devbots.customizeSupervision', () => this.customizeSupervision())
    ];
  }

  dispose(): void {
    // Les agents meurent avec la fenêtre ; `recover` les bloquera au prochain démarrage.
    this.orchestrator.stopAll();
    for (const channel of this.journals.values()) {
      channel.dispose();
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Commandes                                                         */
  /* ---------------------------------------------------------------- */

  private async startDev(node?: FlowNode): Promise<void> {
    const story = node?.kind === 'story' ? node.story : await this.pickStory('ready', 'Quelle story lancer ?');
    if (!story) {
      return;
    }
    if (story.folder !== 'ready') {
      vscode.window.showInformationMessage('Seules les stories de Ready partent en dev.');
      return;
    }
    const config = readConfig(this.ctx.repoUri);
    const recommended = config.devModel || story.frontmatter.recommended_model || 'sonnet';
    const model = await this.pickModel(recommended, `Modèle de l'agent pour ${story.frontmatter.source_id}`);
    if (!model) {
      return;
    }
    await this.guard(() => this.orchestrator.enqueue(story.frontmatter.source_id, model));
  }

  private async stopDev(node?: FlowNode): Promise<void> {
    const run = await this.runFor(node, 'Quelle story arrêter ?', (r) => this.orchestrator.activeIds.includes(r.storyId));
    if (run && !this.orchestrator.stop(run.storyId)) {
      vscode.window.showInformationMessage(`Aucun agent ne tourne pour ${run.storyId}.`);
    }
  }

  private async retryDev(node?: FlowNode): Promise<void> {
    const run = await this.runFor(node, 'Quelle story relancer ?', (r) => r.status === 'blocked');
    if (!run) {
      return;
    }
    const model = await this.pickModel(run.model, `Modèle de l'agent pour ${run.storyId}`);
    if (model) {
      await this.guard(() => this.orchestrator.retry(run.storyId, model));
    }
  }

  private async dequeue(node?: FlowNode): Promise<void> {
    const run = await this.runFor(node, 'Quelle story retirer du flux ?', (r) =>
      ['queued', 'blocked', 'awaiting_human'].includes(r.status)
    );
    if (!run) {
      return;
    }
    const detail = run.worktree
      ? `Elle revient dans Ready. Son worktree (${run.worktree}) et sa branche ${run.branch} restent en place.`
      : 'Elle revient dans Ready.';
    const confirmed = await vscode.window.showWarningMessage(
      `Retirer ${run.storyId} du flux de dev ?`,
      { modal: true, detail },
      'Retirer'
    );
    if (confirmed === 'Retirer') {
      await this.guard(() => this.orchestrator.dequeue(run.storyId));
    }
  }

  private async showJournal(node?: FlowNode): Promise<void> {
    const run = await this.runFor(node, 'Journal de quelle story ?', () => true);
    if (run) {
      (await this.journal(run.storyId, true)).show(true);
    }
  }

  private async openRunFile(node: FlowNode | undefined, name: 'report.md' | 'cr.md'): Promise<void> {
    const run = await this.runFor(node, name === 'cr.md' ? 'CR de quelle story ?' : 'Rapport de quelle story ?', () => true);
    if (!run) {
      return;
    }
    const filePath = path.join(this.workDir.runsPath(), safeId(run.storyId), name);
    try {
      await fs.access(filePath);
    } catch {
      vscode.window.showInformationMessage(
        name === 'cr.md' ? `Pas encore de CR pour ${run.storyId}.` : `Pas encore de rapport pour ${run.storyId}.`
      );
      return;
    }
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(filePath));
  }

  /**
   * Trancher sur une dépendance déclarée : l'attendre ou la lever, quel que
   * soit le verdict du plan.
   */
  private async decideDependency(node?: FlowNode): Promise<void> {
    const story = node?.kind === 'story' ? node.story : await this.pickStory('ready', 'Dépendances de quelle story ?');
    if (!story) {
      return;
    }
    const id = story.frontmatter.source_id;
    const state = await new FlowStateStore(this.workDir.statePath()).read();
    const overrides = state.dependencyOverrides[id] ?? {};
    const sched = schedulable(story.frontmatter);
    const view = dependencyView(sched, overrides);
    const all = [...view.waitOn, ...view.parallelizable, ...view.ignored];
    if (all.length === 0) {
      vscode.window.showInformationMessage(`La story ${id} ne déclare aucune dépendance.`);
      return;
    }

    interface DepPick extends vscode.QuickPickItem {
      dep: string;
    }
    const verdict = (dep: string): string =>
      sched.confirmed.includes(dep)
        ? 'confirmée par le plan'
        : sched.refuted.includes(dep)
          ? "parallélisable d'après le code"
          : 'déclarée, sans verdict';
    const picked = await vscode.window.showQuickPick<DepPick>(
      all.map((dep) => ({
        dep,
        label: dep,
        description: view.waitOn.includes(dep) ? 'attendue' : view.ignored.includes(dep) ? 'levée par toi' : 'non attendue',
        detail: `${verdict(dep)}${overrides[dep] ? ' · ton arbitrage' : ''}`
      })),
      { title: `Dépendances de ${id}` }
    );
    if (!picked) {
      return;
    }
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Attendre cette dépendance', value: 'wait' as const },
        { label: 'Ne pas l’attendre', value: 'ignore' as const },
        { label: 'Revenir au verdict du plan', value: undefined }
      ],
      { title: `${id} → ${picked.dep}` }
    );
    if (choice) {
      await this.guard(() => this.orchestrator.setDependencyOverride(id, picked.dep, choice.value));
    }
  }

  /** Une fiche née du tri change de file : à planifier (New) ou prête (Ready). */
  private async reclassify(node?: FlowNode): Promise<void> {
    if (node?.kind !== 'story' || !node.story.frontmatter.origin || (node.group !== 'new' && node.group !== 'ready')) {
      vscode.window.showInformationMessage('Seules les fiches nées du tri, en New ou en Ready, se reclassent.');
      return;
    }
    const story = node.story;
    const target = node.group === 'new' ? 'ready' : 'new';
    const destination = path.join(this.workDir.folderPath(target), path.basename(story.filePath));
    await this.guard(async () => {
      await fs.rename(story.filePath, destination);
      this.ctx.log.info(`${story.frontmatter.source_id} reclassée dans ${target}/.`);
      this.ctx.refresh();
    });
  }

  private async customizeSupervision(): Promise<void> {
    const filePath = path.join(this.workDir.rootPath, SUPERVISION_FILE);
    try {
      await fs.mkdir(this.workDir.rootPath, { recursive: true });
      await fs.writeFile(filePath, DEFAULT_SUPERVISION_FILE, { encoding: 'utf8', flag: 'wx' });
      vscode.window.showInformationMessage(
        `${SUPERVISION_FILE} déposé : pre-pr-check, et un exemple d'agent désactivé à adapter.`
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        vscode.window.showErrorMessage(`Impossible d'écrire ${SUPERVISION_FILE} : ${(err as Error).message}`);
        return;
      }
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(filePath)));
  }

  /* ---------------------------------------------------------------- */
  /* Affichage                                                         */
  /* ---------------------------------------------------------------- */

  private onEvent(event: OrchestratorEvent): void {
    this.ctx.refresh();
    void this.updateStatusBar();
    if (event.kind === 'awaitingHuman') {
      void vscode.window
        .showInformationMessage(`${event.storyId} — ${event.title} attend ta revue.`, 'Voir le rapport', 'Voir le CR')
        .then((chosen) => {
          const node = this.fakeNode(event.storyId);
          if (chosen === 'Voir le rapport') {
            void this.openRunFile(node, 'report.md');
          } else if (chosen === 'Voir le CR') {
            void this.openRunFile(node, 'cr.md');
          }
        });
    } else if (event.kind === 'blocked') {
      void vscode.window
        .showWarningMessage(`${event.storyId} bloquée : ${event.reason}`, 'Voir le journal', 'Relancer')
        .then((chosen) => {
          const node = this.fakeNode(event.storyId);
          if (chosen === 'Voir le journal') {
            void this.showJournal(node);
          } else if (chosen === 'Relancer') {
            void this.retryDev(node);
          }
        });
    }
  }

  private async updateStatusBar(): Promise<void> {
    const state = await new FlowStateStore(this.workDir.statePath()).read().catch(() => undefined);
    const runs = Object.values(state?.stories ?? {});
    const active = this.orchestrator.activeIds.length;
    const queued = runs.filter((r) => r.status === 'queued').length;
    const waiting = runs.filter((r) => r.status === 'awaiting_human').length;
    if (active + queued + waiting === 0) {
      this.statusBar.hide();
      return;
    }
    const parts = [`$(hubot) ${active} agent${active > 1 ? 's' : ''}`];
    if (queued > 0) {
      parts.push(`${queued} en file`);
    }
    if (waiting > 0) {
      parts.push(`$(bell-dot) ${waiting} à valider`);
    }
    this.statusBar.text = parts.join(' · ');
    this.statusBar.tooltip = `DevBots : ${active} agent(s) actif(s) sur ${readConfig(this.ctx.repoUri).maxParallelAgents} au plus.`;
    this.statusBar.show();
  }

  /**
   * Le journal d'une story. Créé à la demande : il reprend alors ce que le
   * fichier `journal.log` contient déjà, puis suit en direct.
   */
  private async journal(storyId: string, backfill: boolean): Promise<vscode.OutputChannel> {
    let channel = this.journals.get(storyId);
    if (channel) {
      return channel;
    }
    channel = vscode.window.createOutputChannel(`DevBots · ${storyId}`);
    this.journals.set(storyId, channel);
    if (backfill) {
      try {
        channel.append(await fs.readFile(path.join(this.workDir.runsPath(), safeId(storyId), 'journal.log'), 'utf8'));
      } catch {
        // Pas encore de journal.
      }
    }
    return channel;
  }

  /* ---------------------------------------------------------------- */
  /* Mécanique                                                         */
  /* ---------------------------------------------------------------- */

  private createWorkDir(): WorkDir {
    return new WorkDir(vscode.Uri.joinPath(this.ctx.repoUri, readConfig(this.ctx.repoUri).workDir).fsPath);
  }

  private createOrchestrator(): Orchestrator {
    const repoUri = this.ctx.repoUri;
    return new Orchestrator({
      repoRoot: repoUri.fsPath,
      workDir: this.workDir,
      store: new FlowStateStore(this.workDir.statePath()),
      stream: (request) => createClaudeStreamRunner(readConfig(repoUri).claudeExecutable)(request),
      settings: (): DevSettings => {
        const c = readConfig(repoUri);
        return {
          maxParallel: c.maxParallelAgents,
          devSkill: c.devSkill,
          allowedCommands: c.devAllowedCommands,
          worktreeRoot: c.worktreeRoot,
          baseBranch: c.gitBaseBranch,
          installCommand: c.devInstallCommand,
          rulesFile: c.devRulesFile,
          reviewModel: c.supervisionModel,
          maxLoops: c.supervisionMaxLoops
        };
      },
      onJournal: (storyId, line) => {
        // Un journal déjà ouvert suit en direct ; les autres se lisent sur disque à l'ouverture.
        this.journals.get(storyId)?.appendLine(line);
      },
      onEvent: (event) => this.onEvent(event)
    });
  }

  private async guard(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.log.error(message);
      vscode.window.showErrorMessage(message);
    } finally {
      this.ctx.refresh();
      void this.updateStatusBar();
    }
  }

  /** La story visée par une commande : le nœud cliqué, sinon un choix dans la liste. */
  private async runFor(
    node: FlowNode | undefined,
    title: string,
    filter: (run: StoryRun) => boolean
  ): Promise<StoryRun | undefined> {
    const state = await new FlowStateStore(this.workDir.statePath()).read();
    if (node?.kind === 'story') {
      const run = state.stories[node.story.frontmatter.source_id];
      if (!run) {
        vscode.window.showInformationMessage(`${node.story.frontmatter.source_id} n'est pas partie en dev.`);
      }
      return run;
    }
    const runs = Object.values(state.stories).filter(filter);
    if (runs.length === 0) {
      vscode.window.showInformationMessage('Aucune story concernée.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      runs.map((run) => ({ label: `${run.storyId} — ${run.title}`, description: statusLabel(run.status), run })),
      { title }
    );
    return picked?.run;
  }

  private async pickStory(folder: 'ready', title: string): Promise<StoryFile | undefined> {
    const state = await new FlowStateStore(this.workDir.statePath()).read();
    const stories = (await this.workDir.listStories(folder)).filter((s) => !state.stories[s.frontmatter.source_id]);
    if (stories.length === 0) {
      vscode.window.showInformationMessage('Aucune story prête dans Ready.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      stories.map((story) => ({
        label: `${story.frontmatter.source_id} — ${story.title}`,
        description: story.frontmatter.recommended_model,
        story
      })),
      { title }
    );
    return picked?.story;
  }

  private async pickModel(recommended: string, title: string): Promise<string | undefined> {
    const items = [recommended, ...MODELS.filter((m) => m !== recommended)].map((model) => ({
      label: model,
      description: model === recommended ? 'recommandé' : undefined
    }));
    const picked = await vscode.window.showQuickPick(items, { title, ignoreFocusOut: true });
    return picked?.label;
  }

  /** Un nœud minimal pour rejouer une commande depuis une notification. */
  private fakeNode(storyId: string): StoryNode {
    return {
      kind: 'story',
      group: 'dev',
      story: { filePath: '', folder: 'ready', title: storyId, frontmatter: { source_id: storyId } }
    };
  }
}
