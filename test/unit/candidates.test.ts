import { describe, expect, it } from 'vitest';
import {
  isTrustedIssue,
  selectCandidates,
  type GitHubListedIssue,
  type TrustFilter
} from '../../src/sources/github.js';
import { mergeTrees } from '../../src/core/mergeTrees.js';
import type { Ticket } from '../../src/core/model.js';

function issue(overrides: Partial<GitHubListedIssue> = {}): GitHubListedIssue {
  return {
    number: 1,
    title: 'Une issue',
    body: null,
    state: 'open',
    updated_at: '2026-10-01T10:00:00Z',
    html_url: 'https://github.com/acme/web/issues/1',
    user: { login: 'quentin' },
    labels: [],
    ...overrides
  };
}

const strict: TrustFilter = {
  trustedAuthorsOnly: true,
  trustedAuthorLogin: 'Quentin',
  trustedLabel: 'devbots'
};

describe('isTrustedIssue', () => {
  it("retient les issues de l'utilisateur, sans tenir compte de la casse", () => {
    expect(isTrustedIssue(issue(), strict)).toBe(true);
  });

  it('retient une issue étrangère qui porte le label de confiance', () => {
    const labelled = issue({ user: { login: 'inconnu' }, labels: [{ name: 'DevBots' }] });
    expect(isTrustedIssue(labelled, strict)).toBe(true);
  });

  it('écarte une issue étrangère sans label', () => {
    expect(isTrustedIssue(issue({ user: { login: 'inconnu' } }), strict)).toBe(false);
  });

  it('retient tout quand le filtre est coupé', () => {
    const filter: TrustFilter = { trustedAuthorsOnly: false };
    expect(isTrustedIssue(issue({ user: null }), filter)).toBe(true);
  });
});

describe('selectCandidates', () => {
  it('retire les pull requests sans les compter comme masquées', () => {
    const { candidates, hiddenCount } = selectCandidates(
      [issue({ number: 1 }), issue({ number: 2, pull_request: {} })],
      strict
    );
    expect(candidates.map((c) => c.sourceId)).toEqual(['1']);
    expect(hiddenCount).toBe(0);
  });

  it('compte les issues écartées par le filtre', () => {
    const { candidates, hiddenCount } = selectCandidates(
      [issue({ number: 1 }), issue({ number: 2, user: { login: 'inconnu' } })],
      strict
    );
    expect(candidates).toHaveLength(1);
    expect(hiddenCount).toBe(1);
  });

  it('reprend le nombre de sub-issues et les labels', () => {
    const { candidates } = selectCandidates(
      [issue({ number: 7, labels: ['epic', { name: 'front' }], sub_issues_summary: { total: 3 } })],
      strict
    );
    expect(candidates[0]).toMatchObject({
      sourceId: '7',
      labels: ['epic', 'front'],
      childCount: 3,
      authorLogin: 'quentin'
    });
  });

  it("laisse le nombre de sub-issues absent quand l'API ne le donne pas", () => {
    const { candidates } = selectCandidates([issue()], strict);
    expect(candidates[0]?.childCount).toBeUndefined();
  });
});

describe('mergeTrees', () => {
  function ticket(sourceId: string, parentId?: string): Ticket {
    const t: Ticket = {
      sourceId,
      level: 'story',
      title: `Story ${sourceId}`,
      description: '',
      acceptanceCriteria: '',
      state: 'open',
      revision: 'r1',
      webUrl: '',
      dependencies: [],
      attachments: []
    };
    if (parentId !== undefined) {
      t.parentId = parentId;
    }
    return t;
  }

  it('ne garde chaque ticket qu’une fois', () => {
    const merged = mergeTrees([[ticket('1'), ticket('2')], [ticket('2'), ticket('3')]]);
    expect(merged.map((t) => t.sourceId)).toEqual(['1', '2', '3']);
  });

  it('préfère la version rattachée à son parent, quel que soit l’ordre', () => {
    const alone = [ticket('5')];
    const underParent = [ticket('4'), ticket('5', '4')];
    expect(mergeTrees([alone, underParent]).find((t) => t.sourceId === '5')?.parentId).toBe('4');
    expect(mergeTrees([underParent, alone]).find((t) => t.sourceId === '5')?.parentId).toBe('4');
  });
});
