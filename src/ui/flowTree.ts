/**
 * Le panneau latéral : le tableau de bord du flux.
 *
 * Seuls les groupes lus sur disque existent pour l'instant (New, Ready, Done) ;
 * une story de New en cours de planification le signale. Dans New, les stories
 * d'une feature saisie à la main sont rangées sous elle.
 * Les groupes « En dev » et « À valider » viendront avec `state.json` en phase 3.
 */

import * as vscode from 'vscode';
import type { FeatureFile, StoryFile, StoryFolder } from '../core/workDir.js';
import type { WorkDir } from '../core/workDir.js';
import { PlanStore, type PlanningPhase } from '../core/planStore.js';

const GROUPS: ReadonlyArray<{ folder: StoryFolder; label: string }> = [
  { folder: 'new', label: 'New' },
  { folder: 'ready', label: 'Ready' },
  { folder: 'done', label: 'Done' }
];

/** Un nœud de l'arbre : un groupe, une feature, ou une story. */
export type FlowNode = GroupNode | FeatureNode | StoryNode;

export interface GroupNode {
  kind: 'group';
  folder: StoryFolder;
  label: string;
  count: number;
  /** Vrai quand le groupe a des enfants autres que des stories : les features de New. */
  hasFeatures: boolean;
}

export interface FeatureNode {
  kind: 'feature';
  feature: FeatureFile;
  stories: StoryNode[];
}

export interface StoryNode {
  kind: 'story';
  story: StoryFile;
  /** Phase de l'atelier, pour une story de New en cours de planification. */
  planning?: PlanningPhase;
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
      const features = await this.workDir.listFeatures();
      const groups: GroupNode[] = [];
      for (const group of GROUPS) {
        const stories = await this.workDir.listStories(group.folder);
        groups.push({
          kind: 'group',
          ...group,
          count: stories.length,
          hasFeatures: group.folder === 'new' && features.length > 0
        });
      }
      // Un groupe vide reste visible : il montre la forme du flux.
      return groups;
    }
    if (element.kind === 'feature') {
      return element.stories;
    }
    if (element.kind === 'group') {
      const stories = await this.storyNodes(element.folder);
      if (element.folder !== 'new') {
        return stories;
      }
      // Une feature vide reste visible dans New : on y ajoute ses stories.
      const features = await this.workDir.listFeatures();
      const featureIds = new Set(features.map((f) => f.frontmatter.source_id));
      const grouped: FeatureNode[] = features.map((feature) => ({
        kind: 'feature',
        feature,
        stories: stories.filter((s) => parentOf(s) === feature.frontmatter.source_id)
      }));
      const loose = stories.filter((s) => !featureIds.has(parentOf(s) ?? ''));
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

  private async storyNodes(folder: StoryFolder): Promise<StoryNode[]> {
    const stories = await this.workDir.listStories(folder);
    const phases =
      folder === 'new'
        ? await new PlanStore(this.workDir.plansPath()).listPhases()
        : new Map<string, PlanningPhase>();
    return stories.map((story) => ({
      kind: 'story',
      story,
      planning: phases.get(story.frontmatter.source_id)
    }));
  }
}

function parentOf(node: StoryNode): string | undefined {
  const parent = node.story.frontmatter.parent;
  return parent === undefined || parent === null ? undefined : String(parent);
}

function groupItem(node: GroupNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    node.label,
    node.count > 0 || node.hasFeatures
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None
  );
  item.description = String(node.count);
  item.contextValue = `group:${node.folder}`;
  item.iconPath = new vscode.ThemeIcon(groupIcon(node.folder));
  return item;
}

function groupIcon(folder: StoryFolder): string {
  switch (folder) {
    case 'new':
      return 'inbox';
    case 'ready':
      return 'checklist';
    case 'done':
      return 'pass-filled';
  }
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

function storyItem(node: StoryNode): vscode.TreeItem {
  const { story } = node;
  const id = story.frontmatter.source_id;
  const needsReview = story.frontmatter.needs_review === true;

  const item = new vscode.TreeItem(
    id ? `${id} — ${story.title}` : story.title,
    vscode.TreeItemCollapsibleState.None
  );
  item.resourceUri = vscode.Uri.file(story.filePath);
  // `:linked` porte le bouton « ouvrir dans la source », absent d'une fiche locale.
  item.contextValue = `story:${story.folder}${story.frontmatter.web_url ? ':linked' : ''}`;
  item.command = {
    command: 'devbots.openStory',
    title: 'Ouvrir la fiche',
    arguments: [story.filePath]
  };

  if (needsReview) {
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
    item.iconPath = new vscode.ThemeIcon(story.frontmatter.source === 'local' ? 'edit' : 'file');
    item.tooltip = new vscode.MarkdownString(
      [
        `**${story.title}**`,
        '',
        story.frontmatter.source === 'local'
          ? `- Saisie à la main \`${id}\``
          : `- Source : ${story.frontmatter.source ?? '?'} \`${id ?? '?'}\``,
        `- État : ${story.frontmatter.state ?? '?'}`,
        story.frontmatter.dependencies?.length
          ? `- Bloquée par : ${story.frontmatter.dependencies.join(', ')}`
          : undefined
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
  return item;
}
