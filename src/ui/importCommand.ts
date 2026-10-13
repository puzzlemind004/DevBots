/**
 * La commande d'import : remplit `.work/new` depuis la source.
 *
 * Côté GitHub, les issues ouvertes du dépôt sont proposées en liste à cocher ;
 * ailleurs, ou à la demande, un identifiant suffit. Rien n'est écrit dans la
 * source.
 */

import * as vscode from 'vscode';
import type {
  CandidateListing,
  SourceKind,
  Ticket,
  TicketCandidate,
  TicketSource
} from '../core/model.js';
import type { ImportResult, StoryFile } from '../core/workDir.js';
import { WorkDir } from '../core/workDir.js';
import { mergeTrees } from '../core/mergeTrees.js';
import { ConfigError, createSource } from '../sources/factory.js';
import { readConfig, sourceLabel, type DevBotsConfig } from '../util/config.js';

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
  const workDir = new WorkDir(vscode.Uri.joinPath(ctx.repoUri, config.workDir).fsPath);

  let source: TicketSource;
  let rootIds: string[] | undefined;
  try {
    // La connexion se fait avant le choix : la liste des issues en a besoin.
    source = await createSource(config, ctx.secrets, ctx.repoRoot);
    rootIds = source.listCandidates
      ? await pickCandidates(source.listCandidates.bind(source), workDir, config, label)
      : await askForId(config.sourceKind, label);
  } catch (err) {
    await reportError(err, ctx.log);
    return;
  }
  if (!rootIds || rootIds.length === 0) {
    return;
  }
  const roots = rootIds;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Import depuis ${label}`,
      cancellable: true
    },
    async (progress, token) => {
      try {
        progress.report({ message: 'connexion…' });
        await source.probe();

        const trees: Ticket[][] = [];
        const failures: string[] = [];
        for (const [index, rootId] of roots.entries()) {
          if (token.isCancellationRequested) {
            return;
          }
          progress.report({
            message:
              roots.length > 1
                ? `lecture de ${rootId} (${index + 1}/${roots.length})…`
                : 'lecture de la hiérarchie…'
          });
          try {
            trees.push(await source.fetchTree(rootId, token));
          } catch (err) {
            // Une racine illisible n'empêche pas d'importer les autres.
            if (roots.length === 1) {
              throw err;
            }
            const message = err instanceof Error ? err.message : String(err);
            ctx.log.warn(`[${config.sourceKind}] ${rootId} ignoré — ${message}`);
            failures.push(rootId);
          }
        }
        if (token.isCancellationRequested) {
          return;
        }

        // Seules les stories deviennent des fiches : les epics et features ne
        // servent qu'à retrouver la hiérarchie et le parent.
        const stories = mergeTrees(trees).filter((t) => t.level === 'story');
        if (stories.length === 0) {
          vscode.window.showWarningMessage(
            `Aucune story trouvée sous ${roots.join(', ')}. Vérifie que l'élément a bien des enfants.`
          );
          return;
        }

        progress.report({ message: `écriture de ${stories.length} fiche(s)…` });
        const results = await workDir.importTickets(stories, config.sourceKind);

        ctx.onImported();
        reportResults(results, failures, config.sourceKind, ctx.log);
      } catch (err) {
        await reportError(err, ctx.log);
      }
    }
  );
}

async function askForId(kind: SourceKind, label: string): Promise<string[] | undefined> {
  const rootId = await vscode.window.showInputBox({
    title: `DevBots — importer depuis ${label}`,
    prompt: promptFor(kind),
    placeHolder: kind === 'github' ? "42, #42 ou une URL d'issue" : '1234 ou une URL de work item',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'Un identifiant est attendu.')
  });
  return rootId ? [rootId.trim()] : undefined;
}

interface CandidatePick extends vscode.QuickPickItem {
  /** Vide pour les séparateurs. */
  sourceId: string;
}

/**
 * Liste à cocher des tickets ouverts. Le bouton crayon ramène à la saisie d'un
 * identifiant, pour une issue fermée ou au-delà du plafond de la liste.
 */
async function pickCandidates(
  list: (token: vscode.CancellationToken) => Promise<CandidateListing>,
  workDir: WorkDir,
  config: DevBotsConfig,
  label: string
): Promise<string[] | undefined> {
  const quickPick = vscode.window.createQuickPick<CandidatePick>();
  const manualEntry: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('edit'),
    tooltip: 'Saisir un numéro ou une URL'
  };
  quickPick.title = `DevBots — importer depuis ${label}`;
  quickPick.canSelectMany = true;
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.ignoreFocusOut = true;
  quickPick.buttons = [manualEntry];
  quickPick.placeholder = 'Lecture des issues ouvertes…';
  quickPick.busy = true;

  const loading = new vscode.CancellationTokenSource();
  let hidden = false;
  const choice = new Promise<string[] | 'manual' | undefined>((resolve) => {
    quickPick.onDidAccept(() => {
      // Entrée sans case cochée : l'issue surlignée est retenue.
      const chosen =
        quickPick.selectedItems.length > 0 ? quickPick.selectedItems : quickPick.activeItems;
      resolve(chosen.map((item) => item.sourceId).filter((id) => id !== ''));
      quickPick.hide();
    });
    quickPick.onDidTriggerButton((button) => {
      if (button === manualEntry) {
        resolve('manual');
        quickPick.hide();
      }
    });
    quickPick.onDidHide(() => {
      hidden = true;
      resolve(undefined);
      loading.cancel();
      loading.dispose();
      quickPick.dispose();
    });
  });
  quickPick.show();

  try {
    const [listing, existing] = await Promise.all([
      list(loading.token),
      workDir.indexBySourceId()
    ]);
    if (!hidden) {
      quickPick.items = buildItems(listing.candidates, existing);
      quickPick.placeholder = placeholderFor(listing, config);
      quickPick.busy = false;
    }
  } catch (err) {
    if (!hidden) {
      quickPick.hide();
    }
    throw err;
  }

  const picked = await choice;
  if (picked === 'manual') {
    return askForId(config.sourceKind, label);
  }
  return picked;
}

/** Les issues parentes d'abord : ce sont elles qui portent un lot de stories. */
function buildItems(
  candidates: TicketCandidate[],
  existing: Map<string, StoryFile>
): CandidatePick[] {
  const items: CandidatePick[] = [];
  const section = (title: string, group: TicketCandidate[]): void => {
    if (group.length === 0) {
      return;
    }
    items.push({ label: title, kind: vscode.QuickPickItemKind.Separator, sourceId: '' });
    items.push(...group.map((c) => toItem(c, existing.get(c.sourceId))));
  };
  section('Issues parentes', candidates.filter((c) => (c.childCount ?? 0) > 0));
  section('Issues', candidates.filter((c) => (c.childCount ?? 0) === 0));
  return items;
}

function toItem(candidate: TicketCandidate, known: StoryFile | undefined): CandidatePick {
  const description: string[] = [];
  if (candidate.childCount) {
    description.push(`$(list-tree) ${candidate.childCount} sub-issue(s)`);
  }
  if (known) {
    description.push(`$(check) déjà dans ${known.folder}`);
  }
  const detail: string[] = [];
  if (candidate.labels.length > 0) {
    detail.push(candidate.labels.join(', '));
  }
  if (candidate.authorLogin) {
    detail.push(`par ${candidate.authorLogin}`);
  }
  return {
    label: `#${candidate.sourceId} ${candidate.title}`,
    description: description.join('  '),
    detail: detail.join(' · '),
    sourceId: candidate.sourceId
  };
}

function placeholderFor(listing: CandidateListing, config: DevBotsConfig): string {
  const notes: string[] = [];
  if (listing.hiddenCount > 0) {
    notes.push(
      `${listing.hiddenCount} masquée(s) par le filtre d'auteur (label « ${config.githubTrustedLabel} » pour les inclure)`
    );
  }
  if (listing.truncated) {
    notes.push('liste coupée aux plus récentes');
  }
  const base =
    listing.candidates.length > 0
      ? 'Coche les issues à importer. Une issue parente importe ses sub-issues.'
      : 'Aucune issue ouverte importable. Le crayon permet de saisir un numéro.';
  return notes.length > 0 ? `${base} — ${notes.join(' ; ')}` : base;
}

function promptFor(kind: SourceKind): string {
  return kind === 'github'
    ? "Numéro de l'issue parente. Ses sub-issues deviennent les stories de .work/new."
    : "ID de l'epic ou de la feature. Ses user stories deviennent les fiches de .work/new.";
}

function reportResults(
  results: ImportResult[],
  failures: string[],
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
  if (failures.length > 0) {
    parts.push(`${failures.length} racine(s) ignorée(s) : ${failures.join(', ')}`);
  }
  const summary = parts.length > 0 ? parts.join(', ') : 'rien à importer';

  if (needsReview.length > 0) {
    // Une story déjà planifiée qui a changé dans la source n'est pas écrasée.
    vscode.window.showWarningMessage(
      `Import terminé : ${summary}. Les stories ${needsReview
        .map((r) => r.sourceId)
        .join(', ')} ont changé dans la source depuis leur planification.`
    );
  } else if (failures.length > 0) {
    vscode.window.showWarningMessage(`Import terminé : ${summary}. Détails dans le journal.`);
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
