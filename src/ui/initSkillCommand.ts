/**
 * « Installer le skill d'initialisation » : dépose `devbots-init` dans
 * `.claude/skills/` du dépôt. L'utilisateur le lance ensuite dans Claude Code,
 * qui l'interroge et prépare le dépôt.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  INIT_SKILL_NAME,
  initSkillDir,
  initSkillFiles,
  installInitSkill,
  type SettingSchema
} from '../core/initSkill.js';

export interface InitSkillContext {
  repoUri: vscode.Uri;
  extension: vscode.Extension<unknown>;
  log: vscode.LogOutputChannel;
}

export async function installInitSkillCommand(ctx: InitSkillContext): Promise<void> {
  const repoRoot = ctx.repoUri.fsPath;
  let overwrite = false;
  if (await exists(initSkillDir(repoRoot))) {
    const replace = 'Remplacer';
    const choice = await vscode.window.showWarningMessage(
      `Le skill ${INIT_SKILL_NAME} est déjà dans .claude/skills/. Le remplacer par celui de cette version de DevBots ?`,
      { modal: true },
      replace
    );
    if (choice !== replace) {
      return;
    }
    overwrite = true;
  }

  try {
    const resources = path.join(ctx.extension.extensionPath, 'resources', 'init-skill');
    const files = initSkillFiles({
      skill: await fs.readFile(path.join(resources, 'SKILL.md'), 'utf8'),
      contract: await fs.readFile(path.join(resources, 'contrat.md'), 'utf8'),
      settings: devbotsSettings(ctx.extension.packageJSON)
    });
    const result = await installInitSkill(repoRoot, files, overwrite);
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(result.dir, 'SKILL.md'))),
      { preview: false }
    );
    vscode.window.showInformationMessage(
      `Skill ${INIT_SKILL_NAME} installé. Ouvre Claude Code à la racine du dépôt et lance /${INIT_SKILL_NAME} : il te guide dans la configuration.`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error(`Skill d'initialisation : ${message}`);
    vscode.window.showErrorMessage(`Impossible d'installer le skill d'initialisation : ${message}`);
  }
}

/** Les réglages déclarés par le package.json de l'extension. */
function devbotsSettings(packageJSON: unknown): Record<string, SettingSchema> {
  const configuration = (packageJSON as { contributes?: { configuration?: unknown } }).contributes?.configuration;
  const sections = (Array.isArray(configuration) ? configuration : [configuration]) as Array<
    { properties?: Record<string, SettingSchema> } | undefined
  >;
  return Object.assign({}, ...sections.map((s) => s?.properties ?? {})) as Record<string, SettingSchema>;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
