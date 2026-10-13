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
  source: SourceKind;
  source_id: string;
  source_rev: string;
  parent: string | null;
  imported_at: string;
  title: string;
  state: string;
  web_url: string;
  dependencies?: string[];
  story_points?: number;
  priority?: number;
  /** Posé par la resynchronisation quand la story a changé dans la source. */
  needs_review?: boolean;
  /** Révision vue dans la source au moment du marquage. */
  source_rev_seen?: string;
}

export type SourceKind = 'github' | 'azureDevOps';

/** Ce qu'une source doit savoir faire. Lecture seule : rien n'est écrit chez elle. */
export interface TicketSource {
  readonly kind: SourceKind;
  /**
   * Récupère un ticket et toute sa descendance, dans l'ordre de la hiérarchie.
   *
   * @param rootId Identifiant d'epic, de feature (ADO) ou d'issue parente (GitHub).
   */
  fetchTree(rootId: string, token?: CancellationLike): Promise<Ticket[]>;
  /** Vérifie la connexion et les droits en lecture. */
  probe(): Promise<void>;
}

/** Le minimum attendu d'un `vscode.CancellationToken`, sans dépendre de `vscode`. */
export interface CancellationLike {
  isCancellationRequested: boolean;
}
