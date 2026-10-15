import { describe, expect, it } from 'vitest';
import matter from 'gray-matter';
import {
  fillTemplate,
  parseCriteria,
  prose,
  readPlanContext,
  renderPlanMarkdown,
  renderReadyCard,
  renderSection
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

  it('s’arrête au trait horizontal du pied de fiche', () => {
    const section = [
      "_Aucun critère dans la source. À extraire à la planification._",
      '',
      '---',
      '',
      '[Ouvrir dans la source](https://github.com/o/r/issues/73)'
    ].join('\n');
    expect(parseCriteria(section)).toEqual([]);
    expect(parseCriteria('- un\n- deux\n\n---\n\n[Ouvrir dans la source](u)')).toEqual(['un', 'deux']);
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

describe('renderSection — étapes', () => {
  const steps = [1, 2, 10].map((id) => ({
    id,
    title: `Titre ${id}`,
    approach: "Exposer le service.\n- Créer `Foo`\n- Brancher l'injection",
    files: ['src/a.ts', 'src/b.ts']
  }));
  const md = renderSection(samplePlan({ steps }), 'steps');

  it('donne un sous-titre à chaque étape, y compris au-delà de 9', () => {
    expect(md.match(/^### Étape \d+ — Titre \d+$/gm)).toEqual([
      '### Étape 1 — Titre 1',
      '### Étape 2 — Titre 2',
      '### Étape 10 — Titre 10'
    ]);
  });

  it('sépare le but, les actions et les fichiers par une ligne vide', () => {
    expect(md).toContain(
      "### Étape 10 — Titre 10\n\nExposer le service.\n\n- Créer `Foo`\n- Brancher l'injection\n\nFichiers : `src/a.ts`, `src/b.ts`"
    );
  });

  it("n'indente rien", () => {
    expect(md).not.toMatch(/^ +\S/m);
  });
});

describe('prose', () => {
  it('ajoute une ligne vide avant et après une liste', () => {
    expect(prose('But.\n- a\n- b\nSuite.')).toBe('But.\n\n- a\n- b\n\nSuite.');
  });

  it("garde la suite indentée d'une puce dans la puce", () => {
    expect(prose('- a\n  suite de a\n- b')).toBe('- a\n  suite de a\n- b');
  });

  it('réduit les lignes vides en trop', () => {
    expect(prose('\r\nUn.\r\n\r\n\r\nDeux.\n\n')).toBe('Un.\n\nDeux.');
  });

  it('ne touche pas aux blocs de code', () => {
    expect(prose('Voir :\n```ts\n- pas une liste\n\n\nx\n```')).toBe(
      'Voir :\n\n```ts\n- pas une liste\n\n\nx\n```'
    );
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
