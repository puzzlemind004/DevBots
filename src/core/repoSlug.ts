/**
 * Lecture des identifiants de dépôt GitHub.
 *
 * Volontairement sans dépendance à `vscode` : c'est de l'analyse de chaînes,
 * testable seule.
 */

export class ConfigError extends Error {
  constructor(
    message: string,
    /** Paramètre à ouvrir pour corriger, quand il y en a un. */
    readonly settingId?: string
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface RepoSlug {
  owner: string;
  repo: string;
}

export function parseRepoSlug(slug: string): RepoSlug {
  const match = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(slug.trim());
  if (!match?.[1] || !match[2]) {
    throw new ConfigError(
      `Dépôt GitHub non reconnu : « ${slug} ». Attendu : owner/repo.`,
      'devbots.github.repository'
    );
  }
  return { owner: match[1], repo: match[2] };
}

/** Déduit `owner/repo` du remote `origin`, qu'il soit en HTTPS ou en SSH. */
export function parseGitHubRemote(remoteUrl: string): string | undefined {
  const url = remoteUrl.trim();
  const patterns = [
    /^https?:\/\/[^/]*github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/i,
    /^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(url);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}
