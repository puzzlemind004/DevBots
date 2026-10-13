/**
 * La partie jugement de la supervision : revue du CR, étapes du dépôt et tri
 * des problèmes.
 *
 * Les étapes sont déclarées par le dépôt dans `.work/supervision.json` ;
 * Claude ne choisit pas lesquelles lancer. Toutes répondent au même schéma
 * (une liste de problèmes avec gravité, localisation et classement proposé),
 * si bien que le tri et la boucle de correction marchent quel que soit le
 * skill ou l'agent.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { CheckStatus, DevReport } from './flowState.js';
import { renderFrontmatter } from './storyCard.js';
import type { StoryFrontmatter } from './model.js';

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface SupervisionStep {
  /** Nom affiché dans le journal et le rapport. */
  name: string;
  /** Skill lancé par `/<skill>` en tête du prompt. */
  skill?: string;
  /** Agent de `.claude/agents/` qui mène la session, à la place d'un skill. */
  agent?: string;
  /** Motifs de fichiers : l'étape ne tourne que si la story en touche un. Vide : toujours. */
  when: string[];
  /** Un problème bloquant d'une étape non bloquante n'alimente que le tri. */
  blocking: boolean;
  /** Règles de permission en plus de la lecture seule (`Bash(npm run lint:*)`). */
  tools: string[];
  model?: string;
}

export interface SupervisionConfig {
  steps: SupervisionStep[];
  /** Plafond de boucles de correction, commun à toutes les étapes. Absent : le paramètre. */
  maxLoops?: number;
  /** D'où vient la configuration. */
  origin: 'file' | 'default';
}

export const SUPERVISION_FILE = 'supervision.json';

export const DEFAULT_STEP: SupervisionStep = {
  name: 'pre-pr-check',
  skill: 'pre-pr-check',
  when: [],
  blocking: true,
  tools: []
};

/** Le fichier déposé par « personnaliser la supervision ». */
export const DEFAULT_SUPERVISION_FILE = `${JSON.stringify(
  {
    maxLoops: 3,
    steps: [
      { name: 'pre-pr-check', skill: 'pre-pr-check', blocking: true },
      {
        name: 'exemple-agent',
        agent: 'security-reviewer',
        when: ['src/app/auth/**'],
        blocking: false,
        tools: [],
        model: 'opus',
        disabled: true
      }
    ]
  },
  null,
  2
)}\n`;

export class SupervisionConfigError extends Error {}

/** Lit `.work/supervision.json`. Sans fichier : pre-pr-check seul. */
export async function readSupervisionConfig(workRoot: string): Promise<SupervisionConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(workRoot, SUPERVISION_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { steps: [DEFAULT_STEP], origin: 'default' };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SupervisionConfigError(`${SUPERVISION_FILE} illisible : ${(err as Error).message}`);
  }
  return parseSupervisionConfig(parsed);
}

export function parseSupervisionConfig(value: unknown): SupervisionConfig {
  const obj = asObject(value, SUPERVISION_FILE);
  if (!Array.isArray(obj.steps)) {
    throw new SupervisionConfigError(`${SUPERVISION_FILE} : « steps » doit être une liste.`);
  }
  const steps = obj.steps
    .map((s, i) => asObject(s, `étape ${i + 1}`))
    .filter((s) => s.disabled !== true)
    .map((s, i): SupervisionStep => {
      const skill = optionalName(s.skill, `étape ${i + 1} : skill`);
      const agent = optionalName(s.agent, `étape ${i + 1} : agent`);
      if (!skill === !agent) {
        throw new SupervisionConfigError(
          `${SUPERVISION_FILE}, étape ${i + 1} : indique soit « skill », soit « agent ».`
        );
      }
      return {
        name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : (skill ?? agent)!,
        skill,
        agent,
        when: stringArray(s.when, `étape ${i + 1} : when`),
        blocking: s.blocking !== false,
        tools: stringArray(s.tools, `étape ${i + 1} : tools`),
        model: typeof s.model === 'string' && s.model.trim() ? s.model.trim() : undefined
      };
    });
  const maxLoops =
    typeof obj.maxLoops === 'number' && Number.isInteger(obj.maxLoops) && obj.maxLoops >= 0
      ? obj.maxLoops
      : undefined;
  return { steps, maxLoops, origin: 'file' };
}

/** Les étapes à lancer pour une story, d'après les fichiers qu'elle a modifiés. */
export function applicableSteps(steps: SupervisionStep[], changedFiles: string[]): SupervisionStep[] {
  return steps.filter(
    (step) =>
      step.when.length === 0 ||
      changedFiles.some((file) => step.when.some((pattern) => globToRegExp(pattern).test(file)))
  );
}

/**
 * Un motif de fichier en expression régulière : `**` traverse les dossiers,
 * `*` et `?` restent dans un dossier.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  const p = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` : zéro ou plusieurs dossiers ; `**` seul : n'importe quoi.
        if (p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Le skill ou l'agent d'une étape existe-t-il dans le dépôt ? Un absent n'est
 * qu'un avertissement : il peut venir d'un plugin ou du dossier utilisateur.
 */
export async function stepTargetExists(repoRoot: string, step: SupervisionStep): Promise<boolean> {
  const candidates = step.skill
    ? [
        path.join(repoRoot, '.claude', 'skills', step.skill, 'SKILL.md'),
        path.join(repoRoot, '.claude', 'commands', `${step.skill}.md`)
      ]
    : [path.join(repoRoot, '.claude', 'agents', `${step.agent}.md`)];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return true;
    } catch {
      // Suivant.
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Schémas passés à `claude --json-schema`                             */
/* ------------------------------------------------------------------ */

const checkStatus = { type: 'string', enum: ['passed', 'failed', 'not_run'] } as const;

/** La sortie structurée de l'agent de dev. Le panneau en tire build et tests, jamais du CR. */
export const DEV_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'build', 'tests', 'tests_detail', 'lint', 'blocked_reason'],
  properties: {
    status: {
      type: 'string',
      enum: ['done', 'blocked'],
      description: '« blocked » si tu ne peux pas terminer sans aide.'
    },
    summary: { type: 'string', description: 'Ce qui a été fait, en deux ou trois phrases.' },
    build: checkStatus,
    tests: checkStatus,
    tests_detail: { type: 'string', description: 'Tests lancés, passés, en échec.' },
    lint: checkStatus,
    blocked_reason: { type: 'string', description: 'Vide si status vaut « done ».' }
  }
} as const;

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'corrections'],
  properties: {
    verdict: { type: 'string', enum: ['approved', 'changes_requested'] },
    summary: { type: 'string' },
    corrections: {
      type: 'array',
      description: 'Corrections bloquantes à renvoyer à l’agent de dev. Vide si approuvé.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'location'],
        properties: {
          description: { type: 'string' },
          location: { type: 'string', description: 'Fichier et ligne, ou section du CR.' }
        }
      }
    }
  }
} as const;

export const ISSUES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'issues'],
  properties: {
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'description', 'severity', 'file', 'line', 'classification', 'mini_plan'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          severity: { type: 'string', enum: ['blocking', 'major', 'minor', 'info'] },
          file: { type: 'string', description: 'Chemin relatif au dépôt, vide si global.' },
          line: { type: 'integer', description: '0 si sans objet.' },
          classification: {
            type: 'string',
            enum: ['blocking', 'followup_complex', 'followup_simple', 'none'],
            description:
              'blocking : à corriger dans cette story. followup_complex : fiche séparée à planifier. followup_simple : fiche séparée prête, avec un mini-plan. none : information.'
          },
          mini_plan: {
            type: 'string',
            description: 'Pour followup_simple : les étapes de correction. Vide sinon.'
          }
        }
      }
    }
  }
} as const;

/* ------------------------------------------------------------------ */
/* Lecture défensive des réponses                                      */
/* ------------------------------------------------------------------ */

export interface CrReview {
  verdict: 'approved' | 'changes_requested';
  summary: string;
  corrections: Array<{ description: string; location: string }>;
}

export type IssueClass = 'blocking' | 'followup_complex' | 'followup_simple' | 'none';

export interface Issue {
  title: string;
  description: string;
  severity: 'blocking' | 'major' | 'minor' | 'info';
  file: string;
  line: number;
  classification: IssueClass;
  miniPlan: string;
}

export interface StepResult {
  step: string;
  blocking: boolean;
  summary: string;
  issues: Issue[];
  permissionDenials: string[];
}

export function parseDevReport(value: unknown, at = new Date()): Omit<DevReport, 'permissionDenials'> {
  const o = asObject(value, 'sortie de dev');
  return {
    status: o.status === 'blocked' ? 'blocked' : 'done',
    summary: str(o.summary),
    build: check(o.build),
    tests: check(o.tests),
    testsDetail: str(o.tests_detail),
    lint: check(o.lint),
    blockedReason: str(o.blocked_reason),
    at: at.toISOString()
  };
}

export function parseReview(value: unknown): CrReview {
  const o = asObject(value, 'revue du CR');
  const corrections = Array.isArray(o.corrections)
    ? o.corrections.map((c) => {
        const x = asObject(c, 'correction');
        return { description: str(x.description), location: str(x.location) };
      })
    : [];
  // Une approbation qui demande des corrections n'en est pas une.
  const verdict = o.verdict === 'approved' && corrections.length === 0 ? 'approved' : 'changes_requested';
  return { verdict, summary: str(o.summary), corrections };
}

export function parseIssues(value: unknown): { summary: string; issues: Issue[] } {
  const o = asObject(value, 'rapport');
  const issues = Array.isArray(o.issues)
    ? o.issues.map((i): Issue => {
        const x = asObject(i, 'problème');
        const severity = ['blocking', 'major', 'minor', 'info'].includes(String(x.severity))
          ? (x.severity as Issue['severity'])
          : 'minor';
        const classification = ['blocking', 'followup_complex', 'followup_simple', 'none'].includes(
          String(x.classification)
        )
          ? (x.classification as IssueClass)
          : 'none';
        return {
          title: str(x.title) || 'Problème sans titre',
          description: str(x.description),
          severity,
          file: str(x.file),
          line: typeof x.line === 'number' && x.line > 0 ? Math.floor(x.line) : 0,
          classification,
          miniPlan: str(x.mini_plan)
        };
      })
    : [];
  return { summary: str(o.summary), issues };
}

/* ------------------------------------------------------------------ */
/* Tri                                                                 */
/* ------------------------------------------------------------------ */

export interface Triage {
  /** À corriger dans la story : repart à l'agent de dev. */
  blocking: Issue[];
  /** Fiche dans `new/`, à planifier. */
  complex: Issue[];
  /** Fiche dans `ready/`, avec un mini-plan. */
  simple: Issue[];
  /** Pour information, dans le rapport seulement. */
  info: Issue[];
}

/**
 * Range les problèmes des étapes. Un problème bloquant d'une étape non
 * bloquante devient une fiche à planifier : il ne retient pas la story.
 * Une fiche simple sans mini-plan est traitée comme complexe.
 */
export function triage(results: StepResult[]): Triage {
  const out: Triage = { blocking: [], complex: [], simple: [], info: [] };
  for (const result of results) {
    for (const issue of result.issues) {
      switch (issue.classification) {
        case 'blocking':
          (result.blocking ? out.blocking : out.complex).push(issue);
          break;
        case 'followup_complex':
          out.complex.push(issue);
          break;
        case 'followup_simple':
          (issue.miniPlan.trim() ? out.simple : out.complex).push(issue);
          break;
        case 'none':
          out.info.push(issue);
          break;
      }
    }
  }
  return out;
}

export function issueLocation(issue: Issue): string {
  if (!issue.file) {
    return '';
  }
  return issue.line > 0 ? `${issue.file}:${issue.line}` : issue.file;
}

/** Les corrections renvoyées à l'agent de dev, en liste markdown. */
export function renderCorrections(review: CrReview | undefined, blocking: Issue[]): string {
  const lines: string[] = [];
  for (const c of review?.verdict === 'changes_requested' ? review.corrections : []) {
    lines.push(`- ${c.description}${c.location ? ` (${c.location})` : ''}`);
  }
  for (const issue of blocking) {
    const where = issueLocation(issue);
    lines.push(`- ${issue.title}${where ? ` (${where})` : ''} : ${issue.description}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Fiches nées du tri                                                  */
/* ------------------------------------------------------------------ */

export interface FollowUpInput {
  id: string;
  issue: Issue;
  /** Nom de l'étape qui l'a trouvée. */
  step: string;
  originStory: string;
  /** Feature de la story d'origine, pour ranger la fiche au même endroit. */
  parent: string | null;
  createdAt: Date;
  /** `ready` : fiche prête avec son mini-plan ; `new` : à planifier. */
  folder: 'new' | 'ready';
}

/**
 * Une fiche locale née du tri. Même format que les fiches saisies à la main,
 * avec `origin` et `origin_story` pour le badge du panneau.
 */
export function renderFollowUpCard(input: FollowUpInput): string {
  const { issue } = input;
  const fm: StoryFrontmatter = {
    source: 'local',
    source_id: input.id,
    parent: input.parent,
    created_at: input.createdAt.toISOString(),
    title: issue.title,
    state: 'open',
    origin: input.step,
    origin_story: input.originStory
  };
  if (input.folder === 'ready') {
    fm.planned_at = input.createdAt.toISOString();
    fm.recommended_model = 'haiku';
    fm.complexity = 'low';
    fm.files = issue.file ? [issue.file] : [];
  }
  const where = issueLocation(issue);
  const body = [
    `# ${issue.title}`,
    '',
    '## Description',
    '',
    issue.description.trim() || '_Sans description._',
    '',
    `Trouvé par ${input.step} sur la story ${input.originStory}${where ? `, dans \`${where}\`` : ''}.`,
    '',
    "## Critères d'acceptation",
    '',
    '- Le problème décrit ne se reproduit plus.',
    ''
  ];
  if (input.folder === 'ready') {
    body.push('## Mini-plan', '', issue.miniPlan.trim(), '');
  }
  return [renderFrontmatter(fm), '', ...body].join('\n');
}

/* ------------------------------------------------------------------ */
/* Rapport                                                             */
/* ------------------------------------------------------------------ */

export interface ReportInput {
  storyId: string;
  title: string;
  dev?: DevReport;
  review?: CrReview;
  results: StepResult[];
  triage: Triage;
  /** Identifiants des fiches créées par le tri. */
  followUps: string[];
  loops: number;
}

const CHECK_LABELS: Record<CheckStatus, string> = {
  passed: 'OK',
  failed: 'en échec',
  not_run: 'non lancé'
};

/** Le rapport de supervision, montré avec le CR au moment de ta revue. */
export function renderReport(input: ReportInput): string {
  const lines = [`# Supervision — ${input.storyId} ${input.title}`, ''];
  if (input.dev) {
    lines.push(
      '## Dev',
      '',
      `- Build : ${CHECK_LABELS[input.dev.build]}`,
      `- Tests : ${CHECK_LABELS[input.dev.tests]}${input.dev.testsDetail ? ` — ${input.dev.testsDetail}` : ''}`,
      `- Lint : ${CHECK_LABELS[input.dev.lint]}`,
      `- Boucles de correction : ${input.loops}`,
      ''
    );
  }
  if (input.review) {
    lines.push(
      '## Revue du CR',
      '',
      input.review.verdict === 'approved' ? '**Approuvé.**' : '**Corrections demandées.**',
      '',
      input.review.summary.trim(),
      ''
    );
  }
  for (const result of input.results) {
    lines.push(`## ${result.step}${result.blocking ? '' : ' (non bloquante)'}`, '', result.summary.trim() || '_Sans résumé._', '');
    if (result.issues.length === 0) {
      lines.push('Aucun problème.', '');
      continue;
    }
    lines.push('| Gravité | Problème | Où | Classement |', '| --- | --- | --- | --- |');
    for (const issue of result.issues) {
      lines.push(
        `| ${issue.severity} | ${cell(issue.title)} | ${cell(issueLocation(issue))} | ${issue.classification} |`
      );
    }
    if (result.permissionDenials.length > 0) {
      lines.push('', `Commandes refusées : ${result.permissionDenials.map((d) => `\`${d}\``).join(', ')}`);
    }
    lines.push('');
  }
  if (input.followUps.length > 0) {
    lines.push('## Fiches créées par le tri', '', ...input.followUps.map((id) => `- ${id}`), '');
  }
  if (input.triage.info.length > 0) {
    lines.push('## Pour information', '', ...input.triage.info.map((i) => `- ${i.title}`), '');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SupervisionConfigError(`${what} : objet attendu.`);
  }
  return value as Record<string, unknown>;
}

function optionalName(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]+$/.test(value.replace(/^\//, ''))) {
    throw new SupervisionConfigError(`${SUPERVISION_FILE}, ${what} : nom invalide.`);
  }
  return value.replace(/^\//, '');
}

function stringArray(value: unknown, what: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new SupervisionConfigError(`${SUPERVISION_FILE}, ${what} : liste de textes attendue.`);
  }
  return value.map((v: string) => v.trim()).filter(Boolean);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function check(value: unknown): CheckStatus {
  return value === 'passed' || value === 'failed' ? value : 'not_run';
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
