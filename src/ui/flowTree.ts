/**
 * Le panneau latéral : le tableau de bord du flux.
 *
 * Seuls les groupes lus sur disque existent pour l'instant (New, Ready, Done) ;
 * une story de New en cours de planification le signale.
 * Les groupes « En dev » et « À valider » viendront avec `state.json` en phase 3.
 */

import * as vscode from 'vscode';
import type { StoryFile, StoryFolder } from '../core/workDir.js';
import type { WorkDir } from '../core/workDir.js';
import { PlanStore, type PlanningPhase } from '../core/planStore.js';

const GROUPS: ReadonlyArray<{ folder: StoryFolder; label: string }> = [
  { folder: 'new', label: 'New' },
  { folder: 'ready', label: 'Ready' },
  { folder: 'done', label: 'Done' }
];

/** Un nœud de l'arbre : un groupe, ou une story. */
export type FlowNode = GroupNode | StoryNode;

export interface GroupNode {
  kind: 'group';
  folder: StoryFolder;
  label: string;
  count: number;
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
      const groups: GroupNode[] = [];
      for (const group of GROUPS) {
        const stories = await this.workDir.listStories(group.folder);
        groups.push({ kind: 'group', ...group, count: stories.length });
      }
      // Un groupe vide reste visible : il montre la forme du flux.
      return groups;
    }
    if (element.kind === 'group') {
      const stories = await this.workDir.listStories(element.folder);
      const phases =
        element.folder === 'new'
          ? await new PlanStore(this.workDir.plansPath()).listPhases()
          : new Map<string, PlanningPhase>();
      return stories.map((story) => ({
        kind: 'story',
        story,
        planning: phases.get(story.frontmatter.source_id)
      }));
    }
    return [];
  }

  getTreeItem(node: FlowNode): vscode.TreeItem {
    return node.kind === 'group' ? groupItem(node) : storyItem(node);
  }
}

function groupItem(node: GroupNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    node.label,
    node.count > 0
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

function storyItem(node: StoryNode): vscode.TreeItem {
  const { story } = node;
  const id = story.frontmatter.source_id;
  const needsReview = story.frontmatter.needs_review === true;

  const item = new vscode.TreeItem(
    id ? `${id} — ${story.title}` : story.title,
    vscode.TreeItemCollapsibleState.None
  );
  item.resourceUri = vscode.Uri.file(story.filePath);
  item.contextValue = `story:${story.folder}`;
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
    item.iconPath = new vscode.ThemeIcon('file');
    item.tooltip = new vscode.MarkdownString(
      [
        `**${story.title}**`,
        '',
        `- État source : ${story.frontmatter.state ?? '?'}`,
        `- Source : ${story.frontmatter.source ?? '?'} \`${id ?? '?'}\``,
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
