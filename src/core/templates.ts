/**
 * Les gabarits du flux : plan de story et compte rendu de dev (CR).
 *
 * Chacun a une version par défaut, livrée avec l'extension. Un dépôt la
 * remplace en déposant son propre fichier dans `<workDir>/templates/`, ou, pour
 * le plan, par le paramètre `devbots.planning.template`, qui reste prioritaire.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_PLAN_TEMPLATE } from './planRender.js';

export type TemplateKind = 'plan' | 'cr';

export const TEMPLATE_KINDS: readonly TemplateKind[] = ['plan', 'cr'];

/**
 * Gabarit de CR par défaut.
 *
 * L'agent de dev le remplit lui-même (phase 3) : les sections sont des
 * consignes, pas des marqueurs. Seuls `{{title}}` et `{{source_id}}` sont
 * remplis par l'extension avant de le lui confier.
 */
export const DEFAULT_CR_TEMPLATE = `# CR — {{source_id}} {{title}}

## Résumé

<!-- Ce qui a été fait, en deux ou trois phrases. -->

## Critères d'acceptation

<!-- Un élément par critère du plan (C1, C2…) : couvert ou non, et où. -->

## Changements

<!-- Fichiers touchés, groupés par étape du plan. -->

## Tests

<!-- Build, tests unitaires et e2e : lancés, résultat, tests ajoutés. -->

## Écarts au plan

<!-- Ce qui diffère du plan validé, et pourquoi. « Aucun » sinon. -->

## Points d'attention

<!-- Ce que le relecteur doit regarder en priorité, questions ouvertes. -->
`;

export const DEFAULT_TEMPLATES: Record<TemplateKind, string> = {
  plan: DEFAULT_PLAN_TEMPLATE,
  cr: DEFAULT_CR_TEMPLATE
};

/** D'où vient le gabarit retenu. */
export type TemplateOrigin = 'setting' | 'workDir' | 'default';

export interface ResolvedTemplate {
  kind: TemplateKind;
  content: string;
  origin: TemplateOrigin;
  /** Chemin du fichier lu ; absent pour le gabarit par défaut. */
  filePath?: string;
}

export class TemplateError extends Error {}

/** `<workDir>/templates/<kind>.md` : l'emplacement par convention. */
export function templatePath(workRoot: string, kind: TemplateKind): string {
  return path.join(workRoot, 'templates', `${kind}.md`);
}

export interface ResolveOptions {
  repoRoot: string;
  workRoot: string;
  /** Chemin explicite, relatif au dépôt, donné par un paramètre. Vide : ignoré. */
  setting?: string;
}

/**
 * Le gabarit à utiliser : le paramètre s'il est renseigné, sinon le fichier du
 * dossier de travail s'il existe, sinon celui par défaut.
 *
 * Un paramètre qui désigne un fichier absent est une erreur : on ne retombe
 * pas en silence sur le défaut quand le dépôt a demandé autre chose.
 */
export async function resolveTemplate(
  kind: TemplateKind,
  options: ResolveOptions
): Promise<ResolvedTemplate> {
  const setting = options.setting?.trim();
  if (setting) {
    const filePath = path.resolve(options.repoRoot, setting);
    const content = await readIfExists(filePath);
    if (content === undefined) {
      throw new TemplateError(`Gabarit introuvable : ${setting}.`);
    }
    return { kind, content, origin: 'setting', filePath };
  }

  const filePath = templatePath(options.workRoot, kind);
  const content = await readIfExists(filePath);
  if (content !== undefined) {
    return { kind, content, origin: 'workDir', filePath };
  }
  return { kind, content: DEFAULT_TEMPLATES[kind], origin: 'default' };
}

export interface EjectResult {
  written: string[];
  /** Les fichiers déjà présents, laissés tels quels. */
  kept: string[];
}

/**
 * Dépose les gabarits par défaut dans `<workDir>/templates/`, pour servir de
 * base à ceux du dépôt. Un fichier existant n'est jamais écrasé.
 */
export async function ejectTemplates(workRoot: string): Promise<EjectResult> {
  const result: EjectResult = { written: [], kept: [] };
  await fs.mkdir(path.join(workRoot, 'templates'), { recursive: true });
  for (const kind of TEMPLATE_KINDS) {
    const filePath = templatePath(workRoot, kind);
    try {
      await fs.writeFile(filePath, DEFAULT_TEMPLATES[kind], { encoding: 'utf8', flag: 'wx' });
      result.written.push(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      result.kept.push(filePath);
    }
  }
  return result;
}

async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}
