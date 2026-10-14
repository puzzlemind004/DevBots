/**
 * Vérification du CLI Claude Code, et appels non interactifs (`claude -p`).
 *
 * L'extension lance le `claude` installé sur le poste et n'appelle jamais l'API :
 * elle ne manipule aucun identifiant. La seule chose à vérifier au démarrage est
 * donc que le CLI est présent et dans une version connue.
 */

import { exec, ExecError } from '../util/exec.js';
import { parseRateLimitLine, type UsageSnapshot } from './usage.js';

/**
 * Version minimale vérifiée au démarrage.
 *
 * L'atelier de planification repose sur `--output-format json`, `--resume` et
 * `--json-schema`, éprouvés avec la 2.1.296. La borne exacte d'apparition de
 * `--json-schema` n'est pas vérifiée : à relever si une version plus ancienne
 * échoue.
 */
export const MIN_CLAUDE_VERSION = '2.0.0';

export interface ClaudeStatus {
  installed: boolean;
  version?: string;
  versionOk: boolean;
  /** Message à montrer tel quel quand quelque chose manque. */
  problem?: string;
}

export async function checkClaude(executable: string): Promise<ClaudeStatus> {
  let raw: string;
  try {
    const result = await exec(executable, ['--version'], { timeoutMs: 15_000 });
    raw = result.stdout;
  } catch (err) {
    const detail = err instanceof ExecError ? err.message : String(err);
    return {
      installed: false,
      versionOk: false,
      problem: `Claude Code est introuvable (« ${executable} »). Installe-le, ou corrige le paramètre devbots.claude.executable. Détail : ${detail}`
    };
  }

  const version = parseVersion(raw);
  if (!version) {
    return {
      installed: true,
      versionOk: false,
      problem: `La version de Claude Code n'a pas pu être lue dans « ${raw} ».`
    };
  }

  if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
    return {
      installed: true,
      version,
      versionOk: false,
      problem: `Claude Code ${version} est trop ancien : version ${MIN_CLAUDE_VERSION} au minimum.`
    };
  }

  return { installed: true, version, versionOk: true };
}

/** `2.1.296 (Claude Code)` donne `2.1.296`. */
export function parseVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

/** Compare deux versions sémantiques. Négatif si `a` est antérieur à `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* Appels non interactifs : `claude -p`                                */
/* ------------------------------------------------------------------ */

/** Un appel à Claude dont la réponse suit un schéma JSON imposé. */
export interface ClaudeRequest {
  prompt: string;
  /** Dossier de travail : la racine du dépôt, pour que les skills et le CLAUDE.md soient chargés. */
  cwd: string;
  schema: object;
  model?: string;
  /** Session à reprendre. Absente : session neuve, l'équivalent d'un /clear. */
  resume?: string;
  /** Outils disponibles. Une liste vide n'en laisse aucun. */
  tools: readonly string[];
  /**
   * Règles de permission (`Bash(npm test:*)`…). Absentes : les outils de
   * `tools`, tous autorisés. Ce qui n'est pas autorisé est refusé : `-p` ne
   * pose jamais de question.
   */
  allowedTools?: readonly string[];
  /** Règles refusées dans tous les cas, par prudence (`Bash(git push:*)`). */
  disallowedTools?: readonly string[];
  /** Agent de `.claude/agents/` qui mène la session. */
  agent?: string;
  appendSystemPrompt?: string;
  signal?: AbortSignal;
}

export interface ClaudeResponse {
  sessionId: string;
  /** Le `structured_output` du CLI, à valider par l'appelant. */
  output: unknown;
  costUsd?: number;
  /** Les appels d'outils refusés faute de permission, résumés. */
  permissionDenials?: string[];
}

export type ClaudeRunner = (request: ClaudeRequest) => Promise<ClaudeResponse>;

/** Un appel suivi en direct : chaque événement du CLI est remis à `onEvent`. */
export interface ClaudeStreamRequest extends ClaudeRequest {
  onEvent: (event: StreamEvent) => void;
}

export type ClaudeStreamRunner = (request: ClaudeStreamRequest) => Promise<ClaudeResponse>;

/** Un événement de `--output-format stream-json`, réduit à ce que le journal affiche. */
export type StreamEvent =
  | { kind: 'init'; sessionId: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'toolError'; detail: string }
  /** Sortie structurée refusée par le schéma : Claude la corrige et la renvoie, sans y être invité. */
  | { kind: 'schemaRetry'; detail: string }
  | { kind: 'result'; ok: boolean; detail: string };

export class ClaudeError extends Error {
  constructor(
    message: string,
    readonly cancelled = false
  ) {
    super(message);
    this.name = 'ClaudeError';
  }
}

/**
 * Les arguments de `claude` pour une requête.
 *
 * Le prompt passe par l'entrée standard : ni limite de longueur de ligne de
 * commande sous Windows, ni risque qu'une option à valeurs multiples l'avale.
 * `--bare` n'est jamais utilisé : il contourne la connexion par abonnement.
 */
export function buildClaudeArgs(request: ClaudeRequest, stream = false): string[] {
  const args = stream
    ? ['-p', '--output-format', 'stream-json', '--verbose']
    : ['-p', '--output-format', 'json'];
  args.push('--json-schema', JSON.stringify(request.schema));
  if (request.model) {
    args.push('--model', request.model);
  }
  if (request.resume) {
    args.push('--resume', request.resume);
  }
  if (request.agent) {
    args.push('--agent', request.agent);
  }
  args.push('--tools', request.tools.join(','));
  // Une règle par argument : une règle peut contenir des espaces.
  if (request.allowedTools) {
    if (request.allowedTools.length > 0) {
      args.push('--allowedTools', ...request.allowedTools);
    }
  } else if (request.tools.length > 0) {
    args.push('--allowedTools', request.tools.join(','));
  }
  if (request.disallowedTools && request.disallowedTools.length > 0) {
    args.push('--disallowedTools', ...request.disallowedTools);
  }
  // Mode par défaut : ce qui n'est pas autorisé est refusé, y compris la
  // redirection d'un `echo` vers un fichier, que `acceptEdits` laisse passer.
  args.push('--permission-mode', 'default');
  if (request.appendSystemPrompt) {
    args.push('--append-system-prompt', request.appendSystemPrompt);
  }
  return args;
}

/** Lit la sortie `--output-format json` du CLI. */
export function parseClaudeResult(stdout: string): ClaudeResponse {
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(lastJsonLine(stdout)) as Record<string, unknown>;
  } catch {
    throw new ClaudeError(`Réponse illisible de Claude Code : ${truncate(stdout, 300)}`);
  }
  if (result.is_error === true || (result.subtype && result.subtype !== 'success')) {
    const detail = typeof result.result === 'string' && result.result ? result.result : String(result.subtype);
    throw new ClaudeError(`Claude Code a échoué : ${truncate(detail, 500)}`);
  }
  if (typeof result.session_id !== 'string') {
    throw new ClaudeError('Réponse de Claude Code sans identifiant de session.');
  }
  if (result.structured_output === undefined || result.structured_output === null) {
    throw new ClaudeError("Claude Code n'a pas renvoyé de réponse structurée.");
  }
  return {
    sessionId: result.session_id,
    output: result.structured_output,
    costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined,
    permissionDenials: readDenials(result.permission_denials)
  };
}

export function createClaudeRunner(executable: string): ClaudeRunner {
  return (request) => runCli(executable, buildClaudeArgs(request), request);
}

/**
 * Le lanceur suivi en direct : `stream-json`, une ligne JSON par événement.
 *
 * La dernière ligne est le résultat, de la même forme que la sortie `json` :
 * session, `structured_output`, refus de permission.
 *
 * `onUsage` reçoit au passage l'usage de l'abonnement (session, semaine), que
 * le CLI publie à chaque réponse de l'API.
 */
export function createClaudeStreamRunner(
  executable: string,
  onUsage?: (snapshot: UsageSnapshot) => void
): ClaudeStreamRunner {
  return (request) => {
    let pending = '';
    const onStdout = (chunk: string): void => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        for (const event of parseStreamLine(line)) {
          request.onEvent(event);
        }
        if (onUsage && line.includes('"rate_limit_event"')) {
          const usage = parseRateLimitLine(line);
          if (usage) {
            onUsage(usage);
          }
        }
      }
    };
    return runCli(executable, buildClaudeArgs(request, true), request, onStdout);
  };
}

async function runCli(
  executable: string,
  args: string[],
  request: ClaudeRequest,
  onStdout?: (chunk: string) => void
): Promise<ClaudeResponse> {
  try {
    const { stdout } = await exec(executable, args, {
      cwd: request.cwd,
      env: subscriptionEnv(process.env),
      input: request.prompt,
      signal: request.signal,
      onStdout
    });
    return parseClaudeResult(stdout);
  } catch (err) {
    if (err instanceof ClaudeError) {
      throw err;
    }
    if (err instanceof ExecError) {
      if (err.cancelled) {
        throw new ClaudeError('Appel à Claude annulé.', true);
      }
      // En échec, le CLI écrit souvent tout de même son JSON de résultat.
      if (err.result.stdout.includes('"type":"result"')) {
        return parseClaudeResult(err.result.stdout);
      }
      throw new ClaudeError(err.message);
    }
    throw err;
  }
}

/**
 * Variables qui feraient passer le CLI par l'API (clé, jeton, Bedrock, Vertex)
 * au lieu de la connexion par abonnement du poste.
 */
const API_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX'
];

/**
 * L'environnement des appels à `claude` : celui du poste, sans ce qui le
 * ferait facturer à l'API. Une clé présente sur le poste n'est jamais utilisée.
 */
export function subscriptionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const name of Object.keys(clean)) {
    if (API_ENV_VARS.includes(name.toUpperCase())) {
      delete clean[name];
    }
  }
  return clean;
}

function readDenials(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((d: unknown) => {
    const denial = (d ?? {}) as { tool_name?: unknown; tool_input?: Record<string, unknown> };
    const input = denial.tool_input ?? {};
    const detail = input.command ?? input.file_path ?? input.pattern ?? '';
    return `${String(denial.tool_name ?? '?')}${detail ? ` : ${String(detail)}` : ''}`;
  });
}

/**
 * Traduit une ligne de `stream-json` en événements pour le journal.
 *
 * Seuls les messages utiles pour suivre l'agent sont gardés : son texte, ses
 * appels d'outils, les erreurs d'outils et le résultat. Le reste (réflexion,
 * quotas, tokens) est ignoré.
 */
export function parseStreamLine(line: string): StreamEvent[] {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  switch (event.type) {
    case 'system':
      return event.subtype === 'init' && typeof event.session_id === 'string'
        ? [{ kind: 'init', sessionId: event.session_id, model: asString(event.model) }]
        : [];
    case 'assistant':
      return contentOf(event).flatMap((block): StreamEvent[] => {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          return [{ kind: 'text', text: block.text.trim() }];
        }
        // L'outil de sortie structurée n'intéresse pas le journal : le résultat suit.
        if (block.type === 'tool_use' && typeof block.name === 'string' && block.name !== 'StructuredOutput') {
          return [{ kind: 'tool', name: block.name, detail: toolDetail(block.input) }];
        }
        return [];
      });
    case 'user':
      return contentOf(event).flatMap((block): StreamEvent[] =>
        block.type === 'tool_result' && block.is_error === true
          ? [toolErrorEvent(truncate(resultText(block.content), 300))]
          : []
      );
    case 'result': {
      const ok = event.is_error !== true && event.subtype === 'success';
      const turns = typeof event.num_turns === 'number' ? `${event.num_turns} tours` : '';
      const cost =
        typeof event.total_cost_usd === 'number' ? `${event.total_cost_usd.toFixed(2)} $` : '';
      const detail = [String(event.subtype ?? ''), turns, cost].filter(Boolean).join(' · ');
      return [{ kind: 'result', ok, detail }];
    }
    default:
      return [];
  }
}

/** Une ligne de journal lisible pour un événement. */
export function formatStreamEvent(event: StreamEvent): string {
  switch (event.kind) {
    case 'init':
      return `Session ${event.sessionId}${event.model ? ` (${event.model})` : ''}`;
    case 'text':
      return event.text;
    case 'tool':
      return `→ ${event.name}${event.detail ? ` : ${event.detail}` : ''}`;
    case 'toolError':
      return `✗ ${event.detail}`;
    case 'schemaRetry':
      return `↻ Sortie hors schéma, Claude la corrige : ${event.detail}`;
    case 'result':
      return `${event.ok ? 'Terminé' : 'Échec'} — ${event.detail}`;
  }
}

/** Le CLI renvoie lui-même à Claude une sortie structurée invalide : ce n'est pas un échec. */
function toolErrorEvent(detail: string): StreamEvent {
  const schema = /^Output does not match required schema:\s*/.exec(detail);
  return schema
    ? { kind: 'schemaRetry', detail: detail.slice(schema[0].length) }
    : { kind: 'toolError', detail };
}

type ContentBlock = Record<string, unknown> & { type?: unknown };

function contentOf(event: Record<string, unknown>): ContentBlock[] {
  const message = event.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? (message.content as ContentBlock[]) : [];
}

function toolDetail(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const detail = i.command ?? i.file_path ?? i.pattern ?? i.path ?? i.description ?? '';
  return truncate(String(detail).replace(/\s+/g, ' '), 200);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        const text = (c as { text?: unknown } | null)?.text;
        return typeof text === 'string' ? text : '';
      })
      .join(' ');
  }
  return '';
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Le CLI peut écrire des avertissements avant le JSON : seule la dernière ligne compte. */
function lastJsonLine(stdout: string): string {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? '';
    if (line.startsWith('{')) {
      return line;
    }
  }
  return stdout.trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
