/**
 * La commande d'import : remplit `.work/new` depuis la source.
 *
 * Les issues ouvertes du dépôt GitHub, ou les epics, features et stories
 * ouverts du projet Azure DevOps, sont proposés en liste à cocher, sans ceux
 * que `.work` connaît déjà ; à la demande, un identifiant suffit. Les tickets qui regroupent des stories
 * deviennent des fiches de `.work/features`. Rien n'est écrit dans la source.
 */

import * as vscode from 'vscode';
import type {
  CandidateListing,
  SourceKind,
  Ticket,
  TicketCandidate,
  TicketSource
} from '../core/model.js';
import type { FeatureFile, ImportResult, StoryFile } from '../core/workDir.js';
import { WorkDir } from '../core/workDir.js';
import { mergeTrees, storyGroups } from '../core/mergeTrees.js';
import { alreadyImported, type KnownCard } from '../core/candidates.js';
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

        // Les stories deviennent des fiches du flux, leurs parents directs des
        // fiches de features ; un epic sans story directe ne laisse pas de trace.
        const merged = mergeTrees(trees);
        const stories = merged.filter((t) => t.level === 'story');
        if (stories.length === 0) {
          vscode.window.showWarningMessage(
            `Aucune story trouvée sous ${roots.join(', ')}. Vérifie que l'élément a bien des enfants.`
          );
          return;
        }

        progress.report({ message: `écriture de ${stories.length} fiche(s)…` });
        const results = await workDir.importTickets(stories, config.sourceKind);
        const features = await workDir.importFeatures(storyGroups(merged), config.sourceKind);

        ctx.onImported();
        reportResults(results, features, failures, config.sourceKind, ctx.log);
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
  quickPick.placeholder =
    config.sourceKind === 'github'
      ? 'Lecture des issues ouvertes…'
      : 'Lecture des work items ouverts…';
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
    const [listing, known] = await Promise.all([list(loading.token), knownCards(workDir)]);
    if (!hidden) {
      const imported = alreadyImported(listing.candidates, known.stories, known.features);
      const offered = listing.candidates.filter((c) => !imported.has(c.sourceId));
      quickPick.items = buildItems(offered, known.locations);
      quickPick.placeholder = placeholderFor(listing, offered.length, imported.size, config);
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

interface KnownCards {
  stories: KnownCard[];
  features: KnownCard[];
  /** Où chaque ticket déjà importé se trouve : un dossier du flux, ou `features`. */
  locations: Map<string, string>;
}

async function knownCards(workDir: WorkDir): Promise<KnownCards> {
  const features = await workDir.listFeatures();
  const stories = [...(await workDir.indexBySourceId()).values()];
  const toKnown = (card: FeatureFile | StoryFile): KnownCard => ({
    sourceId: card.frontmatter.source_id,
    parent: card.frontmatter.parent
  });
  const locations = new Map<string, string>();
  for (const feature of features) {
    locations.set(feature.frontmatter.source_id, 'features');
  }
  for (const story of stories) {
    locations.set(story.frontmatter.source_id, story.folder);
  }
  return { stories: stories.map(toKnown), features: features.map(toKnown), locations };
}

/**
 * Les tickets qui portent un lot de stories d'abord. Azure DevOps donne le
 * niveau de chaque work item ; GitHub ne le connaît qu'en parcourant l'arbre, et
 * l'on s'y fie alors au nombre de sub-issues.
 */
function buildItems(candidates: TicketCandidate[], known: Map<string, string>): CandidatePick[] {
  const titles = new Map(candidates.map((c) => [c.sourceId, c.title]));
  const items: CandidatePick[] = [];
  const section = (title: string, group: TicketCandidate[]): void => {
    if (group.length === 0) {
      return;
    }
    items.push({ label: title, kind: vscode.QuickPickItemKind.Separator, sourceId: '' });
    items.push(...group.map((c) => toItem(c, known.get(c.sourceId), titles)));
  };
  if (candidates.some((c) => c.level !== undefined)) {
    section('Epics', candidates.filter((c) => c.level === 'epic'));
    section('Features', candidates.filter((c) => c.level === 'feature'));
    section('Stories', candidates.filter((c) => c.level === 'story'));
  } else {
    section('Issues parentes', candidates.filter((c) => (c.childCount ?? 0) > 0));
    section('Issues', candidates.filter((c) => (c.childCount ?? 0) === 0));
  }
  return items;
}

function toItem(
  candidate: TicketCandidate,
  knownIn: string | undefined,
  titles: Map<string, string>
): CandidatePick {
  const description: string[] = [];
  if (candidate.childCount) {
    const unit = candidate.level === undefined ? 'sub-issue(s)' : 'enfant(s)';
    description.push(`$(list-tree) ${candidate.childCount} ${unit}`);
  }
  if (knownIn) {
    description.push(`$(check) déjà dans ${knownIn}`);
  }
  const detail: string[] = [];
  if (candidate.parentId) {
    const parentTitle = titles.get(candidate.parentId);
    detail.push(`sous ${candidate.parentId}${parentTitle ? ` ${parentTitle}` : ''}`);
  }
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

function placeholderFor(
  listing: CandidateListing,
  offeredCount: number,
  importedCount: number,
  config: DevBotsConfig
): string {
  const notes: string[] = [];
  if (importedCount > 0) {
    // Le crayon reste le moyen de relire un ticket déjà importé.
    notes.push(`${importedCount} déjà importé(s), masqué(s) : le crayon les relit`);
  }
  if (listing.hiddenCount > 0) {
    notes.push(
      `${listing.hiddenCount} masquée(s) par le filtre d'auteur (label « ${config.githubTrustedLabel} » pour les inclure)`
    );
  }
  if (listing.truncated) {
    notes.push('liste coupée aux plus récentes');
  }
  const github = config.sourceKind === 'github';
  const base =
    offeredCount > 0
      ? github
        ? 'Coche les issues à importer. Une issue parente importe ses sub-issues.'
        : 'Coche les work items à importer. Un epic ou une feature importe ses stories ; une story seule vient avec sa feature.'
      : importedCount > 0
        ? 'Tout est déjà importé.'
        : github
          ? 'Aucune issue ouverte importable. Le crayon permet de saisir un numéro.'
          : 'Aucun work item ouvert. Le crayon permet de saisir un ID.';
  return notes.length > 0 ? `${base} — ${notes.join(' ; ')}` : base;
}

function promptFor(kind: SourceKind): string {
  return kind === 'github'
    ? "Numéro de l'issue parente. Ses sub-issues deviennent les stories de .work/new."
    : "ID d'un epic, d'une feature ou d'une story. Les stories deviennent les fiches de .work/new.";
}

function reportResults(
  results: ImportResult[],
  features: ImportResult[],
  failures: string[],
  source: SourceKind,
  log: vscode.LogOutputChannel
): void {
  const created = results.filter((r) => r.outcome === 'created').length;
  const updated = results.filter((r) => r.outcome === 'updated').length;
  const unchanged = results.filter((r) => r.outcome === 'unchanged').length;
  const needsReview = results.filter((r) => r.outcome === 'needsReview');

  const featuresWritten = features.filter((r) => r.outcome === 'created').length;

  for (const result of results) {
    log.info(`[${source}] ${result.sourceId} ${result.outcome} — ${result.title}`);
  }
  for (const result of features) {
    log.info(`[${source}] feature ${result.sourceId} ${result.outcome} — ${result.title}`);
  }

  const parts: string[] = [];
  if (created > 0) {
    parts.push(`${created} fiche(s) écrite(s)`);
  }
  if (updated > 0) {
    parts.push(`${updated} mise(s) à jour`);
  }
  if (featuresWritten > 0) {
    parts.push(`${featuresWritten} feature(s) écrite(s)`);
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
        .join(', ')} ont changé dans la source depuis leur planification : « voir les changements » sur chacune.`
    );
  } else if (failures.length > 0) {
    vscode.window.showWarningMessage(`Import terminé : ${summary}. Détails dans le journal.`);
  } else {
    vscode.window.showInformationMessage(`Import terminé : ${summary}.`);
  }
}

/** Une erreur de configuration propose d'ouvrir le paramètre en cause ; les autres, le journal. */
export async function reportError(
  err: unknown,
  log: vscode.LogOutputChannel,
  prefix = 'Import impossible'
): Promise<void> {
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
  const chosen = await vscode.window.showErrorMessage(`${prefix} : ${message}`, 'Voir le journal');
  if (chosen === 'Voir le journal') {
    log.show();
  }
}
