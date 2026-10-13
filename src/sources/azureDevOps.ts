/**
 * Source de tickets Azure DevOps : un epic ou une feature, et sa descendance.
 *
 * Lecture seule : seuls les points d'API de lecture des work items sont appelés.
 * Fonctionne avec Azure DevOps Services (dev.azure.com) comme avec un
 * Azure DevOps Server installé ; seule l'URL d'organisation change.
 */

import * as azdev from 'azure-devops-node-api';
import type { IWorkItemTrackingApi } from 'azure-devops-node-api/WorkItemTrackingApi.js';
import type {
  WorkItem,
  WorkItemRelation
} from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces.js';
import type {
  CancellationLike,
  DeclaredDependency,
  Ticket,
  TicketLevel,
  TicketSource
} from '../core/model.js';
import { htmlToMarkdown } from '../core/html.js';

const MAX_DEPTH = 4;

/** Les relations de work items utilisées, telles qu'Azure DevOps les nomme. */
const REL_CHILD = 'System.LinkTypes.Hierarchy-Forward';
const REL_PREDECESSOR = 'System.LinkTypes.Dependency-Reverse';
const REL_SUCCESSOR = 'System.LinkTypes.Dependency-Forward';
const REL_ATTACHMENT = 'AttachedFile';

export interface AzureDevOpsSourceOptions {
  orgUrl: string;
  project: string;
  /** PAT limité à la lecture des work items. */
  token: string;
}

export class AzureDevOpsTicketSource implements TicketSource {
  readonly kind = 'azureDevOps' as const;
  private api: IWorkItemTrackingApi | undefined;

  constructor(private readonly options: AzureDevOpsSourceOptions) {}

  async probe(): Promise<void> {
    const api = await this.getApi();
    // Le plus léger des appels de lecture : la liste des types de work items du projet.
    await api.getWorkItemTypes(this.options.project);
  }

  async fetchTree(rootId: string, cancellation?: CancellationLike): Promise<Ticket[]> {
    const id = parseWorkItemId(rootId);
    const out: Ticket[] = [];
    const seen = new Set<number>();
    await this.walk(id, undefined, 0, out, seen, cancellation);
    if (out.length === 0) {
      throw new Error(`Le work item ${id} est introuvable dans le projet ${this.options.project}.`);
    }
    return out;
  }

  private async getApi(): Promise<IWorkItemTrackingApi> {
    if (!this.api) {
      const auth = azdev.getPersonalAccessTokenHandler(this.options.token);
      const connection = new azdev.WebApi(this.options.orgUrl, auth);
      this.api = await connection.getWorkItemTrackingApi();
    }
    return this.api;
  }

  private async walk(
    id: number,
    parentId: string | undefined,
    depth: number,
    out: Ticket[],
    seen: Set<number>,
    cancellation?: CancellationLike
  ): Promise<void> {
    if (cancellation?.isCancellationRequested || depth > MAX_DEPTH || seen.has(id)) {
      return;
    }
    seen.add(id);

    const api = await this.getApi();
    // `All` donne les relations, nécessaires pour la descendance et les dépendances.
    const item = await api.getWorkItem(id, undefined, undefined, 1 /* Relations */);
    if (!item?.id) {
      return;
    }

    out.push(this.toTicket(item, parentId));

    const children = relationIds(item.relations, REL_CHILD);
    for (const child of children) {
      await this.walk(child, String(item.id), depth + 1, out, seen, cancellation);
    }
  }

  private toTicket(item: WorkItem, parentId: string | undefined): Ticket {
    const fields = item.fields ?? {};
    const str = (key: string): string => {
      const value = fields[key];
      return typeof value === 'string' ? value : '';
    };
    const num = (key: string): number | undefined => {
      const value = fields[key];
      return typeof value === 'number' ? value : undefined;
    };

    const ticket: Ticket = {
      sourceId: String(item.id),
      level: levelForType(str('System.WorkItemType')),
      title: str('System.Title'),
      description: htmlToMarkdown(str('System.Description')),
      acceptanceCriteria: htmlToMarkdown(str('Microsoft.VSTS.Common.AcceptanceCriteria')),
      state: str('System.State'),
      revision: String(item.rev ?? ''),
      webUrl: this.webUrl(item),
      dependencies: this.dependencies(item.relations),
      attachments: (item.relations ?? [])
        .filter((r) => r.rel === REL_ATTACHMENT && r.url)
        .map((r) => ({
          name: typeof r.attributes?.['name'] === 'string' ? r.attributes['name'] : 'piece-jointe',
          url: r.url as string
        }))
    };

    if (parentId !== undefined) {
      ticket.parentId = parentId;
    }
    const points = num('Microsoft.VSTS.Scheduling.StoryPoints');
    if (points !== undefined) {
      ticket.storyPoints = points;
    }
    const priority = num('Microsoft.VSTS.Common.Priority');
    if (priority !== undefined) {
      ticket.priority = priority;
    }
    return ticket;
  }

  private dependencies(relations: WorkItemRelation[] | undefined): DeclaredDependency[] {
    const deps: DeclaredDependency[] = [];
    for (const id of relationIds(relations, REL_PREDECESSOR)) {
      deps.push({ kind: 'blockedBy', sourceId: String(id) });
    }
    for (const id of relationIds(relations, REL_SUCCESSOR)) {
      deps.push({ kind: 'blocks', sourceId: String(id) });
    }
    return deps;
  }

  /** L'URL de l'interface web, que l'API ne renvoie pas directement. */
  private webUrl(item: WorkItem): string {
    const fromLinks = (item._links as { html?: { href?: string } } | undefined)?.html?.href;
    if (fromLinks) {
      return fromLinks;
    }
    const base = this.options.orgUrl.replace(/\/+$/, '');
    return `${base}/${encodeURIComponent(this.options.project)}/_workitems/edit/${item.id}`;
  }
}

/** Les identifiants de work items liés par une relation donnée. */
function relationIds(relations: WorkItemRelation[] | undefined, rel: string): number[] {
  const ids: number[] = [];
  for (const relation of relations ?? []) {
    if (relation.rel !== rel || !relation.url) {
      continue;
    }
    const match = /\/workItems\/(\d+)$/i.exec(relation.url);
    if (match?.[1]) {
      ids.push(Number(match[1]));
    }
  }
  return ids;
}

export function levelForType(workItemType: string): TicketLevel {
  const type = workItemType.trim().toLowerCase();
  if (type === 'epic') {
    return 'epic';
  }
  if (type === 'feature') {
    return 'feature';
  }
  return 'story';
}

/** `1234`, `#1234` ou une URL de work item donnent tous 1234. */
export function parseWorkItemId(raw: string): number {
  const trimmed = raw.trim();
  const fromUrl = /_workitems\/edit\/(\d+)/i.exec(trimmed);
  const digits = fromUrl?.[1] ?? /^#?(\d+)$/.exec(trimmed)?.[1];
  if (!digits) {
    throw new Error(
      `Identifiant Azure DevOps non reconnu : « ${raw} ». Attendu : 1234, #1234 ou une URL de work item.`
    );
  }
  return Number(digits);
}
