/**
 * Le skill d'initialisation `devbots-init`, déposé dans `.claude/skills/` du
 * dépôt : Claude y trouve tout ce qui se personnalise, et interroge
 * l'utilisateur pour préparer le dépôt.
 *
 * Les étapes et le contrat sont des fichiers de `resources/init-skill/`. La
 * liste des réglages et les gabarits par défaut sont tirés de l'extension
 * elle-même au moment de l'installation : ils suivent sa version.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_SUPERVISION_FILE } from './supervision.js';
import { DEFAULT_TEMPLATES } from './templates.js';

export const INIT_SKILL_NAME = 'devbots-init';

/** Un réglage tel que le décrit `contributes.configuration` du package.json. */
export interface SettingSchema {
  scope?: string;
  default?: unknown;
  description?: string;
  markdownDescription?: string;
}

export interface InitSkillSources {
  /** `resources/init-skill/SKILL.md`. */
  skill: string;
  /** `resources/init-skill/contrat.md`. */
  contract: string;
  /** Les réglages `devbots.*`, par clé. */
  settings: Record<string, SettingSchema>;
}

export function initSkillDir(repoRoot: string): string {
  return path.join(repoRoot, '.claude', 'skills', INIT_SKILL_NAME);
}

/** Les fichiers du skill, par chemin relatif à son dossier. */
export function initSkillFiles(sources: InitSkillSources): Record<string, string> {
  return {
    'SKILL.md': sources.skill,
    'contrat.md': sources.contract,
    'parametres.md': renderSettings(sources.settings),
    'defauts/plan.md': DEFAULT_TEMPLATES.plan,
    'defauts/cr.md': DEFAULT_TEMPLATES.cr,
    'defauts/supervision.json': DEFAULT_SUPERVISION_FILE
  };
}

/**
 * La référence des réglages. La portée dit où va le réglage : `resource` se
 * partage par le `.vscode/settings.json` du dépôt, `window` reste propre au
 * poste.
 */
export function renderSettings(settings: Record<string, SettingSchema>): string {
  const rows = Object.entries(settings).map(([key, s]) => {
    const where = s.scope === 'window' || s.scope === 'application' ? 'poste' : 'dépôt';
    const value = s.default === undefined ? '' : `\`${JSON.stringify(s.default)}\``;
    return `| \`${key}\` | ${where} | ${cell(value)} | ${cell(s.markdownDescription ?? s.description ?? '')} |`;
  });
  return [
    '# Réglages DevBots',
    '',
    "Généré depuis l'extension installée. Un réglage « dépôt » va dans le",
    '`.vscode/settings.json` versionné, partagé par l\'équipe ; un réglage',
    '« poste » va dans les paramètres utilisateur de chacun.',
    '',
    '| Réglage | Portée | Défaut | Rôle |',
    '| --- | --- | --- | --- |',
    ...rows,
    ''
  ].join('\n');
}

export interface InstallResult {
  dir: string;
  /** Le dossier existait déjà. */
  existed: boolean;
  written: string[];
}

/**
 * Écrit le skill dans le dépôt. Un skill déjà présent n'est remplacé que sur
 * demande : il a pu être adapté.
 */
export async function installInitSkill(
  repoRoot: string,
  files: Record<string, string>,
  overwrite: boolean
): Promise<InstallResult> {
  const dir = initSkillDir(repoRoot);
  const existed = await exists(dir);
  const result: InstallResult = { dir, existed, written: [] };
  if (existed && !overwrite) {
    return result;
  }
  for (const [relative, content] of Object.entries(files)) {
    const filePath = path.join(dir, ...relative.split('/'));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
    result.written.push(filePath);
  }
  return result;
}

/** Une cellule de tableau markdown : ni barre verticale, ni retour à la ligne. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
