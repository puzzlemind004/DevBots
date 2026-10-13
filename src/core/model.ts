/**
 * Le modèle commun aux deux sources de tickets.
 *
 * Azure DevOps et GitHub produisent exactement ces objets, si bien que le reste
 * de l'extension ignore d'où viennent les stories.
 */

/** Niveau d'un ticket dans la hiérarchie de la source. */
export type TicketLevel = 'epic' | 'feature' | 'story';

/** Sens d'une dépendance déclarée dans la source. */
export type DependencyKind = 'blockedBy' | 'blocks';

/** Une dépendance telle que la source la déclare, avant vérification dans le code. */
export interface DeclaredDependency {
  kind: DependencyKind;
  /** Identifiant du ticket lié, dans la numérotation de la source. */
  sourceId: string;
  title?: string;
}

/** Une pièce jointe d'un ticket. */
export interface TicketAttachment {
  name: string;
  url: string;
}

/**
 * Un ticket normalisé, quelle que soit la source.
 *
 * `description` et `acceptanceCriteria` sont du markdown : les connecteurs
 * convertissent le HTML d'Azure DevOps avant de remplir ces champs.
 */
export interface Ticket {
  sourceId: string;
  level: TicketLevel;
  title: string;
  description: string;
  acceptanceCriteria: string;
  state: string;
  /** Identifiant du parent dans la source, absent pour la racine de l'import. */
  parentId?: string;
  /** Révision ADO, ou date de dernière modification GitHub. Sert à la resynchronisation. */
  revision: string;
  /** Page du ticket chez la source, pour le bouton « ouvrir dans la source ». */
  webUrl: string;
  dependencies: DeclaredDependency[];
  attachments: TicketAttachment[];
  /** Champs que seule Azure DevOps fournit. */
  storyPoints?: number;
  priority?: number;
  /** Auteur du ticket, utilisé pour filtrer les issues GitHub non validées. */
  authorLogin?: string;
  labels?: string[];
}

/** Le frontmatter écrit en tête de chaque fiche de `.work/new`. */
export interface StoryFrontmatter {
  source: CardSource;
  source_id: string;
  /** Les quatre champs suivants n'existent que pour une fiche importée. */
  source_rev?: string;
  imported_at?: string;
  web_url?: string;
  /** Date de création d'une fiche saisie à la main. */
  created_at?: string;
  parent: string | null;
  title: string;
  state: string;
  dependencies?: string[];
  story_points?: number;
  priority?: number;
  /** Posé par la resynchronisation quand la story a changé dans la source. */
  needs_review?: boolean;
  /** Révision vue dans la source au moment du marquage. */
  source_rev_seen?: string;
}

export type SourceKind = 'github' | 'azureDevOps';

/** Origine d'une fiche : une source de tickets, ou une saisie à la main (`LOCAL-<n>`). */
export type CardSource = SourceKind | 'local';

/**
 * Le frontmatter d'une fiche de `.work/features` : le ticket qui regroupe des
 * stories, importé ou saisi à la main. Côté source, ce peut être une feature, ou
 * une issue parente GitHub ou un epic dont dépendent directement des stories.
 */
export interface FeatureFrontmatter {
  source: CardSource;
  source_id: string;
  level: 'feature';
  /** Les cinq champs suivants n'existent que pour une fiche importée. */
  source_rev?: string;
  parent?: string | null;
  imported_at?: string;
  state?: string;
  web_url?: string;
  /** Date de création d'une fiche saisie à la main. */
  created_at?: string;
  title: string;
}

/** Ce qu'une source doit savoir faire. Lecture seule : rien n'est écrit chez elle. */
export interface TicketSource {
  readonly kind: SourceKind;
  /**
   * Récupère un ticket et toute sa descendance, dans l'ordre de la hiérarchie.
   *
   * Une story choisie seule chez Azure DevOps vient avec sa feature parente,
   * sans le reste de sa descendance, pour que sa fiche reste rangée sous elle.
   *
   * @param rootId Identifiant de work item (ADO) ou d'issue (GitHub).
   */
  fetchTree(rootId: string, token?: CancellationLike): Promise<Ticket[]>;
  /** Vérifie la connexion et les droits en lecture. */
  probe(): Promise<void>;
  /**
   * Liste les tickets ouverts qui peuvent servir de racine d'import.
   *
   * Optionnel : sans elle, l'import demande un identifiant.
   */
  listCandidates?(token?: CancellationLike): Promise<CandidateListing>;
}

/** Un ticket proposé à l'import, sans son contenu. */
export interface TicketCandidate {
  sourceId: string;
  title: string;
  labels: string[];
  authorLogin?: string;
  /** Nombre d'enfants (sub-issues, work items), quand la source le fournit. */
  childCount?: number;
  /** Niveau, quand la source le connaît sans parcourir l'arbre (Azure DevOps). */
  level?: TicketLevel;
  /** Parent direct, quand la source le fournit dans la liste. */
  parentId?: string;
  updatedAt: string;
  webUrl: string;
}

export interface CandidateListing {
  candidates: TicketCandidate[];
  /** Tickets écartés par le filtre d'auteur, pour le signaler à l'écran. */
  hiddenCount: number;
  /** Vrai quand la liste a été coupée au plafond de lecture. */
  truncated: boolean;
}

/** Le minimum attendu d'un `vscode.CancellationToken`, sans dépendre de `vscode`. */
export interface CancellationLike {
  isCancellationRequested: boolean;
}
