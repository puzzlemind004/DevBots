import { describe, expect, it } from 'vitest';
import { alreadyImported } from '../../src/core/candidates.js';
import type { TicketCandidate } from '../../src/core/model.js';

function candidate(sourceId: string, overrides: Partial<TicketCandidate> = {}): TicketCandidate {
  return {
    sourceId,
    title: `Ticket ${sourceId}`,
    labels: [],
    updatedAt: '2026-10-01T10:00:00Z',
    webUrl: `https://example.test/${sourceId}`,
    ...overrides
  };
}

describe('alreadyImported', () => {
  it('masque une story dont la fiche existe, et seulement elle', () => {
    const hidden = alreadyImported(
      [candidate('1'), candidate('2')],
      [{ sourceId: '1', parent: null }],
      []
    );
    expect([...hidden]).toEqual(['1']);
  });

  it('masque une issue parente GitHub dont toutes les sub-issues sont importées', () => {
    const stories = [
      { sourceId: '11', parent: '10' },
      { sourceId: '12', parent: '10' }
    ];
    const listing = [candidate('10', { childCount: 2 }), candidate('11'), candidate('12')];
    expect(alreadyImported(listing, stories, [{ sourceId: '10' }])).toEqual(
      new Set(['10', '11', '12'])
    );
  });

  it('garde une issue parente qui a une sub-issue de plus que les fiches', () => {
    const listing = [candidate('10', { childCount: 3 })];
    const stories = [
      { sourceId: '11', parent: '10' },
      { sourceId: '12', parent: '10' }
    ];
    expect(alreadyImported(listing, stories, [{ sourceId: '10' }]).size).toBe(0);
  });

  it("garde un epic tant qu'une de ses features n'est pas complète", () => {
    const listing = [
      candidate('1', { level: 'epic', childCount: 2 }),
      candidate('2', { level: 'feature', childCount: 1, parentId: '1' }),
      candidate('3', { level: 'feature', childCount: 2, parentId: '1' }),
      candidate('20', { level: 'story', parentId: '2' }),
      candidate('30', { level: 'story', parentId: '3' }),
      candidate('31', { level: 'story', parentId: '3' })
    ];
    const features = [
      { sourceId: '2', parent: '1' },
      { sourceId: '3', parent: '1' }
    ];
    const stories = [
      { sourceId: '20', parent: '2' },
      { sourceId: '30', parent: '3' }
    ];
    expect(alreadyImported(listing, stories, features)).toEqual(new Set(['2', '20', '30']));

    const complete = alreadyImported(listing, [...stories, { sourceId: '31', parent: '3' }], features);
    expect(complete.has('1')).toBe(true);
  });

  it("compte un enfant fermé, absent de la liste, d'après sa fiche", () => {
    const listing = [candidate('2', { level: 'feature', childCount: 2 })];
    const stories = [
      { sourceId: '20', parent: '2' },
      { sourceId: '21', parent: '2' }
    ];
    expect(alreadyImported(listing, stories, []).has('2')).toBe(true);
  });

  it('garde une feature sans enfant, ou dont le nombre est inconnu', () => {
    const listing = [
      candidate('2', { level: 'feature', childCount: 0 }),
      candidate('3', { level: 'feature' })
    ];
    expect(alreadyImported(listing, [], [{ sourceId: '2' }, { sourceId: '3' }]).size).toBe(0);
  });
});
