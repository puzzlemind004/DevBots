import { describe, expect, it } from 'vitest';
import {
  applySectionRevision,
  blockingAnswered,
  checkPlan,
  parsePlan,
  parseUnderstanding,
  PlanShapeError
} from '../../src/core/plan.js';
import { samplePlan, sampleUnderstanding } from './fixtures.js';

const ctx = { criteria: ['Un email invalide est refusé', 'Un message explique pourquoi'], declaredDependencies: ['40'] };

describe('checkPlan', () => {
  it('ne signale rien sur un plan complet', () => {
    expect(checkPlan(samplePlan(), ctx)).toEqual([]);
  });

  it('signale un critère orphelin', () => {
    const plan = samplePlan({ coverage: [{ criterion_id: 'C1', criterion: 'x', step_ids: [1] }] });
    const checks = checkPlan(plan, ctx);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ section: 'coverage', severity: 'error' });
    expect(checks[0]?.message).toContain('C2');
  });

  it('tient pour orphelin un critère relié à une étape inexistante', () => {
    const plan = samplePlan({
      coverage: [
        { criterion_id: 'C1', criterion: 'x', step_ids: [1] },
        { criterion_id: 'C2', criterion: 'y', step_ids: [9] }
      ]
    });
    const messages = checkPlan(plan, ctx).map((c) => c.message);
    expect(messages.some((m) => m.includes('orphelin C2'))).toBe(true);
    expect(messages.some((m) => m.includes('inexistantes : 9'))).toBe(true);
  });

  it('exige un verdict par dépendance déclarée', () => {
    const checks = checkPlan(samplePlan({ dependencies: [] }), ctx);
    expect(checks).toEqual([
      expect.objectContaining({ section: 'dependencies', severity: 'error' })
    ]);
  });

  it('exige au moins un test et une étape', () => {
    const checks = checkPlan(samplePlan({ steps: [], coverage: [], tests: { unit: [], e2e: [] } }), {
      criteria: [],
      declaredDependencies: []
    });
    const sections = checks.filter((c) => c.severity === 'error').map((c) => c.section);
    expect(sections).toEqual(expect.arrayContaining(['steps', 'tests', 'coverage']));
  });

  it('avertit seulement quand les critères sont extraits par Claude', () => {
    const plan = samplePlan({
      coverage: [{ criterion_id: 'X1', criterion: 'extrait', step_ids: [1] }]
    });
    const checks = checkPlan(plan, { criteria: [], declaredDependencies: ['40'] });
    expect(checks).toEqual([expect.objectContaining({ section: 'coverage', severity: 'warning' })]);
  });

  it('avertit pour une étape sans fichier', () => {
    const plan = samplePlan();
    plan.steps[0]!.files = [];
    expect(checkPlan(plan, ctx)).toEqual([expect.objectContaining({ section: 'steps', severity: 'warning' })]);
  });
});

describe('applySectionRevision', () => {
  it('ne garde de la révision que la section visée', () => {
    const previous = samplePlan();
    const revised = samplePlan({
      tests: { unit: ['nouveau.spec.ts'], e2e: ['inscription.e2e.ts'] },
      risks: ['changé en douce']
    });
    const next = applySectionRevision(previous, revised, 'tests');
    expect(next.tests).toEqual(revised.tests);
    expect(next.risks).toEqual(previous.risks);
  });

  it('laisse une reprise des étapes renuméroter la couverture', () => {
    const previous = samplePlan();
    const revised = samplePlan({
      steps: [{ id: 1, title: 'Tout', approach: 'Une seule étape.', files: ['a.ts'] }],
      coverage: [
        { criterion_id: 'C1', criterion: 'x', step_ids: [1] },
        { criterion_id: 'C2', criterion: 'y', step_ids: [1] }
      ],
      execution: { model: 'opus', complexity: 'high', rationale: 'changé en douce' }
    });
    const next = applySectionRevision(previous, revised, 'steps');
    expect(next.steps).toHaveLength(1);
    expect(next.coverage[1]?.step_ids).toEqual([1]);
    expect(next.execution).toEqual(previous.execution);
  });
});

describe('parsePlan / parseUnderstanding', () => {
  it('accepte un plan bien formé', () => {
    expect(parsePlan(JSON.parse(JSON.stringify(samplePlan())))).toEqual(samplePlan());
  });

  it('refuse un modèle inconnu', () => {
    const raw = { ...samplePlan(), execution: { model: 'gpt', complexity: 'low', rationale: '' } };
    expect(() => parsePlan(raw)).toThrow(PlanShapeError);
  });

  it('refuse une section manquante', () => {
    const raw: Record<string, unknown> = { ...samplePlan() };
    delete raw.steps;
    expect(() => parsePlan(raw)).toThrow(/steps/);
  });

  it('numérote une question sans identifiant', () => {
    const u = parseUnderstanding({
      restatement: 'r',
      assumptions: [],
      questions: [{ id: '', question: 'q', blocking: true, choices: [] }]
    });
    expect(u.questions[0]?.id).toBe('Q1');
  });
});

describe('blockingAnswered', () => {
  it('ne demande que les questions bloquantes', () => {
    const u = sampleUnderstanding();
    expect(blockingAnswered(u, {})).toBe(false);
    expect(blockingAnswered(u, { Q1: { choice: 'Sous le champ' } })).toBe(true);
    expect(blockingAnswered(u, { Q1: { text: '  ' } })).toBe(false);
    expect(blockingAnswered(u, { Q1: { text: 'en rouge' } })).toBe(true);
  });
});
