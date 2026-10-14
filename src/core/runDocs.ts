/**
 * Les comptes rendus consultables d'une story partie en dev : le CR de
 * l'agent et le rapport de supervision, seulement ceux qui existent.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { StoryRun } from './flowState.js';
import { DEVBOTS_DIR } from './git.js';
import { safeId } from './planStore.js';

export type RunDocKind = 'cr' | 'report';

export interface RunDoc {
  kind: RunDocKind;
  path: string;
}

export const RUN_DOC_LABELS: Record<RunDocKind, string> = {
  cr: "CR de l'agent",
  report: 'Rapport de supervision'
};

/**
 * Le CR est lu dans le worktree tant qu'il y est : c'est la version la plus
 * récente, et la seule quand l'agent a planté avant la revue. Sinon, la copie
 * prise à la revue dans `runs/<id>/`. Le rapport n'existe qu'après une revue.
 */
export async function runDocs(runsPath: string, run: StoryRun): Promise<RunDoc[]> {
  const dir = path.join(runsPath, safeId(run.storyId));
  const candidates: Array<{ kind: RunDocKind; paths: string[] }> = [
    {
      kind: 'cr',
      paths: [...(run.worktree ? [path.join(run.worktree, DEVBOTS_DIR, 'cr.md')] : []), path.join(dir, 'cr.md')]
    },
    { kind: 'report', paths: [path.join(dir, 'report.md')] }
  ];
  const docs: RunDoc[] = [];
  for (const { kind, paths } of candidates) {
    for (const candidate of paths) {
      if (await exists(candidate)) {
        docs.push({ kind, path: candidate });
        break;
      }
    }
  }
  return docs;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
