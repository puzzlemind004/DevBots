import { describe, expect, it } from 'vitest';
import type {
  Wiql,
  WorkItem,
  WorkItemRelation
} from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces.js';
import {
  AzureDevOpsTicketSource,
  CANDIDATES_WIQL,
  MAX_LISTED_WORK_ITEMS,
  toCandidate
} from '../../src/sources/azureDevOps.js';

const ORG = 'https://dev.azure.com/acme';

function rel(kind: 'child' | 'parent', id: number): WorkItemRelation {
  return {
    rel:
      kind === 'child'
        ? 'System.LinkTypes.Hierarchy-Forward'
        : 'System.LinkTypes.Hierarchy-Reverse',
    url: `${ORG}/_apis/wit/workItems/${id}`
  };
}

function workItem(id: number, type: string, relations: WorkItemRelation[] = []): WorkItem {
  return {
    id,
    rev: 1,
    fields: {
      'System.Title': `Item ${id}`,
      'System.WorkItemType': type,
      'System.State': 'Active',
      'System.ChangedDate': new Date('2026-10-01T10:00:00Z'),
      'System.CreatedBy': { displayName: 'Quentin Charrier' },
      'System.Tags': 'front; urgent'
    },
    relations
  };
}

/** Une fausse API de work items : un dictionnaire et la trace des lectures. */
class FakeWorkItems {
  readonly batches: number[][] = [];
  queries: string[] = [];

  constructor(
    private readonly items: Map<number, WorkItem>,
    private readonly queryIds: number[] = []
  ) {}

  async queryByWiql(wiql: Wiql, _team: unknown, _precision: unknown, top?: number) {
    this.queries.push(wiql.query ?? '');
    return { workItems: this.queryIds.slice(0, top).map((id) => ({ id })) };
  }

  async getWorkItems(ids: number[]) {
    this.batches.push(ids);
    // Ordre inversé : la source doit rétablir celui de la requête.
    return ids.map((id) => this.items.get(id)).filter(Boolean).reverse();
  }

  async getWorkItem(id: number) {
    return this.items.get(id);
  }
}

function sourceWith(api: FakeWorkItems): AzureDevOpsTicketSource {
  const source = new AzureDevOpsTicketSource({ orgUrl: ORG, project: 'Web', token: 't' });
  // La connexion réelle est remplacée par la fausse API.
  (source as unknown as { api: FakeWorkItems }).api = api;
  return source;
}

describe('toCandidate', () => {
  it('donne le niveau, le parent, les enfants, les tags et l’auteur', () => {
    const candidate = toCandidate(
      workItem(12, 'Feature', [rel('parent', 3), rel('child', 20), rel('child', 21)]),
      'https://example/12'
    );
    expect(candidate).toEqual({
      sourceId: '12',
      title: 'Item 12',
      level: 'feature',
      labels: ['front', 'urgent'],
      childCount: 2,
      parentId: '3',
      authorLogin: 'Quentin Charrier',
      updatedAt: '2026-10-01T10:00:00.000Z',
      webUrl: 'https://example/12'
    });
  });

  it('range un Product Backlog Item parmi les stories', () => {
    expect(toCandidate(workItem(5, 'Product Backlog Item'), '').level).toBe('story');
  });
});

describe('AzureDevOpsTicketSource.listCandidates', () => {
  it('liste les work items ouverts dans l’ordre de la requête, par lots de 200', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const api = new FakeWorkItems(new Map(ids.map((id) => [id, workItem(id, 'User Story')])), ids);
    const listing = await sourceWith(api).listCandidates();

    expect(api.queries).toEqual([CANDIDATES_WIQL]);
    expect(api.batches.map((b) => b.length)).toEqual([200, 50]);
    expect(listing.candidates.map((c) => c.sourceId).slice(0, 3)).toEqual(['1', '2', '3']);
    expect(listing.truncated).toBe(false);
    expect(listing.hiddenCount).toBe(0);
  });

  it('signale une liste coupée au plafond', async () => {
    const ids = Array.from({ length: MAX_LISTED_WORK_ITEMS + 5 }, (_, i) => i + 1);
    const api = new FakeWorkItems(new Map(ids.map((id) => [id, workItem(id, 'Epic')])), ids);
    const listing = await sourceWith(api).listCandidates();
    expect(listing.truncated).toBe(true);
    expect(listing.candidates).toHaveLength(MAX_LISTED_WORK_ITEMS);
  });
});

describe('AzureDevOpsTicketSource.fetchTickets', () => {
  it('relit les stories demandées, avec leur parent, sans leur descendance ni les absentes', async () => {
    const api = new FakeWorkItems(
      new Map([
        [11, workItem(11, 'User Story', [rel('parent', 10)])],
        [12, workItem(12, 'User Story', [rel('child', 13)])],
        [13, workItem(13, 'Task')]
      ])
    );
    const tickets = await sourceWith(api).fetchTickets(['11', '#12', '99', '11']);
    expect(api.batches).toEqual([[11, 12, 99]]);
    expect(tickets.map((t) => [t.sourceId, t.parentId]).sort()).toEqual([
      ['11', '10'],
      ['12', undefined]
    ]);
  });
});

describe('AzureDevOpsTicketSource.fetchTree', () => {
  it('ramène la feature parente d’une story choisie seule, sans ses autres stories', async () => {
    const api = new FakeWorkItems(
      new Map([
        [10, workItem(10, 'Feature', [rel('child', 11), rel('child', 12)])],
        [11, workItem(11, 'User Story', [rel('parent', 10)])],
        [12, workItem(12, 'User Story', [rel('parent', 10)])]
      ])
    );
    const tickets = await sourceWith(api).fetchTree('11');
    expect(tickets.map((t) => [t.sourceId, t.level, t.parentId])).toEqual([
      ['10', 'feature', undefined],
      ['11', 'story', '10']
    ]);
  });

  it('ne remonte pas au-dessus d’une feature choisie', async () => {
    const api = new FakeWorkItems(
      new Map([
        [1, workItem(1, 'Epic', [rel('child', 10)])],
        [10, workItem(10, 'Feature', [rel('parent', 1), rel('child', 11)])],
        [11, workItem(11, 'User Story', [rel('parent', 10)])]
      ])
    );
    const tickets = await sourceWith(api).fetchTree('10');
    expect(tickets.map((t) => t.sourceId)).toEqual(['10', '11']);
    expect(tickets[0]?.parentId).toBeUndefined();
  });
});
