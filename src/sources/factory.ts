/**
 * Construit la source de tickets configurée pour un dépôt, et résout son accès.
 *
 * Côté GitHub, la connexion intégrée à VS Code est essayée d'abord : aucun jeton
 * à gérer dans ce cas. Un jeton à granularité fine enregistré dans le
 * SecretStorage la remplace quand elle n'est pas disponible.
 */

import * as vscode from 'vscode';
import type { TicketSource } from '../core/model.js';
import { GitHubTicketSource } from './github.js';
import { AzureDevOpsTicketSource } from './azureDevOps.js';
import { getSecret, type DevBotsConfig } from '../util/config.js';
import { ConfigError, parseGitHubRemote, parseRepoSlug } from '../core/repoSlug.js';

export { ConfigError, parseGitHubRemote, parseRepoSlug };
export type { RepoSlug } from '../core/repoSlug.js';

/** Portée minimale : lecture des issues des dépôts publics et privés. */
const GITHUB_SCOPES = ['repo'];

export async function createSource(
  config: DevBotsConfig,
  secrets: vscode.SecretStorage,
  repoRoot: string
): Promise<TicketSource> {
  if (config.sourceKind === 'github') {
    return createGitHubSource(config, secrets, repoRoot);
  }
  return createAzureSource(config, secrets);
}

async function createGitHubSource(
  config: DevBotsConfig,
  secrets: vscode.SecretStorage,
  repoRoot: string
): Promise<TicketSource> {
  const slug = config.githubRepository || (await detectGitHubRepo(repoRoot));
  if (!slug) {
    throw new ConfigError(
      "Aucun dépôt GitHub : renseigne-le dans les paramètres, ou ouvre un dépôt dont le remote origin pointe vers GitHub.",
      'devbots.github.repository'
    );
  }
  const parsed = parseRepoSlug(slug);

  const stored = await getSecret(secrets, 'github');
  let token = stored;
  let login: string | undefined;

  if (!token) {
    // `createIfNone: false` : on ne force pas de fenêtre de connexion à l'activation.
    const session = await vscode.authentication.getSession('github', GITHUB_SCOPES, {
      createIfNone: false,
      silent: true
    });
    const active =
      session ??
      (await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: true }));
    if (!active) {
      throw new ConfigError(
        "Connexion GitHub refusée. Connecte-toi à GitHub dans VS Code, ou enregistre un jeton avec « DevBots : enregistrer un jeton d'accès »."
      );
    }
    token = active.accessToken;
    login = active.account.label;
  }

  const options = {
    owner: parsed.owner,
    repo: parsed.repo,
    token,
    trustedAuthorsOnly: config.githubTrustedAuthorsOnly,
    trustedLabel: config.githubTrustedLabel,
    ...(login ? { trustedAuthorLogin: login } : {})
  };
  return new GitHubTicketSource(options);
}

async function createAzureSource(
  config: DevBotsConfig,
  secrets: vscode.SecretStorage
): Promise<TicketSource> {
  if (!config.azureOrgUrl) {
    throw new ConfigError(
      "L'URL de l'organisation Azure DevOps n'est pas renseignée.",
      'devbots.azureDevOps.orgUrl'
    );
  }
  if (!config.azureProject) {
    throw new ConfigError(
      "Le projet Azure DevOps n'est pas renseigné.",
      'devbots.azureDevOps.project'
    );
  }
  const token = await getSecret(secrets, 'azureDevOps');
  if (!token) {
    throw new ConfigError(
      "Aucun PAT Azure DevOps enregistré. Lance « DevBots : enregistrer un jeton d'accès » avec un PAT limité à la lecture des work items."
    );
  }
  return new AzureDevOpsTicketSource({
    orgUrl: config.azureOrgUrl,
    project: config.azureProject,
    token
  });
}

async function detectGitHubRepo(repoRoot: string): Promise<string | undefined> {
  const { exec } = await import('../util/exec.js');
  try {
    const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot });
    return parseGitHubRemote(stdout);
  } catch {
    return undefined;
  }
}
