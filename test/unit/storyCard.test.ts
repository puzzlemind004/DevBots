import { describe, expect, it } from 'vitest';
import matter from 'gray-matter';
import { renderStoryCard, slugify, storyFileName } from '../../src/core/storyCard.js';
import type { Ticket } from '../../src/core/model.js';

const baseTicket: Ticket = {
  sourceId: '42',
  level: 'story',
  title: "Valider l'email à l'inscription",
  description: 'Le formulaire doit refuser un email invalide.',
  acceptanceCriteria: '- Un email invalide affiche une erreur',
  state: 'open',
  revision: '2026-10-01T10:00:00Z',
  webUrl: 'https://github.com/acme/web/issues/42',
  dependencies: [],
  attachments: []
};

describe('slugify', () => {
  it('retire les accents et la ponctuation', () => {
    expect(slugify("Valider l'email à l'inscription")).toBe('valider-l-email-a-l-inscription');
  });

  it('coupe sur un tiret sans laisser de mot tronqué', () => {
    const slug = slugify(
      'Refondre entièrement le parcours de souscription avec validation progressive'
    );
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug).not.toContain('--');
  });

  it('ne rend jamais une chaîne vide', () => {
    expect(slugify('!!! ???')).toBe('story');
  });
});

describe('storyFileName', () => {
  it("préfixe par l'identifiant de la source", () => {
    expect(storyFileName(baseTicket)).toBe('42-valider-l-email-a-l-inscription.md');
  });
});

describe('renderStoryCard', () => {
  const importedAt = new Date('2026-10-13T08:00:00Z');

  it('écrit un frontmatter relisible par gray-matter', () => {
    const card = renderStoryCard(baseTicket, 'github', importedAt);
    const parsed = matter(card);
    expect(parsed.data.source).toBe('github');
    expect(parsed.data.source_id).toBe('42');
    expect(parsed.data.source_rev).toBe('2026-10-01T10:00:00Z');
    expect(parsed.data.parent).toBeNull();
    expect(parsed.data.imported_at).toBe('2026-10-13T08:00:00.000Z');
    expect(parsed.data.title).toBe("Valider l'email à l'inscription");
  });

  it('échappe les guillemets du titre sans casser le YAML', () => {
    const card = renderStoryCard(
      { ...baseTicket, title: 'Gérer le cas "limite" du panier' },
      'github',
      importedAt
    );
    expect(matter(card).data.title).toBe('Gérer le cas "limite" du panier');
  });

  it('liste les dépendances déclarées dans le frontmatter et dans le corps', () => {
    const card = renderStoryCard(
      {
        ...baseTicket,
        dependencies: [
          { kind: 'blockedBy', sourceId: '40', title: 'Créer le service' },
          { kind: 'blocks', sourceId: '45' }
        ]
      },
      'github',
      importedAt
    );
    const parsed = matter(card);
    // Seules les dépendances bloquantes comptent pour l'ordonnancement.
    expect(parsed.data.dependencies).toEqual(['40']);
    expect(parsed.content).toContain('Bloquée par : 40 — Créer le service');
    expect(parsed.content).toContain('Bloque : 45');
  });

  it('remplit les sections vides par une mention explicite', () => {
    const card = renderStoryCard(
      { ...baseTicket, description: '', acceptanceCriteria: '' },
      'azureDevOps',
      importedAt
    );
    expect(card).toContain('_Aucune description dans la source._');
    expect(card).toContain('À extraire à la planification');
  });

  it('reporte les champs Azure DevOps quand ils existent', () => {
    const card = renderStoryCard(
      { ...baseTicket, storyPoints: 5, priority: 2, parentId: '30' },
      'azureDevOps',
      importedAt
    );
    const parsed = matter(card);
    expect(parsed.data.story_points).toBe(5);
    expect(parsed.data.priority).toBe(2);
    expect(parsed.data.parent).toBe('30');
  });
});
