/**
 * Le dev, la supervision et ta revue dans VS Code : commandes, journaux en
 * direct, diff, feu vert, barre d'état et notifications.
 *
 * Mince par construction : l'orchestrateur (`core/orchestrator.ts`) décide de
 * tout ; ce module relaie tes gestes et affiche ce qui se passe.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { verdictLabel, verifyAlreadyDone } from '../core/alreadyDone.js';
import { ClaudeError, createClaudeStreamRunner, type ClaudeStreamRunner } from '../core/claudeCli.js';
import { FlowStateStore, RUNNING_STATUSES, statusLabel, type StoryRun } from '../core/flowState.js';
import { Orchestrator, type DevSettings, type OrchestratorEvent } from '../core/orchestrator.js';
import { safeId } from '../core/planStore.js';
import { dependencyView, schedulable } from '../core/schedule.js';
import { shouldNotify, waitingCount } from '../core/notifications.js';
import { DEFAULT_SUPERVISION_FILE, SUPERVISION_FILE } from '../core/supervision.js';
import { WorkDir, type StoryFile } from '../core/workDir.js';
import type { UsageSnapshot } from '../core/usage.js';
import { readConfig } from '../util/config.js';
import type { FlowNode, StoryNode } from './flowTree.js';
import { GIT_SCHEME, GitContentProvider, openStoryDiff } from './storyDiff.js';

export interface DevContext {
  repoUri: vscode.Uri;
  log: vscode.LogOutputChannel;
  /** Rafraîchit le panneau. */
  refresh: () => void;
  /** Reçoit l'usage de l'abonnement que publient les agents au passage. */
  onUsage?: (snapshot: UsageSnapshot) => void;
}

const MODELS = ['opus', 'sonnet', 'haiku'] as const;

export class DevController implements vscode.Disposable {
  private orchestrator: Orchestrator;
  private workDir: WorkDir;
  private readonly journals = new Map<string, vscode.OutputChannel>();
  /** Les terminaux où tourne l'application d'un worktree en revue. */
  private readonly serveTerminals = new Map<string, vscode.Terminal>();
  /** Les discussions que DevBots ferme lui-même avant une relance : leur fermeture ne propose rien. */
  private readonly closingAgentTerminals = new Set<vscode.Terminal>();
  /** Les stories « déjà faites » dont un agent vérifie le travail en ce moment. */
  private readonly verifying = new Set<string>();
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private badgeView: vscode.TreeView<FlowNode> | undefined;

  constructor(private readonly ctx: DevContext) {
    this.workDir = this.createWorkDir();
    this.orchestrator = this.createOrchestrator();
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.statusBar.command = 'devbots.flow.focus';
    this.disposables.push(
      this.statusBar,
      vscode.window.onDidCloseTerminal((terminal) => {
        for (const [id, t] of this.serveTerminals) {
          if (t === terminal) {
            this.serveTerminals.delete(id);
          }
        }
        void this.onAgentTerminalClosed(terminal);
      })
    );
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
      vscode.commands.registerCommand('devbots.customizeSupervision', () => this.customizeSupervision()),
      vscode.commands.registerCommand('devbots.approve', (node?: FlowNode) => this.approve(node)),
      vscode.commands.registerCommand('devbots.sendFeedback', (node?: FlowNode) => this.sendFeedback(node)),
      vscode.commands.registerCommand('devbots.showDiff', (node?: FlowNode) => this.showDiff(node)),
      vscode.commands.registerCommand('devbots.openWorktree', (node?: FlowNode) => this.openWorktree(node)),
      vscode.commands.registerCommand('devbots.openAgentSession', (node?: FlowNode) => this.openAgentSession(node)),
      vscode.commands.registerCommand('devbots.serveApp', (node?: FlowNode) => this.serveApp(node)),
      vscode.commands.registerCommand('devbots.alreadyDone', (node?: FlowNode) => this.alreadyDone(node)),
      vscode.commands.registerCommand('devbots.openVerification', (node?: FlowNode) => this.openVerification(node)),
      vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContentProvider())
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
    if (story.frontmatter.needs_review === true) {
      const review = 'Voir les changements';
      const chosen = await vscode.window.showWarningMessage(
        `${story.frontmatter.source_id} a changé dans la source depuis sa planification.`,
        { modal: true, detail: 'Le plan a été écrit sur la version précédente de la story.' },
        review,
        'Lancer quand même'
      );
      if (chosen === review) {
        await vscode.commands.executeCommand('devbots.reviewSourceChange', node ?? { kind: 'story', group: 'ready', story });
      }
      if (chosen !== 'Lancer quand même') {
        return;
      }
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
    if (!run || !(await this.closeAgentDiscussion(run.storyId))) {
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
  /* Déjà fait                                                         */
  /* ---------------------------------------------------------------- */

  /** Vrai quand un agent vérifie en ce moment que la story est déjà faite. */
  isVerifying(storyId: string): boolean {
    return this.verifying.has(storyId);
  }

  /**
   * Une story de New ou de Ready dont le dev a été fait hors du flux : elle
   * passe directement dans Done, ou après confirmation par un agent en
   * lecture seule.
   */
  private async alreadyDone(node?: FlowNode): Promise<void> {
    const story = node?.kind === 'story' ? node.story : await this.pickNotStarted('Quelle story est déjà faite ?');
    if (!story) {
      return;
    }
    const id = story.frontmatter.source_id;
    if (story.folder === 'done') {
      vscode.window.showInformationMessage(`${id} est déjà dans Done.`);
      return;
    }
    const run = (await new FlowStateStore(this.workDir.statePath()).read()).stories[id];
    if (run) {
      vscode.window.showInformationMessage(
        `${id} est dans le flux de dev (${statusLabel(run.status)}) : retire-la du flux d'abord.`
      );
      return;
    }
    if (this.verifying.has(id)) {
      vscode.window.showInformationMessage(`Un agent vérifie déjà ${id}.`);
      return;
    }

    const where = story.folder === 'new' ? 'dans New' : 'dans Ready';
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: '$(pass) Passer directement en Done',
          detail: "Sans vérification, sur ta parole. Les stories qui l'attendaient peuvent partir.",
          value: 'direct' as const
        },
        {
          label: '$(search) Faire vérifier par un agent avant',
          detail: `Un agent en lecture seule cherche dans le dépôt (branche extraite, historique git) le code de chaque critère. Done s'il le confirme ; sinon la story reste ${where}, avec son rapport.`,
          value: 'verify' as const
        }
      ],
      { title: `${id} — ${story.title} : déjà fait`, ignoreFocusOut: true }
    );
    if (!choice) {
      return;
    }
    const hint = await vscode.window.showInputBox({
      title: `${id} : où trouver ce travail ? (facultatif)`,
      prompt:
        choice.value === 'verify'
          ? "Aide l'agent à chercher. Vide : il cherche seul. Gardé dans la fiche."
          : 'Gardé dans la fiche, pour mémoire.',
      placeHolder: 'Par exemple : branche feature/login, commit abc1234, PR #12, src/app/auth/',
      ignoreFocusOut: true
    });
    if (hint === undefined) {
      return;
    }
    if (choice.value === 'direct') {
      await this.guard(() => this.markDone(story, 'direct', hint));
    } else {
      await this.verify(story, hint);
    }
  }

  private async markDone(story: StoryFile, how: 'direct' | 'verified', hint: string): Promise<void> {
    await this.workDir.moveToDone(story, {
      done_outside: how,
      done_at: new Date().toISOString(),
      done_note: hint.trim() || undefined
    });
    this.ctx.log.info(
      `${story.frontmatter.source_id} passée dans Done ${how === 'direct' ? 'sur ta parole' : "après vérification par l'agent"}.`
    );
    this.ctx.refresh();
    // Les stories qui l'attendaient peuvent partir.
    await this.orchestrator.pump();
  }

  /** La vérification par un agent, suivie dans une notification qu'on peut annuler et dans le journal. */
  private async verify(story: StoryFile, hint: string): Promise<void> {
    const id = story.frontmatter.source_id;
    this.verifying.add(id);
    this.ctx.refresh();
    (await this.journal(id, true)).show(true);
    const config = readConfig(this.ctx.repoUri);
    try {
      const verification = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `${id} : un agent vérifie le travail déjà fait…`, cancellable: true },
        (_progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          return verifyAlreadyDone(
            {
              repoRoot: this.ctx.repoUri.fsPath,
              workDir: this.workDir,
              stream: this.streamRunner(),
              model: config.supervisionModel,
              onJournal: (storyId, line) => this.journals.get(storyId)?.appendLine(line)
            },
            story,
            hint,
            controller.signal
          );
        }
      );
      // La fiche a pu bouger pendant la vérification : on repart de ce qui est sur disque.
      const current = await this.workDir.findStory(id);
      if (!current || current.folder === 'done') {
        return;
      }
      const level = readConfig(this.ctx.repoUri).notificationLevel;
      if (verification.verdict === 'done') {
        await this.markDone(current, 'verified', hint);
        if (shouldNotify(level, 'verifiedDone')) {
          void vscode.window
            .showInformationMessage(`${id} : l'agent confirme le travail, la story passe dans Done.`, 'Voir le rapport')
            .then((chosen) => chosen && this.openVerification(id));
        }
        return;
      }
      this.ctx.log.info(`${id} : ${verdictLabel(verification.verdict)} d'après l'agent. ${verification.summary}`);
      if (shouldNotify(level, 'verificationRefuted')) {
        const force = 'Passer en Done quand même';
        const chosen = await vscode.window.showWarningMessage(
          `${id} : ${verdictLabel(verification.verdict)} d'après l'agent, la story reste ${current.folder === 'new' ? 'dans New' : 'dans Ready'}. ${verification.summary}`,
          'Voir le rapport',
          force
        );
        if (chosen === 'Voir le rapport') {
          await this.openVerification(id);
        } else if (chosen === force) {
          await this.guard(() => this.markDone(current, 'direct', hint));
        }
      }
    } catch (err) {
      if (err instanceof ClaudeError && err.cancelled) {
        vscode.window.showInformationMessage(`Vérification de ${id} annulée.`);
        return;
      }
      const message = `Vérification de ${id} impossible : ${err instanceof Error ? err.message : String(err)}`;
      this.ctx.log.error(message);
      vscode.window.showErrorMessage(message);
    } finally {
      this.verifying.delete(id);
      this.ctx.refresh();
    }
  }

  /** Le rapport de la vérification « déjà fait », d'après le nœud cliqué ou l'identifiant. */
  private async openVerification(target?: FlowNode | string): Promise<void> {
    const id = typeof target === 'string' ? target : target?.kind === 'story' ? target.story.frontmatter.source_id : undefined;
    if (!id) {
      return;
    }
    const filePath = path.join(this.workDir.runsPath(), safeId(id), 'verification.md');
    try {
      await fs.access(filePath);
    } catch {
      vscode.window.showInformationMessage(`Pas de rapport de vérification pour ${id}.`);
      return;
    }
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(filePath));
  }

  /* ---------------------------------------------------------------- */
  /* Ta revue                                                          */
  /* ---------------------------------------------------------------- */

  private async approve(node?: FlowNode): Promise<void> {
    const run = await this.awaitingReview(node, 'Feu vert pour quelle story ?');
    if (!run) {
      return;
    }
    const changed = (await this.workDir.findStory(run.storyId))?.frontmatter.needs_review === true;
    const confirmed = await vscode.window.showWarningMessage(
      `Feu vert pour ${run.storyId} — ${run.title} ?`,
      {
        modal: true,
        detail: [
          `DevBots intègre ${run.baseBranch} si elle a avancé, puis merge ${run.branch} dans ${run.baseBranch}.`,
          'Le worktree et la branche de la story sont ensuite supprimés, et la fiche passe dans Done.',
          'Tes retouches non commitées du worktree partent avec la story.',
          ...(changed
            ? ['', 'Attention : la story a changé dans la source depuis sa planification (« voir les changements »).']
            : [])
        ].join('\n')
      },
      'Merger'
    );
    if (confirmed !== 'Merger') {
      return;
    }
    // Rien ne doit tenir le worktree ouvert au moment de le supprimer.
    this.releaseWorktree(run);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Merge de ${run.storyId} dans ${run.baseBranch}…` },
      () => this.guard(() => this.orchestrator.approve(run.storyId))
    );
  }

  private async sendFeedback(node?: FlowNode): Promise<void> {
    const run = await this.runFor(node, 'Écrire à l’agent de quelle story ?', (r) =>
      ['awaiting_human', 'blocked'].includes(r.status)
    );
    if (!run) {
      return;
    }
    if (run.status !== 'awaiting_human' && run.status !== 'blocked') {
      vscode.window.showInformationMessage(`${run.storyId} n'attend ni ta revue ni ta réponse (${statusLabel(run.status)}).`);
      return;
    }
    if (!(await this.closeAgentDiscussion(run.storyId))) {
      return;
    }
    const blocked = run.status === 'blocked';
    const feedback = await vscode.window.showInputBox({
      title: `${blocked ? 'Réponse' : 'Retours'} pour ${run.storyId} — ${run.title}`,
      prompt: blocked
        ? `Bloquée : ${run.reason ?? 'sans raison donnée'} — Ta réponse part à un agent neuf, avec la raison du blocage, et la story reprend.`
        : "Tes remarques partent à un agent neuf. La story repasse en dev, puis par la revue du CR et la supervision.",
      placeHolder: blocked
        ? 'Par exemple : j’ai installé les dépendances, relance les tests.'
        : 'Par exemple : le message d’erreur doit citer le champ fautif.',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'Écris au moins une remarque.')
    });
    if (feedback) {
      await this.guard(() => this.orchestrator.sendFeedback(run.storyId, feedback));
    }
  }

  private async showDiff(node?: FlowNode): Promise<void> {
    const run = await this.runFor(node, 'Diff de quelle story ?', (r) =>
      ['awaiting_human', 'merging', 'blocked', 'done'].includes(r.status)
    );
    if (run) {
      await this.guard(async () => {
        await openStoryDiff(run, this.ctx.repoUri.fsPath);
      });
    }
  }

  /**
   * Reprend la session de l'agent de dev dans Claude Code, avec toute sa
   * conversation : `claude --resume` dans un terminal ouvert sur le worktree,
   * en onglet d’éditeur. Tu y travailles sous tes propres permissions. La
   * story ne bouge pas : « Relancer » ou tes retours font repartir un agent
   * neuf, qui retrouve ce qui a changé dans le worktree, pas la conversation.
   *
   * Le panneau de l'extension Claude Code ne retrouve pas ces sessions : nées
   * de `claude -p` dans le worktree, elles n'apparaissent pas dans sa liste,
   * et il en ouvre une neuve à la racine de l'espace de travail.
   */
  private async openAgentSession(node?: FlowNode): Promise<void> {
    const run = await this.runFor(node, 'Discuter avec quel agent ?', (r) =>
      ['blocked', 'awaiting_human'].includes(r.status) && Boolean(r.devSessionId)
    );
    if (!run) {
      return;
    }
    if (RUNNING_STATUSES.includes(run.status) || run.status === 'queued') {
      vscode.window.showInformationMessage(`L'agent de ${run.storyId} travaille : attends qu'il s'arrête, ou arrête-le.`);
      return;
    }
    if (!run.devSessionId || !run.worktree || !(await isDirectory(run.worktree))) {
      vscode.window.showInformationMessage(`L'agent de ${run.storyId} n'a pas de session à reprendre.`);
      return;
    }
    const open = this.agentTerminal(run.storyId);
    if (open) {
      open.show();
      return;
    }
    const exe = readConfig(this.ctx.repoUri).claudeExecutable;
    // En onglet : le fermer n'arrête que ce Claude-là, la session reste sur disque et 💬 la reprend.
    const terminal = vscode.window.createTerminal({
      name: agentTerminalName(run.storyId),
      cwd: run.worktree,
      location: { viewColumn: vscode.ViewColumn.Active }
    });
    terminal.show();
    terminal.sendText(`${/\s/.test(exe) ? `"${exe}"` : exe} --resume ${run.devSessionId}`);
    vscode.window.showInformationMessage(
      run.status === 'blocked'
        ? `DevBots ne lit pas cet échange : la story reste bloquée. Ferme le terminal une fois fini, il te proposera de relancer ${run.storyId}. L'agent qui repartira sera neuf : il verra ce qui a changé dans le worktree, pas votre conversation ; ce qui doit le guider, mets-le dans « Écrire à l'agent ».`
        : `Ce que l'agent change pendant l'échange part avec la story à ton feu vert. Pour refaire passer revue et supervision, écris-lui depuis le clic droit.`
    );
  }

  private async openWorktree(node?: FlowNode): Promise<void> {
    const run = await this.runFor(node, 'Worktree de quelle story ?', (r) => r.status !== 'done' && Boolean(r.worktree));
    if (!run) {
      return;
    }
    if (!run.worktree || !(await isDirectory(run.worktree))) {
      vscode.window.showInformationMessage(`Le worktree de ${run.storyId} n'existe pas (encore).`);
      return;
    }
    const uri = vscode.Uri.file(run.worktree);
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(empty-window) Dans une nouvelle fenêtre', value: 'window' as const },
        { label: '$(terminal) Dans un terminal', detail: run.worktree, value: 'terminal' as const },
        { label: '$(folder) Dans l’explorateur de fichiers', value: 'reveal' as const },
        {
          label: "$(root-folder) Ajouté à l'espace de travail",
          detail: "Une fenêtre à un seul dossier devient un espace de travail multi-racine : VS Code recharge les extensions.",
          value: 'workspace' as const
        }
      ],
      { title: `Ouvrir le worktree de ${run.storyId}` }
    );
    if (choice?.value === 'window') {
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
    } else if (choice?.value === 'terminal') {
      vscode.window.createTerminal({ name: `DevBots · ${run.storyId}`, cwd: run.worktree }).show();
    } else if (choice?.value === 'reveal') {
      await vscode.commands.executeCommand('revealFileInOS', uri);
    } else if (choice?.value === 'workspace') {
      if (this.workspaceFolderIndex(run.worktree) < 0) {
        const count = vscode.workspace.workspaceFolders?.length ?? 0;
        vscode.workspace.updateWorkspaceFolders(count, 0, { uri, name: `${run.storyId} · worktree` });
      }
    }
  }

  /** L'application du worktree, sur un port qui lui est propre, dans un terminal. */
  private async serveApp(node?: FlowNode): Promise<void> {
    const run = await this.awaitingReview(node, "Application de quelle story ?");
    if (!run) {
      return;
    }
    const config = readConfig(this.ctx.repoUri);
    if (!config.reviewServeCommand) {
      vscode.window.showInformationMessage('Aucune commande de lancement : renseigne devbots.review.serveCommand.');
      return;
    }
    const port = await this.orchestrator.assignPort(run.storyId, config.reviewBasePort);
    let terminal = this.serveTerminals.get(run.storyId);
    if (!terminal) {
      terminal = vscode.window.createTerminal({ name: `DevBots · ${run.storyId} :${port}`, cwd: run.worktree });
      this.serveTerminals.set(run.storyId, terminal);
      terminal.sendText(config.reviewServeCommand.split('{port}').join(String(port)));
    }
    terminal.show(true);
    const chosen = await vscode.window.showInformationMessage(
      `${run.storyId} se lance sur le port ${port}.`,
      'Ouvrir dans le navigateur'
    );
    if (chosen) {
      await vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`));
    }
  }

  /** Une story « À valider », d'après le nœud cliqué ou un choix dans la liste. */
  private async awaitingReview(node: FlowNode | undefined, title: string): Promise<StoryRun | undefined> {
    const run = await this.runFor(node, title, (r) => r.status === 'awaiting_human');
    if (run && run.status !== 'awaiting_human') {
      vscode.window.showInformationMessage(`${run.storyId} n'attend pas ta revue (${statusLabel(run.status)}).`);
      return undefined;
    }
    return run;
  }

  /** Ferme ce qui tient le worktree : le terminal de l'application, le dossier dans l'espace de travail. */
  private releaseWorktree(run: StoryRun): void {
    this.serveTerminals.get(run.storyId)?.dispose();
    this.serveTerminals.delete(run.storyId);
    const index = this.workspaceFolderIndex(run.worktree);
    if (index >= 0) {
      vscode.workspace.updateWorkspaceFolders(index, 1);
    }
  }

  private workspaceFolderIndex(dir: string): number {
    const target = path.resolve(dir).toLowerCase();
    return (vscode.workspace.workspaceFolders ?? []).findIndex((f) => path.resolve(f.uri.fsPath).toLowerCase() === target);
  }

  /* ---------------------------------------------------------------- */
  /* Affichage                                                         */
  /* ---------------------------------------------------------------- */

  private onEvent(event: OrchestratorEvent): void {
    this.ctx.refresh();
    void this.updateStatusBar();
    if (event.kind === 'changed') {
      return;
    }
    const kind = event.kind === 'merged' && event.warning ? 'mergedWithWarning' : event.kind;
    if (!shouldNotify(readConfig(this.ctx.repoUri).notificationLevel, kind)) {
      return;
    }
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
    } else if (event.kind === 'merged') {
      const message = `${event.storyId} — ${event.title} mergée dans ${event.into}.`;
      if (event.warning) {
        void vscode.window.showWarningMessage(`${message} ${event.warning}`);
      } else {
        void vscode.window.showInformationMessage(message);
      }
    } else if (event.kind === 'returned' || event.kind === 'mergeFailed') {
      const message =
        event.kind === 'returned'
          ? `${event.storyId} renvoyée à l'agent : ${event.reason}.`
          : `${event.storyId} reste à valider. ${event.reason}`;
      void vscode.window.showWarningMessage(message, 'Voir le journal').then((chosen) => {
        if (chosen) {
          void this.showJournal(this.fakeNode(event.storyId));
        }
      });
    } else if (event.kind === 'blocked') {
      void vscode.window
        .showWarningMessage(`${event.storyId} bloquée : ${event.reason}`, 'Discuter', 'Répondre', 'Voir le journal', 'Relancer')
        .then((chosen) => {
          const node = this.fakeNode(event.storyId);
          if (chosen === 'Répondre') {
            void this.sendFeedback(node);
          } else if (chosen === 'Discuter') {
            void this.openAgentSession(node);
          } else if (chosen === 'Voir le journal') {
            void this.showJournal(node);
          } else if (chosen === 'Relancer') {
            void this.retryDev(node);
          }
        });
    }
  }

  /** Le panneau dont l'icône porte le badge des stories qui t'attendent. */
  setBadgeView(view: vscode.TreeView<FlowNode>): void {
    this.badgeView = view;
    void this.updateStatusBar();
  }

  /** Barre d'état et badge, relus sur disque : à appeler quand `.work` change. */
  updateIndicators(): void {
    void this.updateStatusBar();
  }

  private async updateStatusBar(): Promise<void> {
    const state = await new FlowStateStore(this.workDir.statePath()).read().catch(() => undefined);
    const runs = Object.values(state?.stories ?? {});
    await this.updateBadge(runs);
    const active = this.orchestrator.activeIds.length;
    const queued = runs.filter((r) => r.status === 'queued').length;
    const waiting = runs.filter((r) => r.status === 'awaiting_human' || r.status === 'merging').length;
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

  private async updateBadge(runs: StoryRun[]): Promise<void> {
    if (!this.badgeView) {
      return;
    }
    const flagged = [...(await this.workDir.indexBySourceId().catch(() => new Map<string, StoryFile>())).values()]
      .filter((s) => s.folder !== 'done' && s.frontmatter.needs_review === true)
      .map((s) => s.frontmatter.source_id);
    const count = waitingCount(runs, flagged);
    this.badgeView.badge =
      count > 0
        ? { value: count, tooltip: `${count} story(s) t'attendent : à valider, bloquées ou à revoir` }
        : undefined;
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
      stream: (request) => this.streamRunner()(request),
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
          maxLoops: c.supervisionMaxLoops,
          mergeChecks: c.mergeCheckCommands,
          checkCommands: c.devCheckCommands,
          correctionMaxTurns: c.devCorrectionMaxTurns,
          storyBudgetUsd: c.storyBudgetUsd
        };
      },
      onJournal: (storyId, line) => {
        // Un journal déjà ouvert suit en direct ; les autres se lisent sur disque à l'ouverture.
        this.journals.get(storyId)?.appendLine(line);
      },
      onEvent: (event) => this.onEvent(event)
    });
  }

  /** Le lanceur des agents, relu à chaque appel : le chemin du CLI peut changer entre deux. */
  private streamRunner(): ClaudeStreamRunner {
    return createClaudeStreamRunner(readConfig(this.ctx.repoUri).claudeExecutable, this.ctx.onUsage);
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

  /** Une story de New ou de Ready qui n'est pas partie en dev. */
  private async pickNotStarted(title: string): Promise<StoryFile | undefined> {
    const state = await new FlowStateStore(this.workDir.statePath()).read();
    const stories = [...(await this.workDir.listStories('new')), ...(await this.workDir.listStories('ready'))].filter(
      (s) => !state.stories[s.frontmatter.source_id]
    );
    if (stories.length === 0) {
      vscode.window.showInformationMessage('Aucune story dans New ou Ready.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      stories.map((story) => ({
        label: `${story.frontmatter.source_id} — ${story.title}`,
        description: story.folder === 'new' ? 'New' : 'Ready',
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
  private agentTerminal(storyId: string): vscode.Terminal | undefined {
    return vscode.window.terminals.find((t) => t.name === agentTerminalName(storyId));
  }

  /**
   * Fin d'une discussion avec l'agent : DevBots n'a rien vu de l'échange, et
   * une story bloquée le reste tant qu'on ne la relance pas. On le propose.
   */
  private async onAgentTerminalClosed(terminal: vscode.Terminal): Promise<void> {
    if (this.closingAgentTerminals.delete(terminal)) {
      return;
    }
    const storyId = storyIdOfAgentTerminal(terminal.name);
    if (!storyId) {
      return;
    }
    const state = await new FlowStateStore(this.workDir.statePath()).read().catch(() => undefined);
    if (state?.stories[storyId]?.status !== 'blocked') {
      return;
    }
    const chosen = await vscode.window.showInformationMessage(
      `Discussion avec l'agent de ${storyId} fermée. La story est toujours bloquée : la relancer ? Un agent neuf repartira du worktree tel que vous l'avez laissé.`,
      'Relancer'
    );
    if (chosen === 'Relancer') {
      await this.retryDev(this.fakeNode(storyId));
    }
  }

  /**
   * Avant une relance ou une réponse : deux Claude dans le même worktree se
   * marcheraient dessus. Rend faux si la discussion reste ouverte.
   */
  private async closeAgentDiscussion(storyId: string): Promise<boolean> {
    const terminal = this.agentTerminal(storyId);
    if (!terminal) {
      return true;
    }
    const close = 'Fermer la discussion et continuer';
    const chosen = await vscode.window.showWarningMessage(
      `La discussion avec l'agent de ${storyId} est encore ouverte dans un terminal, sur le même worktree. Elle doit être fermée avant que l'agent reparte.`,
      { modal: true },
      close
    );
    if (chosen !== close) {
      return false;
    }
    this.closingAgentTerminals.add(terminal);
    terminal.dispose();
    return true;
  }

  private fakeNode(storyId: string): StoryNode {
    return {
      kind: 'story',
      group: 'dev',
      story: { filePath: '', folder: 'ready', title: storyId, frontmatter: { source_id: storyId } }
    };
  }
}

const AGENT_TERMINAL_PREFIX = 'Claude · ';

function agentTerminalName(storyId: string): string {
  return `${AGENT_TERMINAL_PREFIX}${storyId}`;
}

function storyIdOfAgentTerminal(name: string): string | undefined {
  return name.startsWith(AGENT_TERMINAL_PREFIX) ? name.slice(AGENT_TERMINAL_PREFIX.length) : undefined;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
