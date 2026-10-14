/**
 * Le plan structuré d'une story : schémas imposés à Claude, types et contrôles
 * de forme.
 *
 * Claude remplit un schéma JSON plutôt que du texte libre (`--json-schema`). Le
 * CLI garantit la forme générale ; les contrôles d'ici vérifient ce qu'un schéma
 * ne sait pas dire : un critère d'acceptation sans étape, une étape citée qui
 * n'existe pas, une dépendance déclarée laissée sans verdict.
 */

/** Une question de la phase de compréhension. */
export interface PlanningQuestion {
  id: string;
  question: string;
  /** Une question bloquante doit avoir une réponse avant la rédaction du plan. */
  blocking: boolean;
  /** Réponses proposées. Un champ libre est toujours offert en plus. */
  choices: string[];
}

/** Ce que Claude renvoie en phase de compréhension. */
export interface Understanding {
  restatement: string;
  assumptions: string[];
  questions: PlanningQuestion[];
}

/** La réponse à une question : un choix, un texte libre, ou les deux. */
export interface Answer {
  choice?: string;
  text?: string;
}

export type Answers = Record<string, Answer>;

export type ModelChoice = 'opus' | 'sonnet' | 'haiku';
export type Complexity = 'low' | 'medium' | 'high';

export interface PlanStep {
  id: number;
  title: string;
  approach: string;
  files: string[];
}

export interface CoverageEntry {
  /** `C1`, `C2`… pour un critère de la fiche ; `X1`… pour un critère extrait par Claude. */
  criterion_id: string;
  criterion: string;
  step_ids: number[];
}

export interface DependencyVerdict {
  source_id: string;
  verdict: 'confirmed' | 'refuted';
  reason: string;
}

/** Le plan d'une story, tel que Claude le remplit. */
export interface StoryPlan {
  understanding: {
    restatement: string;
    assumptions: string[];
    /** Les décisions tirées des réponses aux questions. */
    decisions: string[];
  };
  coverage: CoverageEntry[];
  steps: PlanStep[];
  tests: { unit: string[]; e2e: string[] };
  dependencies: DependencyVerdict[];
  risks: string[];
  execution: { model: ModelChoice; complexity: Complexity; rationale: string };
}

/** Les sections du plan, dans l'ordre d'affichage. Chacune se commente à part. */
export type PlanSection =
  | 'understanding'
  | 'coverage'
  | 'steps'
  | 'tests'
  | 'dependencies'
  | 'execution';

export const PLAN_SECTIONS: ReadonlyArray<{ id: PlanSection; label: string }> = [
  { id: 'understanding', label: 'Compréhension' },
  { id: 'coverage', label: 'Couverture' },
  { id: 'steps', label: 'Étapes' },
  { id: 'tests', label: 'Tests' },
  { id: 'dependencies', label: 'Dépendances et risques' },
  { id: 'execution', label: 'Exécution' }
];

/**
 * Les clés du plan que chaque section a le droit de modifier.
 *
 * Renuméroter les étapes casse les renvois de la couverture : une reprise des
 * étapes peut donc retoucher la couverture, rien d'autre.
 */
export const SECTION_KEYS: Record<PlanSection, ReadonlyArray<keyof StoryPlan>> = {
  understanding: ['understanding'],
  coverage: ['coverage'],
  steps: ['steps', 'coverage'],
  tests: ['tests'],
  dependencies: ['dependencies', 'risks'],
  execution: ['execution']
};

export function sectionLabel(section: PlanSection): string {
  return PLAN_SECTIONS.find((s) => s.id === section)?.label ?? section;
}

/**
 * Garde d'un plan la version précédente, sauf les clés de la section visée.
 *
 * La consigne « ne modifie que cette section » est donnée à Claude, mais c'est
 * le code qui la garantit.
 */
export function applySectionRevision(
  previous: StoryPlan,
  revised: StoryPlan,
  section: PlanSection
): StoryPlan {
  const next = { ...previous };
  for (const key of SECTION_KEYS[section]) {
    (next as Record<string, unknown>)[key] = revised[key];
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Schémas passés à `claude --json-schema`                             */
/* ------------------------------------------------------------------ */

const stringList = { type: 'array', items: { type: 'string' } } as const;

export const UNDERSTANDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['restatement', 'assumptions', 'questions'],
  properties: {
    restatement: { type: 'string', description: 'La story reformulée en quelques phrases.' },
    assumptions: { ...stringList, description: 'Hypothèses retenues faute d\'information.' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'question', 'blocking', 'choices'],
        properties: {
          id: { type: 'string', description: 'Q1, Q2…' },
          question: { type: 'string' },
          blocking: {
            type: 'boolean',
            description: 'Vrai si le plan ne peut pas être rédigé sans la réponse.'
          },
          choices: { ...stringList, description: 'Deux à quatre réponses plausibles.' }
        }
      }
    }
  }
} as const;

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'understanding',
    'coverage',
    'steps',
    'tests',
    'dependencies',
    'risks',
    'execution'
  ],
  properties: {
    understanding: {
      type: 'object',
      additionalProperties: false,
      required: ['restatement', 'assumptions', 'decisions'],
      properties: {
        restatement: { type: 'string' },
        assumptions: stringList,
        decisions: { ...stringList, description: 'Décisions tirées des réponses aux questions.' }
      }
    },
    coverage: {
      type: 'array',
      description:
        'Chaque critère de la fiche (C1, C2…) relié aux étapes qui le satisfont. Critères extraits : X1, X2…',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion_id', 'criterion', 'step_ids'],
        properties: {
          criterion_id: { type: 'string' },
          criterion: { type: 'string' },
          step_ids: { type: 'array', items: { type: 'integer' } }
        }
      }
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'approach', 'files'],
        properties: {
          id: { type: 'integer', description: 'Numéro d\'ordre, à partir de 1.' },
          title: { type: 'string' },
          approach: { type: 'string' },
          files: { ...stringList, description: 'Chemins relatifs à la racine du dépôt.' }
        }
      }
    },
    tests: {
      type: 'object',
      additionalProperties: false,
      required: ['unit', 'e2e'],
      properties: { unit: stringList, e2e: stringList }
    },
    dependencies: {
      type: 'array',
      description:
        'Un verdict par dépendance déclarée dans la fiche, d\'après les fichiers et contrats communs.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source_id', 'verdict', 'reason'],
        properties: {
          source_id: { type: 'string' },
          verdict: { type: 'string', enum: ['confirmed', 'refuted'] },
          reason: { type: 'string' }
        }
      }
    },
    risks: { ...stringList, description: 'Zones sensibles du code.' },
    execution: {
      type: 'object',
      additionalProperties: false,
      required: ['model', 'complexity', 'rationale'],
      properties: {
        model: { type: 'string', enum: ['opus', 'sonnet', 'haiku'] },
        complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
        rationale: { type: 'string' }
      }
    }
  }
} as const;

/* ------------------------------------------------------------------ */
/* Lecture défensive de la sortie de Claude                            */
/* ------------------------------------------------------------------ */

export class PlanShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanShapeError';
  }
}

/** Vérifie la forme minimale d'une compréhension et la normalise. */
export function parseUnderstanding(value: unknown): Understanding {
  const obj = asObject(value, 'compréhension');
  return {
    restatement: asString(obj.restatement, 'restatement'),
    assumptions: asStrings(obj.assumptions, 'assumptions'),
    questions: asArray(obj.questions, 'questions').map((q, i) => {
      const item = asObject(q, `questions[${i}]`);
      return {
        id: asString(item.id, `questions[${i}].id`) || `Q${i + 1}`,
        question: asString(item.question, `questions[${i}].question`),
        blocking: item.blocking === true,
        choices: asStrings(item.choices ?? [], `questions[${i}].choices`)
      };
    })
  };
}

/** Vérifie la forme minimale d'un plan et le normalise. */
export function parsePlan(value: unknown): StoryPlan {
  const obj = asObject(value, 'plan');
  const u = asObject(obj.understanding, 'understanding');
  const tests = asObject(obj.tests, 'tests');
  const exec = asObject(obj.execution, 'execution');
  return {
    understanding: {
      restatement: asString(u.restatement, 'understanding.restatement'),
      assumptions: asStrings(u.assumptions, 'understanding.assumptions'),
      decisions: asStrings(u.decisions ?? [], 'understanding.decisions')
    },
    coverage: asArray(obj.coverage, 'coverage').map((c, i) => {
      const item = asObject(c, `coverage[${i}]`);
      return {
        criterion_id: asString(item.criterion_id, `coverage[${i}].criterion_id`),
        criterion: asString(item.criterion, `coverage[${i}].criterion`),
        step_ids: asArray(item.step_ids, `coverage[${i}].step_ids`).map(Number)
      };
    }),
    steps: asArray(obj.steps, 'steps').map((s, i) => {
      const item = asObject(s, `steps[${i}]`);
      return {
        id: Number(item.id),
        title: asString(item.title, `steps[${i}].title`),
        approach: asString(item.approach, `steps[${i}].approach`),
        files: asStrings(item.files, `steps[${i}].files`)
      };
    }),
    tests: {
      unit: asStrings(tests.unit, 'tests.unit'),
      e2e: asStrings(tests.e2e, 'tests.e2e')
    },
    dependencies: asArray(obj.dependencies, 'dependencies').map((d, i) => {
      const item = asObject(d, `dependencies[${i}]`);
      const verdict = item.verdict === 'refuted' ? 'refuted' : 'confirmed';
      return {
        source_id: String(item.source_id ?? ''),
        verdict,
        reason: asString(item.reason, `dependencies[${i}].reason`)
      };
    }),
    risks: asStrings(obj.risks, 'risks'),
    execution: {
      model: oneOf(exec.model, ['opus', 'sonnet', 'haiku'], 'execution.model'),
      complexity: oneOf(exec.complexity, ['low', 'medium', 'high'], 'execution.complexity'),
      rationale: asString(exec.rationale, 'execution.rationale')
    }
  };
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlanShapeError(`${where} : objet attendu.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new PlanShapeError(`${where} : liste attendue.`);
  }
  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string') {
    throw new PlanShapeError(`${where} : texte attendu.`);
  }
  return value;
}

function asStrings(value: unknown, where: string): string[] {
  return asArray(value, where).map((v, i) => asString(v, `${where}[${i}]`));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new PlanShapeError(`${where} : une valeur parmi ${allowed.join(', ')} attendue.`);
  }
  return value as T;
}

/* ------------------------------------------------------------------ */
/* Contrôles de forme                                                  */
/* ------------------------------------------------------------------ */

export interface FormCheck {
  section: PlanSection;
  /** Une erreur bloque le passage en ready ; un avertissement s'affiche seulement. */
  severity: 'error' | 'warning';
  message: string;
}

/** Ce que la fiche apporte aux contrôles. */
export interface PlanContext {
  /** Critères d'acceptation de la fiche, dans l'ordre : C1, C2… */
  criteria: string[];
  /** Identifiants des stories dont la fiche se déclare bloquée. */
  declaredDependencies: string[];
}

/**
 * Ce qu'une étape ne devrait pas demander à l'agent : le workflow Git et le ticket sont à DevBots.
 *
 * Les bornes de mot sont des lettres Unicode : `\b` voit une lettre accentuée
 * comme une frontière, et « préciser » passait pour « PR ». Le sigle PR, lui,
 * n'est reconnu qu'en majuscules.
 */
const WORKFLOW_STEP =
  /(?<![\p{L}\p{N}_])(pull request|gh |git (push|commit|merge)|\/review-pr|fusionn\p{L}*|cr[ée]+r? (le |un )?worktree|supprim\p{L}* (le )?worktree|ferm\p{L}* (l'issue|le ticket|#\d+))/iu;
const PR_ACRONYM = /(?<![\p{L}\p{N}_])PRs?(?![\p{L}\p{N}_])/u;

export function checkPlan(plan: StoryPlan, ctx: PlanContext): FormCheck[] {
  const checks: FormCheck[] = [];
  const stepIds = new Set(plan.steps.map((s) => s.id));

  if (!plan.understanding.restatement.trim()) {
    checks.push({ section: 'understanding', severity: 'error', message: 'Reformulation vide.' });
  }

  if (plan.steps.length === 0) {
    checks.push({ section: 'steps', severity: 'error', message: 'Aucune étape.' });
  }
  const seen = new Set<number>();
  for (const step of plan.steps) {
    if (!Number.isInteger(step.id) || seen.has(step.id)) {
      checks.push({
        section: 'steps',
        severity: 'error',
        message: `Numéro d'étape invalide ou en double : ${step.id}.`
      });
    }
    seen.add(step.id);
    if (step.files.length === 0) {
      checks.push({
        section: 'steps',
        severity: 'warning',
        message: `L'étape ${step.id} ne cite aucun fichier : le graphe de dépendances ne pourra pas s'en servir.`
      });
    }
    const stepText = `${step.title}\n${step.approach}`;
    const workflow = WORKFLOW_STEP.exec(stepText) ?? PR_ACRONYM.exec(stepText);
    if (workflow) {
      checks.push({
        section: 'steps',
        severity: 'warning',
        message: `L'étape ${step.id} semble relever de DevBots (« ${workflow[0].trim()} ») : worktree, commit, PR, merge et fermeture du ticket ne sont pas à l'agent. Commente la section pour la retirer.`
      });
    }
  }

  // Chaque critère de la fiche doit être couvert par au moins une étape réelle.
  ctx.criteria.forEach((criterion, index) => {
    const id = `C${index + 1}`;
    const entry = plan.coverage.find((c) => c.criterion_id === id);
    const covered = entry?.step_ids.some((s) => stepIds.has(s)) ?? false;
    if (!covered) {
      checks.push({
        section: 'coverage',
        severity: 'error',
        message: `Critère orphelin ${id} : « ${truncate(criterion, 80)} ».`
      });
    }
  });
  for (const entry of plan.coverage) {
    const missing = entry.step_ids.filter((s) => !stepIds.has(s));
    if (missing.length > 0) {
      checks.push({
        section: 'coverage',
        severity: 'error',
        message: `${entry.criterion_id} renvoie à des étapes inexistantes : ${missing.join(', ')}.`
      });
    }
    if (/^C\d+$/.test(entry.criterion_id) && Number(entry.criterion_id.slice(1)) > ctx.criteria.length) {
      checks.push({
        section: 'coverage',
        severity: 'warning',
        message: `${entry.criterion_id} ne correspond à aucun critère de la fiche.`
      });
    }
  }
  if (ctx.criteria.length === 0) {
    if (plan.coverage.length === 0) {
      checks.push({
        section: 'coverage',
        severity: 'error',
        message: "La fiche n'a pas de critère et le plan n'en extrait aucun."
      });
    } else {
      checks.push({
        section: 'coverage',
        severity: 'warning',
        message: "Critères extraits par Claude, absents de la source : à relire avec attention."
      });
    }
  }

  if (plan.tests.unit.length === 0 && plan.tests.e2e.length === 0) {
    checks.push({ section: 'tests', severity: 'error', message: 'Aucun test prévu.' });
  }

  for (const dep of ctx.declaredDependencies) {
    if (!plan.dependencies.some((d) => d.source_id === dep)) {
      checks.push({
        section: 'dependencies',
        severity: 'error',
        message: `La dépendance déclarée ${dep} n'a pas de verdict.`
      });
    }
  }

  return checks;
}

/** Vrai quand toutes les questions bloquantes ont une réponse. */
export function blockingAnswered(understanding: Understanding, answers: Answers): boolean {
  return understanding.questions
    .filter((q) => q.blocking)
    .every((q) => isAnswered(answers[q.id]));
}

export function isAnswered(answer: Answer | undefined): boolean {
  return Boolean(answer?.choice?.trim() || answer?.text?.trim());
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
