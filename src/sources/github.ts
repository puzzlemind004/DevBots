/**
 * Source de tickets GitHub : une issue parente et ses sub-issues, sur plusieurs niveaux.
 *
 * Lecture seule. L'API utilisée se limite aux issues et à leurs sub-issues.
 * La liste des issues ouvertes sert au choix des racines d'import.
 */

import { Octokit } from 'octokit';
import type {
  CancellationLike,
  CandidateListing,
  DeclaredDependency,
  Ticket,
  TicketCandidate,
  TicketLevel,
  TicketSource
} from '../core/model.js';
import { extractAcceptanceCriteria } from '../core/acceptance.js';

/** Profondeur maximale explorée, garde-fou contre une hiérarchie cyclique ou absurde. */
const MAX_DEPTH = 4;

/** Plafond de la liste des issues ouvertes : au-delà, la saisie d'un numéro reste possible. */
export const MAX_LISTED_ISSUES = 1000;

/** Lectures d'issues lancées ensemble par la resynchronisation. */
const PARALLEL_READS = 8;

export interface GitHubSourceOptions {
  owner: string;
  repo: string;
  token: string;
  /** N'importer que les issues écrites par cet utilisateur, ou portant le label de confiance. */
  trustedAuthorLogin?: string;
  trustedLabel?: string;
  trustedAuthorsOnly: boolean;
}

/** Une issue telle que l'API la renvoie, réduite aux champs utilisés. */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  updated_at: string;
  html_url: string;
  user: { login: string } | null;
  labels: Array<string | { name?: string }>;
}

/** Une issue de la liste du dépôt. L'API y mêle les pull requests. */
export interface GitHubListedIssue extends GitHubIssue {
  pull_request?: unknown;
  sub_issues_summary?: { total: number } | null;
}

/** Ce qui décide qu'une issue est importable sur un dépôt public. */
export interface TrustFilter {
  trustedAuthorsOnly: boolean;
  trustedAuthorLogin?: string;
  trustedLabel?: string;
}

export class GitHubTicketSource implements TicketSource {
  readonly kind = 'github' as const;
  private readonly octokit: Octokit;

  constructor(private readonly options: GitHubSourceOptions) {
    this.octokit = new Octokit({ auth: options.token });
  }

  async probe(): Promise<void> {
    await this.octokit.rest.repos.get({
      owner: this.options.owner,
      repo: this.options.repo
    });
  }

  async listCandidates(cancellation?: CancellationLike): Promise<CandidateListing> {
    let read = 0;
    const issues = (await this.octokit.paginate(
      this.octokit.rest.issues.listForRepo,
      {
        owner: this.options.owner,
        repo: this.options.repo,
        state: 'open',
        sort: 'updated',
        direction: 'desc',
        per_page: 100
      },
      (response, done) => {
        read += response.data.length;
        if (cancellation?.isCancellationRequested || read >= MAX_LISTED_ISSUES) {
          done();
        }
        return response.data;
      }
    )) as unknown as GitHubListedIssue[];

    // La dernière page lue peut dépasser le plafond : la liste est alors coupée.
    const truncated = issues.length >= MAX_LISTED_ISSUES;
    issues.length = Math.min(issues.length, MAX_LISTED_ISSUES);
    return { ...selectCandidates(issues, this.options), truncated };
  }

  async fetchTree(rootId: string, cancellation?: CancellationLike): Promise<Ticket[]> {
    const rootNumber = parseIssueNumber(rootId);
    const collected: Ticket[] = [];
    const seen = new Set<number>();

    await this.walk(rootNumber, undefined, 0, collected, seen, cancellation);

    if (collected.length === 0) {
      throw new Error(
        `L'issue #${rootNumber} n'a pas pu être importée : issue absente, ou écartée par le filtre d'auteur.`
      );
    }
    return collected;
  }

  async fetchTickets(ids: string[], cancellation?: CancellationLike): Promise<Ticket[]> {
    const numbers = [...new Set(ids.map(parseIssueNumber))];
    const tickets: Ticket[] = [];
    // Une lecture par issue : quelques-unes à la fois, pour ménager le quota de l'API.
    for (let i = 0; i < numbers.length; i += PARALLEL_READS) {
      if (cancellation?.isCancellationRequested) {
        break;
      }
      const issues = await Promise.all(numbers.slice(i, i + PARALLEL_READS).map((n) => this.getIssue(n)));
      for (const issue of issues) {
        // Une issue qui n'est plus de confiance n'est pas relue : son contenu est écarté.
        if (issue && isTrustedIssue(issue, this.options)) {
          tickets.push(this.toTicket(issue, undefined, 'story'));
        }
      }
    }
    return tickets;
  }

  /** Parcourt l'issue puis ses sub-issues, en largeur de hiérarchie et en profondeur limitée. */
  private async walk(
    issueNumber: number,
    parentId: string | undefined,
    depth: number,
    out: Ticket[],
    seen: Set<number>,
    cancellation?: CancellationLike
  ): Promise<void> {
    if (cancellation?.isCancellationRequested || depth > MAX_DEPTH || seen.has(issueNumber)) {
      return;
    }
    seen.add(issueNumber);

    const issue = await this.getIssue(issueNumber);
    if (!issue || !isTrustedIssue(issue, this.options)) {
      return;
    }

    const children = await this.listSubIssues(issueNumber);
    // Le niveau se déduit de la place dans l'arbre : la racine est l'epic, puis
    // feature, puis story. Une feuille au premier niveau est déjà une story.
    const level = levelForDepth(depth, children.length === 0);
    out.push(this.toTicket(issue, parentId, level));

    for (const child of children) {
      await this.walk(child, String(issue.number), depth + 1, out, seen, cancellation);
    }
  }

  private async getIssue(issueNumber: number): Promise<GitHubIssue | undefined> {
    try {
      const res = await this.octokit.rest.issues.get({
        owner: this.options.owner,
        repo: this.options.repo,
        issue_number: issueNumber
      });
      return res.data as unknown as GitHubIssue;
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  /** Numéros des sub-issues directes, pagination comprise. */
  private async listSubIssues(issueNumber: number): Promise<number[]> {
    try {
      const pages = await this.octokit.paginate(
        'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues',
        {
          owner: this.options.owner,
          repo: this.options.repo,
          issue_number: issueNumber,
          per_page: 100
        }
      );
      return (pages as Array<{ number: number }>).map((i) => i.number);
    } catch (err) {
      // Un dépôt sans sub-issues, ou une API indisponible, donne une feuille.
      if (isNotFound(err)) {
        return [];
      }
      throw err;
    }
  }

  private toTicket(issue: GitHubIssue, parentId: string | undefined, level: TicketLevel): Ticket {
    const body = issue.body ?? '';
    const { description, acceptanceCriteria } = extractAcceptanceCriteria(body);
    const ticket: Ticket = {
      sourceId: String(issue.number),
      level,
      title: issue.title,
      description,
      acceptanceCriteria,
      state: issue.state,
      // La date de dernière modification sert de repère de révision côté GitHub.
      revision: issue.updated_at,
      webUrl: issue.html_url,
      dependencies: parseDependencies(body),
      attachments: [],
      labels: labelNames(issue)
    };
    if (parentId !== undefined) {
      ticket.parentId = parentId;
    }
    if (issue.user?.login) {
      ticket.authorLogin = issue.user.login;
    }
    return ticket;
  }
}

/**
 * Sur un dépôt public, n'importe qui peut ouvrir une issue : son corps est du
 * texte non fiable. Le filtre ne retient que tes issues et celles que tu as
 * marquées du label de confiance.
 */
export function isTrustedIssue(issue: GitHubIssue, filter: TrustFilter): boolean {
  if (!filter.trustedAuthorsOnly) {
    return true;
  }
  if (
    filter.trustedAuthorLogin &&
    issue.user?.login?.toLowerCase() === filter.trustedAuthorLogin.toLowerCase()
  ) {
    return true;
  }
  const label = filter.trustedLabel?.toLowerCase();
  if (!label) {
    return false;
  }
  return labelNames(issue).some((name) => name.toLowerCase() === label);
}

/** Retire les pull requests de la liste, puis applique le filtre de confiance. */
export function selectCandidates(
  issues: GitHubListedIssue[],
  filter: TrustFilter
): Omit<CandidateListing, 'truncated'> {
  const candidates: TicketCandidate[] = [];
  let hiddenCount = 0;
  for (const issue of issues) {
    if (issue.pull_request) {
      continue;
    }
    if (!isTrustedIssue(issue, filter)) {
      hiddenCount++;
      continue;
    }
    const candidate: TicketCandidate = {
      sourceId: String(issue.number),
      title: issue.title,
      labels: labelNames(issue),
      updatedAt: issue.updated_at,
      webUrl: issue.html_url
    };
    if (issue.user?.login) {
      candidate.authorLogin = issue.user.login;
    }
    if (issue.sub_issues_summary) {
      candidate.childCount = issue.sub_issues_summary.total;
    }
    candidates.push(candidate);
  }
  return { candidates, hiddenCount };
}

function labelNames(issue: GitHubIssue): string[] {
  return (issue.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : l.name))
    .filter((n): n is string => typeof n === 'string');
}

/**
 * Les relations « blocked by » et « blocking » de GitHub ne sont pas exposées par
 * l'API REST des issues : elles se lisent dans le corps, à la convention
 * `Blocked by #12`, que GitHub reconnaît aussi dans son interface.
 */
export function parseDependencies(body: string): DeclaredDependency[] {
  const deps: DeclaredDependency[] = [];
  const patterns: Array<[RegExp, DeclaredDependency['kind']]> = [
    [/\bblocked\s+by\s+#(\d+)/gi, 'blockedBy'],
    [/\bbloqu[ée]e?\s+par\s+#(\d+)/gi, 'blockedBy'],
    [/\bblocks?\s+#(\d+)/gi, 'blocks'],
    [/\bbloque\s+#(\d+)/gi, 'blocks']
  ];
  for (const [pattern, kind] of patterns) {
    for (const match of body.matchAll(pattern)) {
      const id = match[1];
      if (id && !deps.some((d) => d.sourceId === id && d.kind === kind)) {
        deps.push({ kind, sourceId: id });
      }
    }
  }
  return deps;
}

/** `#42`, `42` ou une URL d'issue donnent tous le numéro 42. */
export function parseIssueNumber(raw: string): number {
  const trimmed = raw.trim();
  const fromUrl = /\/issues\/(\d+)/.exec(trimmed);
  const digits = fromUrl?.[1] ?? /^#?(\d+)$/.exec(trimmed)?.[1];
  if (!digits) {
    throw new Error(`Identifiant d'issue GitHub non reconnu : « ${raw} ». Attendu : 42, #42 ou une URL d'issue.`);
  }
  return Number(digits);
}

function levelForDepth(depth: number, isLeaf: boolean): TicketLevel {
  if (isLeaf) {
    return 'story';
  }
  return depth === 0 ? 'epic' : 'feature';
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: number }).status === 404;
}
