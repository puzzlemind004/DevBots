/**
 * Paramètres de l'extension et secrets.
 *
 * Les jetons vivent dans le SecretStorage de VS Code, jamais dans les
 * paramètres ni dans `.work`.
 */

import * as vscode from 'vscode';
import { DEFAULT_ALLOWED_COMMANDS } from '../core/devEnv.js';
import type { SourceKind } from '../core/model.js';

export const CONFIG_SECTION = 'devbots';

/** Clés du SecretStorage, une par source. */
const SECRET_KEYS: Record<SourceKind, string> = {
  github: 'devbots.github.token',
  azureDevOps: 'devbots.azureDevOps.pat'
};

export interface DevBotsConfig {
  sourceKind: SourceKind;
  githubRepository: string;
  azureOrgUrl: string;
  azureProject: string;
  workDir: string;
  downloadAssets: boolean;
  githubTrustedAuthorsOnly: boolean;
  githubTrustedLabel: string;
  maxParallelAgents: number;
  claudeExecutable: string;
  planningSkill: string;
  planningTemplate: string;
  planningModel: string;
  planningMaxResumes: number;
  devSkill: string;
  /** Modèle imposé à l'agent de dev. Vide : celui que recommande le plan. */
  devModel: string;
  devAllowedCommands: string[];
  devInstallCommand: string;
  devRulesFile: string;
  gitBaseBranch: string;
  worktreeRoot: string;
  supervisionModel: string;
  supervisionMaxLoops: number;
  mergeCheckCommands: string[];
  /** Lance l'application d'un worktree pour ta revue ; `{port}` reçoit son port. */
  reviewServeCommand: string;
  reviewBasePort: number;
}

export function readConfig(scope?: vscode.Uri): DevBotsConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION, scope ?? null);
  return {
    sourceKind: cfg.get<SourceKind>('source.kind', 'github'),
    githubRepository: cfg.get<string>('github.repository', '').trim(),
    azureOrgUrl: cfg.get<string>('azureDevOps.orgUrl', '').trim(),
    azureProject: cfg.get<string>('azureDevOps.project', '').trim(),
    workDir: cfg.get<string>('workDir', '.work').trim() || '.work',
    downloadAssets: cfg.get<boolean>('import.downloadAssets', false),
    githubTrustedAuthorsOnly: cfg.get<boolean>('import.githubTrustedAuthorsOnly', true),
    githubTrustedLabel: cfg.get<string>('import.githubTrustedLabel', 'devbots').trim(),
    maxParallelAgents: cfg.get<number>('agents.maxParallel', 2),
    claudeExecutable: cfg.get<string>('claude.executable', 'claude').trim() || 'claude',
    planningSkill: cfg.get<string>('planning.skill', '').trim().replace(/^\//, ''),
    planningTemplate: cfg.get<string>('planning.template', '').trim(),
    planningModel: cfg.get<string>('planning.model', 'opus').trim(),
    planningMaxResumes: cfg.get<number>('planning.maxResumes', 20),
    devSkill: cfg.get<string>('dev.skill', '').trim().replace(/^\//, ''),
    devModel: cfg.get<string>('dev.model', '').trim(),
    devAllowedCommands: cfg.get<string[]>('dev.allowedCommands', DEFAULT_ALLOWED_COMMANDS),
    devInstallCommand: cfg.get<string>('dev.installCommand', '').trim(),
    devRulesFile: cfg.get<string>('dev.rulesFile', '').trim(),
    gitBaseBranch: cfg.get<string>('git.baseBranch', '').trim(),
    worktreeRoot: cfg.get<string>('worktrees.root', '').trim(),
    supervisionModel: cfg.get<string>('supervision.model', 'opus').trim(),
    supervisionMaxLoops: cfg.get<number>('supervision.maxLoops', 3),
    mergeCheckCommands: cfg.get<string[]>('merge.checkCommands', []).map((c) => c.trim()).filter(Boolean),
    reviewServeCommand: cfg.get<string>('review.serveCommand', 'npx ng serve --port {port}').trim(),
    reviewBasePort: cfg.get<number>('review.basePort', 4201)
  };
}

export async function getSecret(
  secrets: vscode.SecretStorage,
  source: SourceKind
): Promise<string | undefined> {
  return secrets.get(SECRET_KEYS[source]);
}

export async function setSecret(
  secrets: vscode.SecretStorage,
  source: SourceKind,
  value: string
): Promise<void> {
  await secrets.store(SECRET_KEYS[source], value);
}

export async function deleteSecret(
  secrets: vscode.SecretStorage,
  source: SourceKind
): Promise<void> {
  await secrets.delete(SECRET_KEYS[source]);
}

export function sourceLabel(kind: SourceKind): string {
  return kind === 'github' ? 'GitHub' : 'Azure DevOps';
}
