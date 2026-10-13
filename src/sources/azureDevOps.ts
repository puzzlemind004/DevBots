/**
 * Source de tickets Azure DevOps : un work item et sa descendance.
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
  CandidateListing,
  DeclaredDependency,
  Ticket,
  TicketCandidate,
  TicketLevel,
  TicketSource
} from '../core/model.js';
import { htmlToMarkdown } from '../core/html.js';

const MAX_DEPTH = 4;

/** Plafond de la liste des work items ouverts : au-delà, la saisie d'un ID reste possible. */
export const MAX_LISTED_WORK_ITEMS = 1000;

/** L'API refuse plus de 200 identifiants par lecture groupée. */
const READ_BATCH = 200;

/**
 * Les work items proposés à l'import : epics, features et stories ouverts.
 *
 * Les catégories de types couvrent tous les processus (User Story en Agile,
 * Product Backlog Item en Scrum, Requirement en CMMI, Issue en Basic). Les
 * états exclus sont les états terminaux des processus standard ; un processus
 * personnalisé aux états renommés laissera passer les siens.
 */
export const CANDIDATES_WIQL = [
  'SELECT [System.Id] FROM WorkItems',
  'WHERE [System.TeamProject] = @project',
  "AND ([System.WorkItemType] IN GROUP 'Microsoft.EpicCategory'",
  "  OR [System.WorkItemType] IN GROUP 'Microsoft.FeatureCategory'",
  "  OR [System.WorkItemType] IN GROUP 'Microsoft.RequirementCategory')",
  "AND [System.State] NOT IN ('Closed', 'Done', 'Removed')",
  'ORDER BY [System.ChangedDate] DESC'
].join('\n');

/** Les relations de work items utilisées, telles qu'Azure DevOps les nomme. */
const REL_CHILD = 'System.LinkTypes.Hierarchy-Forward';
const REL_PARENT = 'System.LinkTypes.Hierarchy-Reverse';
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

  async listCandidates(cancellation?: CancellationLike): Promise<CandidateListing> {
    const api = await this.getApi();
    const result = await api.queryByWiql(
      { query: CANDIDATES_WIQL },
      { project: this.options.project },
      undefined,
      MAX_LISTED_WORK_ITEMS + 1
    );
    const ids = (result.workItems ?? [])
      .map((ref) => ref.id)
      .filter((id): id is number => typeof id === 'number');
    // Un identifiant de plus que le plafond : c'est ainsi qu'on sait la liste coupée.
    const truncated = ids.length > MAX_LISTED_WORK_ITEMS;
    ids.length = Math.min(ids.length, MAX_LISTED_WORK_ITEMS);

    const items: WorkItem[] = [];
    for (let i = 0; i < ids.length; i += READ_BATCH) {
      if (cancellation?.isCancellationRequested) {
        break;
      }
      // Les relations donnent le nombre d'enfants et le parent ; l'API refuse de
      // les combiner avec une liste de champs, d'où la lecture complète.
      const batch = await api.getWorkItems(ids.slice(i, i + READ_BATCH), undefined, undefined, 1 /* Relations */);
      items.push(...(batch ?? []).filter((item) => item?.id !== undefined));
    }
    // La lecture groupée ne garantit pas l'ordre : on garde celui de la requête.
    const rank = new Map(ids.map((id, index) => [id, index]));
    items.sort((a, b) => (rank.get(a.id ?? 0) ?? 0) - (rank.get(b.id ?? 0) ?? 0));

    return {
      candidates: items.map((item) => toCandidate(item, this.webUrl(item))),
      hiddenCount: 0,
      truncated
    };
  }

  async fetchTree(rootId: string, cancellation?: CancellationLike): Promise<Ticket[]> {
    const id = parseWorkItemId(rootId);
    const walk: Walk = { out: [], seen: new Set<number>() };
    await this.walk(id, undefined, 0, walk, cancellation);
    const root = walk.out[0];
    if (!root) {
      throw new Error(`Le work item ${id} est introuvable dans le projet ${this.options.project}.`);
    }
    // Une story choisie seule vient avec sa feature, sans les autres stories de
    // celle-ci : sa fiche reste ainsi rangée sous la feature.
    if (root.level === 'story' && walk.rootParent !== undefined) {
      const api = await this.getApi();
      const parent = await api.getWorkItem(walk.rootParent);
      if (parent?.id) {
        root.parentId = String(parent.id);
        walk.out.unshift(this.toTicket(parent, undefined));
      }
    }
    return walk.out;
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
    walk: Walk,
    cancellation?: CancellationLike
  ): Promise<void> {
    if (cancellation?.isCancellationRequested || depth > MAX_DEPTH || walk.seen.has(id)) {
      return;
    }
    walk.seen.add(id);

    const api = await this.getApi();
    // `All` donne les relations, nécessaires pour la descendance et les dépendances.
    const item = await api.getWorkItem(id, undefined, undefined, 1 /* Relations */);
    if (!item?.id) {
      return;
    }

    walk.out.push(this.toTicket(item, parentId));
    if (depth === 0) {
      walk.rootParent = relationIds(item.relations, REL_PARENT)[0];
    }

    const children = relationIds(item.relations, REL_CHILD);
    for (const child of children) {
      await this.walk(child, String(item.id), depth + 1, walk, cancellation);
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

/** L'état d'un parcours de descendance. */
interface Walk {
  out: Ticket[];
  seen: Set<number>;
  /** Parent de la racine chez Azure DevOps, hors du périmètre parcouru. */
  rootParent?: number;
}

/** Un work item de la liste d'import, réduit à ce que la liste à cocher affiche. */
export function toCandidate(item: WorkItem, webUrl: string): TicketCandidate {
  const fields = item.fields ?? {};
  const str = (key: string): string => {
    const value: unknown = fields[key];
    return typeof value === 'string' ? value : '';
  };
  const changed: unknown = fields['System.ChangedDate'];
  // `System.CreatedBy` est une identité ; certains serveurs anciens renvoient une chaîne.
  const createdBy: unknown = fields['System.CreatedBy'];
  const author =
    typeof createdBy === 'string'
      ? createdBy
      : (createdBy as { displayName?: string } | undefined)?.displayName;

  const candidate: TicketCandidate = {
    sourceId: String(item.id),
    title: str('System.Title'),
    level: levelForType(str('System.WorkItemType')),
    labels: str('System.Tags')
      .split(';')
      .map((t) => t.trim())
      .filter(Boolean),
    childCount: relationIds(item.relations, REL_CHILD).length,
    updatedAt: changed instanceof Date ? changed.toISOString() : String(changed ?? ''),
    webUrl
  };
  const parent = relationIds(item.relations, REL_PARENT)[0];
  if (parent !== undefined) {
    candidate.parentId = String(parent);
  }
  if (author) {
    candidate.authorLogin = author;
  }
  return candidate;
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
