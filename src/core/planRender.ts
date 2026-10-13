/**
 * Du plan structuré au markdown : affichage des versions, diff, et fiche de
 * `ready/` générée depuis le gabarit de plan de story.
 */

import matter from 'gray-matter';
import { extractAcceptanceCriteria } from './acceptance.js';
import type { Answers, PlanContext, PlanSection, StoryPlan, Understanding } from './plan.js';
import { sectionLabel } from './plan.js';

/* ------------------------------------------------------------------ */
/* Ce que la fiche apporte au plan                                     */
/* ------------------------------------------------------------------ */

/**
 * Les critères et les dépendances d'une fiche de `new/`.
 *
 * Les critères sont les éléments de liste de la section dédiée, ou à défaut
 * ses lignes non vides. La mention « à extraire » d'une fiche sans critère
 * donne une liste vide.
 */
export function readPlanContext(rawCard: string): PlanContext {
  const parsed = matter(rawCard);
  const data = parsed.data as { dependencies?: unknown };
  const declaredDependencies = Array.isArray(data.dependencies)
    ? data.dependencies.map(String)
    : [];
  return {
    criteria: parseCriteria(extractAcceptanceCriteria(parsed.content).acceptanceCriteria),
    declaredDependencies
  };
}

export function parseCriteria(section: string): string[] {
  const lines = section
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    // Les mentions en italique (« _Aucun critère…_ ») ne sont pas des critères.
    .filter((l) => !/^_.*_$/.test(l));
  const items = lines.filter((l) => /^([-*+]|\d+[.)])\s+/.test(l));
  const source = items.length > 0 ? items : lines;
  return source.map((l) =>
    l
      .replace(/^([-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .trim()
  );
}

/* ------------------------------------------------------------------ */
/* Rendu des sections                                                  */
/* ------------------------------------------------------------------ */

const MODEL_LABELS = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' } as const;
const COMPLEXITY_LABELS = { low: 'faible', medium: 'moyenne', high: 'élevée' } as const;

/** Le corps markdown d'une section, sans son titre. */
export function renderSection(plan: StoryPlan, section: PlanSection): string {
  switch (section) {
    case 'understanding': {
      const u = plan.understanding;
      return [
        u.restatement.trim(),
        list('Hypothèses', u.assumptions),
        list('Décisions', u.decisions)
      ]
        .filter(Boolean)
        .join('\n\n');
    }
    case 'coverage':
      return plan.coverage.length === 0
        ? '_Aucun critère._'
        : plan.coverage
            .map(
              (c) =>
                `- **${c.criterion_id}** ${c.criterion} → ${
                  c.step_ids.length ? c.step_ids.map((s) => `étape ${s}`).join(', ') : '_aucune étape_'
                }`
            )
            .join('\n');
    case 'steps':
      return plan.steps
        .map((s) => {
          const files = s.files.length
            ? `\n   Fichiers : ${s.files.map((f) => `\`${f}\``).join(', ')}`
            : '';
          return `${s.id}. **${s.title}**\n   ${s.approach.trim().replace(/\n/g, '\n   ')}${files}`;
        })
        .join('\n');
    case 'tests':
      return [list('Unitaires', plan.tests.unit), list('E2E', plan.tests.e2e)]
        .filter(Boolean)
        .join('\n\n') || '_Aucun test._';
    case 'dependencies': {
      const deps = plan.dependencies.length
        ? plan.dependencies
            .map(
              (d) =>
                `- ${d.source_id} : ${d.verdict === 'confirmed' ? 'confirmée' : 'infirmée'} — ${d.reason}`
            )
            .join('\n')
        : '_Aucune dépendance déclarée._';
      return [`**Dépendances**\n\n${deps}`, list('Risques', plan.risks)].filter(Boolean).join('\n\n');
    }
    case 'execution':
      return [
        `- Modèle recommandé : ${MODEL_LABELS[plan.execution.model]}`,
        `- Complexité : ${COMPLEXITY_LABELS[plan.execution.complexity]}`,
        plan.execution.rationale.trim() ? `\n${plan.execution.rationale.trim()}` : ''
      ]
        .filter(Boolean)
        .join('\n');
  }
}

const ALL_SECTIONS: PlanSection[] = [
  'understanding',
  'coverage',
  'steps',
  'tests',
  'dependencies',
  'execution'
];

/** Le plan complet en markdown, une section `##` par partie. Sert aux diffs entre versions. */
export function renderPlanMarkdown(plan: StoryPlan, title: string, version: number): string {
  const parts = [`# Plan — ${title} (v${version})`, ''];
  for (const section of ALL_SECTIONS) {
    parts.push(`## ${sectionLabel(section)}`, '', renderSection(plan, section), '');
  }
  return parts.join('\n');
}

/** La compréhension et les réponses, pour l'historique. */
export function renderUnderstanding(understanding: Understanding, answers: Answers): string {
  const parts = [understanding.restatement.trim()];
  if (understanding.assumptions.length) {
    parts.push(list('Hypothèses', understanding.assumptions));
  }
  for (const q of understanding.questions) {
    const a = answers[q.id];
    const answer = [a?.choice, a?.text].filter((x) => x?.trim()).join(' — ') || '_sans réponse_';
    parts.push(`**${q.id}${q.blocking ? ' (bloquante)' : ''}** ${q.question}\n→ ${answer}`);
  }
  return parts.join('\n\n');
}

function list(label: string, items: string[]): string {
  return items.length ? `**${label}**\n\n${items.map((i) => `- ${i}`).join('\n')}` : '';
}

/* ------------------------------------------------------------------ */
/* Fiche de ready/                                                     */
/* ------------------------------------------------------------------ */

/**
 * Gabarit par défaut, utilisé quand le dépôt n'en fournit pas.
 *
 * Les marqueurs `{{…}}` sont ceux qu'accepte un gabarit personnalisé.
 */
export const DEFAULT_PLAN_TEMPLATE = `# {{title}}

{{story}}

# Plan

## Compréhension

{{comprehension}}

## Couverture des critères

{{couverture}}

## Étapes

{{etapes}}

## Tests

{{tests}}

## Dépendances et risques

{{dependances}}

## Exécution

{{execution}}
`;

export interface ReadyCardInput {
  /** La fiche de `new/`, frontmatter compris. */
  rawCard: string;
  plan: StoryPlan;
  version: number;
  /** Chemin du plan JSON, relatif au dossier du flux. */
  planPath: string;
  /** Contenu du gabarit, ou `undefined` pour le gabarit par défaut. */
  template?: string;
  plannedAt: Date;
}

/**
 * La fiche placée dans `ready/` : le frontmatter de la fiche d'origine, complété
 * de ce que l'orchestrateur réutilisera, puis le gabarit rempli.
 */
export function renderReadyCard(input: ReadyCardInput): string {
  const parsed = matter(input.rawCard);
  const data = parsed.data as Record<string, unknown>;
  const { plan } = input;

  const story = stripTrailingSourceLink(parsed.content.trim())
    // Le titre vient du gabarit : on ne le répète pas.
    .replace(/^#\s+.+\n+/, '')
    .trim();

  const values: Record<string, string> = {
    title: String(data.title ?? ''),
    source_id: String(data.source_id ?? ''),
    web_url: String(data.web_url ?? ''),
    story,
    comprehension: renderSection(plan, 'understanding'),
    couverture: renderSection(plan, 'coverage'),
    etapes: renderSection(plan, 'steps'),
    tests: renderSection(plan, 'tests'),
    dependances: renderSection(plan, 'dependencies'),
    execution: renderSection(plan, 'execution'),
    modele: plan.execution.model,
    complexite: plan.execution.complexity
  };
  values.plan = ALL_SECTIONS.map((s) => `## ${sectionLabel(s)}\n\n${renderSection(plan, s)}`).join(
    '\n\n'
  );

  const body = fillTemplate(input.template ?? DEFAULT_PLAN_TEMPLATE, values);

  const frontmatter: Record<string, unknown> = {
    ...data,
    planned_at: input.plannedAt.toISOString(),
    plan: input.planPath,
    plan_version: input.version,
    recommended_model: plan.execution.model,
    complexity: plan.execution.complexity,
    dependencies_confirmed: plan.dependencies
      .filter((d) => d.verdict === 'confirmed')
      .map((d) => d.source_id),
    dependencies_refuted: plan.dependencies
      .filter((d) => d.verdict === 'refuted')
      .map((d) => d.source_id),
    files: [...new Set(plan.steps.flatMap((s) => s.files))]
  };
  // Une story replanifiée après un « à revoir » repart propre.
  delete frontmatter.needs_review;
  delete frontmatter.source_rev_seen;

  const footer = data.web_url ? `\n---\n\n[Ouvrir dans la source](${String(data.web_url)})\n` : '';
  return matter.stringify(`\n${body.trim()}\n${footer}`, frontmatter);
}

/** Remplace les marqueurs `{{nom}}` ; un marqueur inconnu reste tel quel pour être repéré. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, name: string) => {
    const value = values[name.toLowerCase()];
    return value === undefined ? whole : value;
  });
}

function stripTrailingSourceLink(content: string): string {
  return content.replace(/\n-{3,}\s*\n+\[Ouvrir dans la source\]\([^)]*\)\s*$/, '').trim();
}
