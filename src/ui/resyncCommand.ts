/**
 * La resynchronisation dans VS Code : à la demande, ou en arrière-plan selon
 * `devbots.sync.intervalMinutes`, puis ta décision sur chaque story « à revoir ».
 *
 * La logique vit dans `core/resync.ts` ; ce module relaie et affiche.
 */

import { promises as fs } from 'node:fs';
import matter from 'gray-matter';
import * as vscode from 'vscode';
import { FlowStateStore, statusLabel } from '../core/flowState.js';
import { shouldNotify } from '../core/notifications.js';
import { PlanStore } from '../core/planStore.js';
import { freshChanges, replanFromSource, resyncStories, type ResyncReport } from '../core/resync.js';
import { WorkDir, type StoryFile } from '../core/workDir.js';
import { createSource } from '../sources/factory.js';
import { readConfig, sourceLabel } from '../util/config.js';
import type { FlowNode, StoryNode } from './flowTree.js';
import { reportError } from './importCommand.js';

export interface ResyncContext {
  repoUri: vscode.Uri;
  secrets: vscode.SecretStorage;
  log: vscode.LogOutputChannel;
  /** Rafraîchit le panneau et ses indicateurs. */
  refresh: () => void;
}

export class SourceSync implements vscode.Disposable {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Une seule resynchronisation à la fois, qu'elle vienne de toi ou du minuteur. */
  private running = false;

  constructor(private readonly ctx: ResyncContext) {}

  register(): vscode.Disposable[] {
    this.schedule();
    return [
      vscode.commands.registerCommand('devbots.resync', () => this.run(true)),
      vscode.commands.registerCommand('devbots.reviewSourceChange', (node?: FlowNode) => this.reviewChange(node)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('devbots.sync.intervalMinutes', this.ctx.repoUri)) {
          this.schedule();
        }
      })
    ];
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** (Re)lance le minuteur d'après le paramètre ; 0 l'arrête. */
  private schedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const minutes = readConfig(this.ctx.repoUri).syncIntervalMinutes;
    if (minutes > 0) {
      this.timer = setInterval(() => void this.run(false), Math.max(5, minutes) * 60_000);
      this.ctx.log.info(`Resynchronisation avec la source toutes les ${Math.max(5, minutes)} min.`);
    }
  }

  /**
   * @param interactive Vrai quand tu l'as demandée : progression, bilan et
   *   erreurs à l'écran. En arrière-plan, seul un changement nouveau se signale.
   */
  async run(interactive: boolean): Promise<void> {
    if (this.running) {
      if (interactive) {
        vscode.window.showInformationMessage('Une resynchronisation est déjà en cours.');
      }
      return;
    }
    this.running = true;
    const config = readConfig(this.ctx.repoUri);
    const label = sourceLabel(config.sourceKind);
    const workDir = this.workDir();
    try {
      const report = interactive
        ? await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Resynchronisation avec ${label}`, cancellable: true },
            async (progress, token) => {
              progress.report({ message: 'connexion…' });
              const source = await createSource(config, this.ctx.secrets, this.ctx.repoUri.fsPath);
              progress.report({ message: 'lecture des stories…' });
              return resyncStories(workDir, source, token);
            }
          )
        : await resyncStories(
            workDir,
            await createSource(config, this.ctx.secrets, this.ctx.repoUri.fsPath, false)
          );
      this.ctx.refresh();
      this.log(report, config.sourceKind);
      if (interactive) {
        this.reportInteractive(report, label);
      } else {
        this.reportBackground(report, label);
      }
    } catch (err) {
      if (interactive) {
        await reportError(err, this.ctx.log, 'Resynchronisation impossible');
      } else {
        // En arrière-plan, une source injoignable ne mérite pas une fenêtre à chaque passage.
        this.ctx.log.warn(`Resynchronisation : ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      this.running = false;
    }
  }

  private log(report: ResyncReport, source: string): void {
    for (const r of report.results) {
      if (r.outcome !== 'unchanged') {
        this.ctx.log.info(`[${source}] resynchronisation ${r.sourceId} ${r.outcome} — ${r.title}`);
      }
    }
    if (report.missing.length > 0) {
      this.ctx.log.warn(`[${source}] absentes de la source ou écartées : ${report.missing.join(', ')}`);
    }
    if (report.closed.length > 0) {
      this.ctx.log.info(`[${source}] fermées dans la source : ${report.closed.join(', ')}`);
    }
  }

  private reportInteractive(report: ResyncReport, label: string): void {
    const updated = report.results.filter((r) => r.outcome === 'updated').length;
    const review = report.results.filter((r) => r.outcome === 'needsReview').map((r) => r.sourceId);
    if (report.results.length === 0 && report.missing.length === 0) {
      vscode.window.showInformationMessage(`Aucune story de ${label} à relire dans New ou Ready.`);
      return;
    }
    const parts = [`${report.results.length} story(s) relue(s)`];
    if (updated > 0) {
      parts.push(`${updated} fiche(s) de New mise(s) à jour`);
    }
    if (report.missing.length > 0) {
      parts.push(`${report.missing.length} introuvable(s) : ${report.missing.join(', ')}`);
    }
    if (report.closed.length > 0) {
      parts.push(`fermée(s) dans ${label} : ${report.closed.join(', ')}`);
    }
    const summary = `Resynchronisation terminée : ${parts.join(', ')}.`;
    if (review.length > 0) {
      void vscode.window.showWarningMessage(
        `${summary} À revoir, elles ont changé depuis leur planification : ${review.join(', ')}.`,
        ...(review.length === 1 ? ['Voir les changements'] : [])
      ).then((chosen) => {
        if (chosen) {
          void this.reviewChange(undefined, review[0]);
        }
      });
    } else if (report.missing.length > 0) {
      vscode.window.showWarningMessage(summary);
    } else {
      vscode.window.showInformationMessage(summary);
    }
  }

  private reportBackground(report: ResyncReport, label: string): void {
    const fresh = freshChanges(report);
    if (fresh.length === 0 || !shouldNotify(readConfig(this.ctx.repoUri).notificationLevel, 'sourceChanged')) {
      return;
    }
    const ids = fresh.map((r) => r.sourceId);
    void vscode.window
      .showWarningMessage(
        fresh.length === 1
          ? `${ids[0]} — ${fresh[0]?.title} a changé dans ${label} depuis sa planification.`
          : `${fresh.length} stories ont changé dans ${label} depuis leur planification : ${ids.join(', ')}.`,
        'Voir les changements'
      )
      .then((chosen) => {
        if (chosen) {
          void this.reviewChange(undefined, fresh.length === 1 ? ids[0] : undefined);
        }
      });
  }

  /**
   * Montre ce qui a changé dans la source, puis te laisse décider : garder le
   * plan (le changement est sans effet), ou replanifier (la story revient dans
   * New, l'atelier rouvre).
   */
  private async reviewChange(node?: FlowNode, storyId?: string): Promise<void> {
    const workDir = this.workDir();
    const story = node?.kind === 'story' ? node.story : await this.pickFlagged(workDir, storyId);
    if (!story) {
      return;
    }
    const id = story.frontmatter.source_id;
    const incoming = workDir.incomingPath(id);
    if (!(await exists(incoming))) {
      const chosen = await vscode.window.showInformationMessage(
        `La version reçue de la source pour ${id} n'est pas encore enregistrée : la resynchronisation la récupère.`,
        'Resynchroniser'
      );
      if (chosen) {
        await this.run(true);
      }
      return;
    }
    // Sans référence (story importée avant la resynchronisation), la fiche elle-même sert de point de départ.
    const reference = (await exists(workDir.referencePath(id))) ? workDir.referencePath(id) : story.filePath;
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(reference),
      vscode.Uri.file(incoming),
      `${id} : planifiée ↔ source aujourd'hui`,
      { preview: true }
    );

    const run = (await new FlowStateStore(workDir.statePath()).read()).stories[id];
    const canReplan = story.folder === 'ready' && !run;
    const keep = 'Garder le plan';
    const replan = 'Replanifier';
    const openSource = 'Ouvrir dans la source';
    // La révision bouge aussi pour ce que la fiche ne reprend pas : commentaire, assignation…
    const sameCard =
      reference !== story.filePath &&
      body(await fs.readFile(reference, 'utf8')) === body(await fs.readFile(incoming, 'utf8'));
    const where = sameCard
      ? 'La fiche est identique : le changement est ailleurs dans le ticket (commentaire, champ non repris dans la fiche). Regarde-le dans la source.\n\n'
      : '';
    const detail = where + (canReplan
      ? 'Garder le plan : la fiche ne change pas, la version reçue devient la référence. Replanifier : la story revient dans New avec ce contenu, et l\'atelier rouvre ; les versions du plan restent consultables.'
      : story.folder === 'done'
        ? 'La story est déjà mergée : la fiche garde sa trace. Si le changement demande du travail, crée une nouvelle story.'
        : run
        ? `La story est dans le flux de dev (${statusLabel(run.status)}). Pour la replanifier, retire-la d'abord du flux, ou arrête son agent.`
        : 'La fiche ne change pas, la version reçue devient la référence.');
    const webUrl = story.frontmatter.web_url;
    const chosen = await vscode.window.showWarningMessage(
      `${id} a changé dans la source.`,
      { modal: true, detail },
      ...(canReplan ? [keep, replan] : [keep]),
      ...(webUrl ? [openSource] : [])
    );
    if (chosen === openSource && webUrl) {
      // La marque reste : tu reviens trancher après avoir lu le ticket.
      await vscode.env.openExternal(vscode.Uri.parse(webUrl));
    } else if (chosen === keep) {
      await this.guard(async () => {
        await workDir.acceptSourceChange(story);
        this.ctx.log.info(`${id} : changement de la source accepté, plan gardé.`);
      });
    } else if (chosen === replan) {
      await this.guard(async () => {
        const plans = new PlanStore(workDir.plansPath());
        const target = await replanFromSource(workDir, plans, story, story.frontmatter.source);
        this.ctx.log.info(`${id} : revenue dans new/ pour replanification.`);
        const reopened = await workDir.findStory(id);
        if (reopened) {
          const next: StoryNode = { kind: 'story', group: 'new', story: reopened };
          await vscode.commands.executeCommand('devbots.planStory', next);
        } else {
          await vscode.commands.executeCommand('devbots.openStory', target);
        }
      });
    }
  }

  private async pickFlagged(workDir: WorkDir, storyId?: string): Promise<StoryFile | undefined> {
    const flagged = [...(await workDir.indexBySourceId()).values()].filter((s) => s.frontmatter.needs_review === true);
    const direct = storyId ? flagged.find((s) => s.frontmatter.source_id === storyId) : undefined;
    if (direct) {
      return direct;
    }
    if (flagged.length === 0) {
      vscode.window.showInformationMessage('Aucune story à revoir.');
      return undefined;
    }
    if (flagged.length === 1) {
      return flagged[0];
    }
    const picked = await vscode.window.showQuickPick(
      flagged.map((story) => ({ label: `${story.frontmatter.source_id} — ${story.title}`, description: story.folder, story })),
      { title: 'Quelle story revoir ?' }
    );
    return picked?.story;
  }

  private workDir(): WorkDir {
    return new WorkDir(vscode.Uri.joinPath(this.ctx.repoUri, readConfig(this.ctx.repoUri).workDir).fsPath);
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
    }
  }
}

/** Le corps d'une fiche, sans son frontmatter (révision, dates). */
function body(card: string): string {
  return matter(card).content.trim();
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
