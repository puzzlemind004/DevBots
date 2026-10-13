import { describe, expect, it } from 'vitest';
import matter from 'gray-matter';
import {
  isIncomplete,
  nextLocalId,
  renderFeatureCard,
  renderLocalStoryCard
} from '../../src/core/localCards.js';
import { readPlanContext } from '../../src/core/planRender.js';

const CREATED = new Date('2026-10-13T08:00:00.000Z');

describe('nextLocalId', () => {
  it('commence à 1', () => {
    expect(nextLocalId('LOCAL-', [])).toBe('LOCAL-1');
  });

  it('prend le plus grand numéro plus un, sans réattribuer un trou', () => {
    expect(nextLocalId('LOCAL-', ['LOCAL-1', 'LOCAL-3', '42'])).toBe('LOCAL-4');
  });

  it('ne confond pas les stories et les features', () => {
    expect(nextLocalId('LOCAL-', ['LOCAL-F7'])).toBe('LOCAL-1');
    expect(nextLocalId('LOCAL-F', ['LOCAL-7', 'LOCAL-F2'])).toBe('LOCAL-F3');
  });
});

describe('renderLocalStoryCard', () => {
  const card = renderLocalStoryCard({
    id: 'LOCAL-2',
    title: 'Valider : le format',
    parent: 'LOCAL-F1',
    createdAt: CREATED
  });

  it('écrit un frontmatter local, sans champ de source', () => {
    const { data } = matter(card);
    expect(data).toEqual({
      source: 'local',
      source_id: 'LOCAL-2',
      parent: 'LOCAL-F1',
      created_at: '2026-10-13T08:00:00.000Z',
      title: 'Valider : le format',
      state: 'open'
    });
  });

  it("ne donne aucun critère à l'atelier tant que la fiche n'est pas remplie", () => {
    expect(readPlanContext(card).criteria).toEqual([]);
    expect(isIncomplete(card)).toBe(true);
  });

  it('accepte une story sans feature', () => {
    const { data } = matter(
      renderLocalStoryCard({ id: 'LOCAL-1', title: 'Seule', parent: null, createdAt: CREATED })
    );
    expect(data.parent).toBeNull();
  });
});

describe('renderFeatureCard', () => {
  it('écrit une fiche de feature à compléter', () => {
    const card = renderFeatureCard({ id: 'LOCAL-F1', title: 'Inscription', createdAt: CREATED });
    const { data, content } = matter(card);
    expect(data.level).toBe('feature');
    expect(data.source_id).toBe('LOCAL-F1');
    expect(content).toContain('# Inscription');
    expect(isIncomplete(card)).toBe(true);
  });
});

describe('isIncomplete', () => {
  it('reconnaît une fiche remplie', () => {
    expect(isIncomplete('# Titre\n\n## Description\n\nUn vrai besoin.\n')).toBe(false);
  });
});
