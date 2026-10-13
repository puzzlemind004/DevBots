import { describe, expect, it } from 'vitest';
import matter from 'gray-matter';
import {
  fillTemplate,
  parseCriteria,
  readPlanContext,
  renderPlanMarkdown,
  renderReadyCard
} from '../../src/core/planRender.js';
import { SAMPLE_CARD, samplePlan } from './fixtures.js';

describe('parseCriteria', () => {
  it('lit les éléments de liste, cases à cocher comprises', () => {
    expect(parseCriteria('- un\n* [ ] deux\n1. trois\n2) quatre')).toEqual(['un', 'deux', 'trois', 'quatre']);
  });

  it('prend les lignes quand il n\'y a pas de liste', () => {
    expect(parseCriteria('Premier critère.\n\nSecond critère.')).toEqual(['Premier critère.', 'Second critère.']);
  });

  it('ignore la mention « à extraire »', () => {
    expect(parseCriteria("_Aucun critère dans la source. À extraire à la planification._")).toEqual([]);
  });
});

describe('readPlanContext', () => {
  it('extrait critères et dépendances déclarées', () => {
    expect(readPlanContext(SAMPLE_CARD)).toEqual({
      criteria: ['Un email invalide est refusé', 'Un message explique pourquoi'],
      declaredDependencies: ['40']
    });
  });
});

describe('renderPlanMarkdown', () => {
  it('rend une section par partie du plan', () => {
    const md = renderPlanMarkdown(samplePlan(), 'Valider', 2);
    expect(md).toContain('# Plan — Valider (v2)');
    for (const heading of ['Compréhension', 'Couverture', 'Étapes', 'Tests', 'Dépendances et risques', 'Exécution']) {
      expect(md).toContain(`## ${heading}`);
    }
    expect(md).toContain('**C1** Un email invalide est refusé → étape 1');
    expect(md).toContain('`src/app/email.validator.ts`');
    expect(md).toContain('40 : confirmée');
  });
});

describe('fillTemplate', () => {
  it('remplace les marqueurs connus et laisse les autres', () => {
    expect(fillTemplate('{{ title }} / {{inconnu}}', { title: 'T' })).toBe('T / {{inconnu}}');
  });

  it("n'interprète pas les motifs spéciaux dans les valeurs", () => {
    expect(fillTemplate('{{title}}', { title: "$& et $'" })).toBe("$& et $'");
  });
});

describe('renderReadyCard', () => {
  const input = {
    rawCard: SAMPLE_CARD,
    plan: samplePlan(),
    version: 3,
    planPath: 'plans/42/v3.json',
    plannedAt: new Date('2026-10-14T09:00:00Z')
  };

  it('garde le frontmatter et ajoute ce que l\'orchestrateur réutilisera', () => {
    const parsed = matter(renderReadyCard(input));
    expect(parsed.data).toMatchObject({
      source_id: '42',
      title: "Valider l'email à l'inscription",
      plan: 'plans/42/v3.json',
      plan_version: 3,
      recommended_model: 'sonnet',
      complexity: 'low',
      dependencies_confirmed: ['40'],
      dependencies_refuted: [],
      files: ['src/app/email.validator.ts', 'src/app/signup.component.html']
    });
  });

  it('remplit le gabarit par défaut avec la story et le plan', () => {
    const { content } = matter(renderReadyCard(input));
    expect(content).toContain("# Valider l'email à l'inscription");
    expect(content.match(/^# Valider/gm)).toHaveLength(1);
    expect(content).toContain("Le formulaire accepte n'importe quoi.");
    expect(content).toContain('## Étapes');
    expect(content.match(/\[Ouvrir dans la source\]/g)).toHaveLength(1);
  });

  it('utilise le gabarit du dépôt', () => {
    const { content } = matter(
      renderReadyCard({ ...input, template: 'Story {{source_id}}\n\n{{plan}}\n\nModèle : {{modele}}' })
    );
    expect(content).toContain('Story 42');
    expect(content).toContain('## Couverture');
    expect(content).toContain('Modèle : sonnet');
  });

  it('efface le marquage « à revoir »', () => {
    const card = SAMPLE_CARD.replace('state: "open"', 'state: "open"\nneeds_review: true\nsource_rev_seen: "x"');
    const parsed = matter(renderReadyCard({ ...input, rawCard: card }));
    expect(parsed.data.needs_review).toBeUndefined();
    expect(parsed.data.source_rev_seen).toBeUndefined();
  });
});
