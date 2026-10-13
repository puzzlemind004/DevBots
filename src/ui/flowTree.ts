/**
 * Le panneau latéral : le tableau de bord du flux.
 *
 * New, Ready et Done se lisent dans les dossiers ; « En dev » et « À valider »
 * dans `state.json`. Une story de `ready/` partie en dev quitte Ready pour le
 * groupe de son état. Dans New, les stories d'une feature sont rangées sous elle.
 */

import * as vscode from 'vscode';
import type { FeatureFile, StoryFile, WorkDir } from '../core/workDir.js';
import { PlanStore, type PlanningPhase } from '../core/planStore.js';
import { FlowStateStore, statusLabel, type FlowState, type FlowStatus, type StoryRun } from '../core/flowState.js';
import { dependencyView, schedulable } from '../core/schedule.js';

/** Les groupes du panneau, dans l'ordre du flux. */
export type FlowGroup = 'new' | 'ready' | 'dev' | 'review' | 'done';

const GROUPS: ReadonlyArray<{ group: FlowGroup; label: string; icon: string }> = [
  { group: 'new', label: 'New', icon: 'inbox' },
  { group: 'ready', label: 'Ready', icon: 'checklist' },
  { group: 'dev', label: 'En dev', icon: 'gear' },
  { group: 'review', label: 'À valider', icon: 'eye' },
  { group: 'done', label: 'Done', icon: 'pass-filled' }
];

/** Le groupe d'une story d'après son état dans `state.json`. */
function groupOf(status: FlowStatus): FlowGroup {
  switch (status) {
    case 'awaiting_human':
    case 'merging':
      return 'review';
    case 'done':
      return 'done';
    default:
      return 'dev';
  }
}

/** Un nœud de l'arbre : un groupe, une feature, ou une story. */
export type FlowNode = GroupNode | FeatureNode | StoryNode;

export interface GroupNode {
  kind: 'group';
  group: FlowGroup;
  label: string;
  stories: StoryNode[];
  /** Les features de New, sous lesquelles se rangent leurs stories. */
  features: FeatureFile[];
}

export interface FeatureNode {
  kind: 'feature';
  feature: FeatureFile;
  stories: StoryNode[];
}

export interface StoryNode {
  kind: 'story';
  story: StoryFile;
  group: FlowGroup;
  /** Phase de l'atelier, pour une story de New en cours de planification. */
  planning?: PlanningPhase;
  /** Son parcours après Ready, quand elle est partie en dev. */
  run?: StoryRun;
  /** Dépendances infirmées par le plan : « parallélisable d'après le code ». */
  parallelizable?: string[];
}

export class FlowTreeProvider implements vscode.TreeDataProvider<FlowNode> {
  private readonly changed = new vscode.EventEmitter<FlowNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private workDir: WorkDir) {}

  setWorkDir(workDir: WorkDir): void {
    this.workDir = workDir;
    this.refresh();
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  async getChildren(element?: FlowNode): Promise<FlowNode[]> {
    if (!element) {
      return this.groups();
    }
    if (element.kind === 'feature') {
      return element.stories;
    }
    if (element.kind === 'group') {
      if (element.group !== 'new') {
        return element.stories;
      }
      // Une feature vide reste visible dans New : on y ajoute ses stories.
      const featureIds = new Set(element.features.map((f) => f.frontmatter.source_id));
      const grouped: FeatureNode[] = element.features.map((feature) => ({
        kind: 'feature',
        feature,
        stories: element.stories.filter((s) => parentOf(s) === feature.frontmatter.source_id)
      }));
      const loose = element.stories.filter((s) => !featureIds.has(parentOf(s) ?? ''));
      return [...grouped, ...loose];
    }
    return [];
  }

  getTreeItem(node: FlowNode): vscode.TreeItem {
    switch (node.kind) {
      case 'group':
        return groupItem(node);
      case 'feature':
        return featureItem(node);
      case 'story':
        return storyItem(node);
    }
  }

  private async groups(): Promise<GroupNode[]> {
    const state = await this.readState();
    const phases = await new PlanStore(this.workDir.plansPath()).listPhases();
    const byGroup = new Map<FlowGroup, StoryNode[]>(GROUPS.map((g) => [g.group, []]));

    for (const folder of ['new', 'ready', 'done'] as const) {
      for (const story of await this.workDir.listStories(folder)) {
        const id = story.frontmatter.source_id;
        const run = folder === 'ready' ? state.stories[id] : undefined;
        const group: FlowGroup = run ? groupOf(run.status) : folder;
        byGroup.get(group)!.push({
          kind: 'story',
          story,
          group,
          planning: folder === 'new' ? phases.get(id) : undefined,
          run,
          parallelizable:
            folder === 'ready'
              ? dependencyView(schedulable(story.frontmatter), state.dependencyOverrides[id]).parallelizable
              : undefined
        });
      }
    }

    const features = await this.workDir.listFeatures();
    // Un groupe vide reste visible : il montre la forme du flux.
    return GROUPS.map(({ group, label }) => ({
      kind: 'group',
      group,
      label,
      stories: byGroup.get(group)!,
      features: group === 'new' ? features : []
    }));
  }

  private async readState(): Promise<FlowState> {
    try {
      return await new FlowStateStore(this.workDir.statePath()).read();
    } catch {
      // Un state.json illisible ne doit pas vider le panneau : les dossiers suffisent.
      return { version: 1, stories: {}, dependencyOverrides: {} };
    }
  }
}

function parentOf(node: StoryNode): string | undefined {
  const parent = node.story.frontmatter.parent;
  return parent === undefined || parent === null ? undefined : String(parent);
}

function groupItem(node: GroupNode): vscode.TreeItem {
  const hasChildren = node.stories.length > 0 || node.features.length > 0;
  const item = new vscode.TreeItem(
    node.label,
    hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
  );
  item.description = String(node.stories.length);
  item.contextValue = `group:${node.group}`;
  item.iconPath = new vscode.ThemeIcon(GROUPS.find((g) => g.group === node.group)!.icon);
  return item;
}

function featureItem(node: FeatureNode): vscode.TreeItem {
  const { feature } = node;
  const item = new vscode.TreeItem(
    `${feature.frontmatter.source_id} — ${feature.title}`,
    node.stories.length > 0
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None
  );
  item.description = node.stories.length > 0 ? String(node.stories.length) : 'aucune story';
  item.resourceUri = vscode.Uri.file(feature.filePath);
  item.contextValue = `feature${feature.frontmatter.web_url ? ':linked' : ''}`;
  item.iconPath = new vscode.ThemeIcon('layers');
  item.command = {
    command: 'devbots.openStory',
    title: 'Ouvrir la fiche',
    arguments: [feature.filePath]
  };
  item.tooltip = new vscode.MarkdownString(
    [
      `**${feature.title}**`,
      '',
      feature.frontmatter.source === 'local'
        ? 'Feature saisie à la main.'
        : `Importée de ${feature.frontmatter.source ?? '?'}.`,
      'Seules ses stories de New sont rangées ici.'
    ].join('\n')
  );
  return item;
}

/**
 * `contextValue` d'une story : `story:<groupe>`, puis son état après Ready,
 * puis les marques `:linked` (lien vers la source) et `:followup` (née du tri).
 * Les menus de `package.json` filtrent sur ces morceaux.
 */
function storyContext(node: StoryNode): string {
  const parts = [`story:${node.group}`];
  if (node.run) {
    parts.push(node.run.status);
  }
  if (node.story.frontmatter.origin) {
    parts.push('followup');
  }
  if (node.story.frontmatter.web_url) {
    parts.push('linked');
  }
  return parts.join(':');
}

const STATUS_ICONS: Record<FlowStatus, [string, string?]> = {
  queued: ['clock'],
  in_dev: ['sync~spin'],
  ai_review: ['sync~spin'],
  pre_pr_check: ['sync~spin'],
  awaiting_human: ['bell-dot', 'charts.blue'],
  merging: ['git-merge'],
  done: ['pass-filled'],
  blocked: ['error', 'list.errorForeground']
};

function storyItem(node: StoryNode): vscode.TreeItem {
  const { story, run } = node;
  const id = story.frontmatter.source_id;
  const needsReview = story.frontmatter.needs_review === true;

  const item = new vscode.TreeItem(
    id ? `${id} — ${story.title}` : story.title,
    vscode.TreeItemCollapsibleState.None
  );
  item.resourceUri = vscode.Uri.file(story.filePath);
  item.contextValue = storyContext(node);
  item.command = {
    command: 'devbots.openStory',
    title: 'Ouvrir la fiche',
    arguments: [story.filePath]
  };

  const badge = story.frontmatter.origin ? `${story.frontmatter.origin} · ` : '';

  if (run) {
    const [icon, color] = STATUS_ICONS[run.status];
    item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    item.description = `${badge}${statusLabel(run.status)} · ${run.model}${run.loops > 0 ? ` · boucle ${run.loops}` : ''}`;
    item.tooltip = runTooltip(story, run);
  } else if (needsReview) {
    item.description = 'à revoir';
    item.iconPath = new vscode.ThemeIcon(
      'warning',
      new vscode.ThemeColor('list.warningForeground')
    );
    item.tooltip = new vscode.MarkdownString(
      `**${story.title}**\n\nLa story a changé dans la source depuis son import. Révision vue : \`${story.frontmatter.source_rev_seen ?? '?'}\`.`
    );
  } else if (node.planning) {
    item.description = node.planning === 'understanding' ? 'en compréhension' : 'plan en revue';
    item.iconPath = new vscode.ThemeIcon('lightbulb-sparkle');
    item.tooltip = new vscode.MarkdownString(
      `**${story.title}**\n\nPlanification en cours : l'atelier reprend où il s'était arrêté.`
    );
  } else {
    item.iconPath = new vscode.ThemeIcon(
      story.frontmatter.origin ? 'checklist' : story.frontmatter.source === 'local' ? 'edit' : 'file'
    );
    const model = node.group === 'ready' ? story.frontmatter.recommended_model : undefined;
    item.description = [badge.replace(/ · $/, ''), model].filter(Boolean).join(' · ') || undefined;
    item.tooltip = new vscode.MarkdownString(
      [
        `**${story.title}**`,
        '',
        story.frontmatter.source === 'local'
          ? `- Saisie à la main \`${id}\``
          : `- Source : ${story.frontmatter.source ?? '?'} \`${id ?? '?'}\``,
        story.frontmatter.origin_story
          ? `- Née de ${story.frontmatter.origin ?? 'la supervision'} sur ${story.frontmatter.origin_story}`
          : undefined,
        `- État : ${story.frontmatter.state ?? '?'}`,
        story.frontmatter.dependencies?.length
          ? `- Bloquée par : ${story.frontmatter.dependencies.join(', ')}`
          : undefined,
        node.parallelizable?.length
          ? `- Parallélisable d'après le code : ${node.parallelizable.join(', ')} (le plan ne trouve aucun fichier commun)`
          : undefined,
        model ? `- Modèle recommandé : ${model}` : undefined
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
  return item;
}

function runTooltip(story: StoryFile, run: StoryRun): vscode.MarkdownString {
  const dev = run.lastDev;
  const lines = [
    `**${story.title}**`,
    '',
    `- État : ${statusLabel(run.status)}`,
    `- Modèle : ${run.model}`,
    run.branch ? `- Branche : \`${run.branch}\` sur \`${run.baseBranch}\`` : undefined,
    run.loops > 0 ? `- Boucles de correction : ${run.loops}` : undefined,
    dev ? `- Build : ${dev.build} · tests : ${dev.tests} · lint : ${dev.lint}` : undefined,
    run.followUps.length > 0 ? `- Fiches créées par le tri : ${run.followUps.join(', ')}` : undefined,
    run.reason ? `\n${run.reason}` : undefined
  ];
  return new vscode.MarkdownString(lines.filter(Boolean).join('\n'));
}
