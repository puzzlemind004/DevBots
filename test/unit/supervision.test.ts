import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import matter from 'gray-matter';
import {
  applicableSteps,
  DEFAULT_SUPERVISION_FILE,
  globToRegExp,
  parseIssues,
  parseReview,
  parseSupervisionConfig,
  readSupervisionConfig,
  renderCorrections,
  renderFollowUpCard,
  SupervisionConfigError,
  triage,
  type Issue,
  type StepResult
} from '../../src/core/supervision.js';

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    title: 'Problème',
    description: 'Détail.',
    severity: 'minor',
    file: 'src/a.ts',
    line: 12,
    classification: 'none',
    miniPlan: '',
    ...overrides
  };
}

function result(issues: Issue[], blocking = true, step = 'pre-pr-check'): StepResult {
  return { step, blocking, summary: '', issues, permissionDenials: [] };
}

describe('configuration de la supervision', () => {
  let work: string;

  beforeEach(async () => {
    work = await fs.mkdtemp(path.join(os.tmpdir(), 'devbots-sup-'));
  });

  afterEach(async () => {
    await fs.rm(work, { recursive: true, force: true });
  });

  it('se réduit à pre-pr-check sans fichier', async () => {
    const config = await readSupervisionConfig(work);
    expect(config.origin).toBe('default');
    expect(config.steps.map((s) => s.skill)).toEqual(['pre-pr-check']);
  });

  it('lit le fichier déposé par « personnaliser la supervision », sans les étapes désactivées', async () => {
    await fs.writeFile(path.join(work, 'supervision.json'), DEFAULT_SUPERVISION_FILE, 'utf8');
    const config = await readSupervisionConfig(work);
    expect(config.maxLoops).toBe(3);
    expect(config.steps).toEqual([
      { name: 'pre-pr-check', skill: 'pre-pr-check', agent: undefined, when: [], blocking: true, tools: [], model: undefined }
    ]);
  });

  it('exige soit un skill, soit un agent', () => {
    expect(() => parseSupervisionConfig({ steps: [{ name: 'x' }] })).toThrow(SupervisionConfigError);
    expect(() => parseSupervisionConfig({ steps: [{ skill: 'a', agent: 'b' }] })).toThrow(/soit/);
  });

  it('refuse un nom de skill qui ressemble à une commande', () => {
    expect(() => parseSupervisionConfig({ steps: [{ skill: 'a; rm -rf' }] })).toThrow(/invalide/);
  });

  it('garde un agent non bloquant avec ses outils', () => {
    const config = parseSupervisionConfig({
      steps: [{ agent: 'security-reviewer', blocking: false, tools: ['Bash(npm audit:*)'], when: ['src/**'] }]
    });
    expect(config.steps[0]).toMatchObject({
      name: 'security-reviewer',
      agent: 'security-reviewer',
      blocking: false,
      tools: ['Bash(npm audit:*)']
    });
  });
});

describe('when : étapes restreintes à des fichiers', () => {
  it('traduit les motifs', () => {
    expect(globToRegExp('src/**/*.ts').test('src/app/a/b.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/app/a.ts')).toBe(false);
    expect(globToRegExp('src/app/auth/**').test('src/app/auth/guard.ts')).toBe(true);
    expect(globToRegExp('*.json').test('package.json')).toBe(true);
  });

  it('ne lance une étape que si la story touche ses fichiers', () => {
    const steps = parseSupervisionConfig({
      steps: [{ skill: 'pre-pr-check' }, { agent: 'auth-review', when: ['src/app/auth/**'] }]
    }).steps;
    expect(applicableSteps(steps, ['src/app/home.ts']).map((s) => s.name)).toEqual(['pre-pr-check']);
    expect(applicableSteps(steps, ['src/app/auth/guard.ts']).map((s) => s.name)).toEqual([
      'pre-pr-check',
      'auth-review'
    ]);
  });
});

describe('lecture des réponses', () => {
  it("n'accepte pas une approbation assortie de corrections", () => {
    const review = parseReview({
      verdict: 'approved',
      summary: 'ok',
      corrections: [{ description: 'Renommer', location: 'a.ts' }]
    });
    expect(review.verdict).toBe('changes_requested');
  });

  it('remplace les valeurs inconnues par des valeurs sûres', () => {
    const { issues } = parseIssues({
      summary: '',
      issues: [{ title: 'x', severity: 'énorme', classification: 'peut-être', line: -1 }]
    });
    expect(issues[0]).toMatchObject({ severity: 'minor', classification: 'none', line: 0, file: '' });
  });
});

describe('triage', () => {
  it('range les problèmes selon leur classement', () => {
    const t = triage([
      result([
        issue({ title: 'A', classification: 'blocking' }),
        issue({ title: 'B', classification: 'followup_complex' }),
        issue({ title: 'C', classification: 'followup_simple', miniPlan: '1. Corriger.' }),
        issue({ title: 'D', classification: 'none' })
      ])
    ]);
    expect([t.blocking, t.complex, t.simple, t.info].map((l) => l.map((i) => i.title))).toEqual([
      ['A'],
      ['B'],
      ['C'],
      ['D']
    ]);
  });

  it("un bloquant d'une étape non bloquante ne retient pas la story", () => {
    const t = triage([result([issue({ classification: 'blocking' })], false)]);
    expect(t.blocking).toEqual([]);
    expect(t.complex).toHaveLength(1);
  });

  it('une fiche simple sans mini-plan part à la planification', () => {
    const t = triage([result([issue({ classification: 'followup_simple', miniPlan: ' ' })])]);
    expect(t.simple).toEqual([]);
    expect(t.complex).toHaveLength(1);
  });

  it('renvoie à l’agent les corrections de la revue et les bloquants', () => {
    const text = renderCorrections(
      { verdict: 'changes_requested', summary: '', corrections: [{ description: 'CR incomplet', location: 'Tests' }] },
      [issue({ title: 'Fuite', description: 'Abonnement jamais fermé.' })]
    );
    expect(text).toBe('- CR incomplet (Tests)\n- Fuite (src/a.ts:12) : Abonnement jamais fermé.');
  });
});

describe('fiches nées du tri', () => {
  const base = {
    id: 'LOCAL-4',
    step: 'pre-pr-check',
    originStory: '42',
    parent: '30',
    createdAt: new Date('2026-10-13T10:00:00Z')
  };

  it('une fiche simple arrive dans ready/ avec son mini-plan', () => {
    const card = renderFollowUpCard({
      ...base,
      folder: 'ready',
      issue: issue({ title: 'Nommer la constante', classification: 'followup_simple', miniPlan: '1. Extraire.' })
    });
    const parsed = matter(card);
    expect(parsed.data).toMatchObject({
      source: 'local',
      source_id: 'LOCAL-4',
      parent: '30',
      origin: 'pre-pr-check',
      origin_story: '42',
      recommended_model: 'haiku',
      files: ['src/a.ts']
    });
    expect(parsed.content).toContain('## Mini-plan\n\n1. Extraire.');
    expect(parsed.content).toContain('`src/a.ts:12`');
  });

  it('une fiche complexe arrive dans new/, sans plan', () => {
    const parsed = matter(renderFollowUpCard({ ...base, folder: 'new', issue: issue({ file: '' }) }));
    expect(parsed.data.recommended_model).toBeUndefined();
    expect(parsed.content).not.toContain('Mini-plan');
    expect(parsed.content).toContain("## Critères d'acceptation");
  });
});
