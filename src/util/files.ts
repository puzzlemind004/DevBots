/**
 * Écriture et lecture des fichiers d'état (`state.json`, `session.json`).
 *
 * L'écriture passe par un fichier temporaire renommé : un arrêt brutal ne
 * laisse pas un état à moitié écrit. Mais sous Windows, un fichier ouvert,
 * même un instant, ne peut pas être remplacé par un renommage, et le panneau
 * relit ces fichiers à chaque changement : des lectures rapprochées peuvent
 * empêcher le renommage indéfiniment. Après quelques essais, le fichier est
 * donc réécrit sur place, et la lecture tolère un contenu lu en pleine écriture.
 */

import { promises as fs } from 'node:fs';

const RENAME_ATTEMPTS = 5;

export async function replaceFile(target: string, content: string): Promise<void> {
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  for (let i = 1; i <= RENAME_ATTEMPTS; i++) {
    try {
      await fs.rename(tmp, target);
      return;
    } catch (err) {
      if (!isLockError(err)) {
        throw err;
      }
      await delay(5 * i);
    }
  }
  await fs.writeFile(target, content, 'utf8');
  await fs.rm(tmp, { force: true });
}

/**
 * Lit un fichier JSON. Un contenu illisible est relu quelques fois : il peut
 * avoir été lu pendant sa réécriture sur place. Un fichier absent rend
 * `undefined`.
 */
export async function readJson<T>(filePath: string, attempts = 5): Promise<T | undefined> {
  for (let i = 1; ; i++) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      if (i < attempts && isLockError(err)) {
        await delay(5 * i);
        continue;
      }
      throw err;
    }
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      if (i >= attempts) {
        throw err;
      }
      await delay(5 * i);
    }
  }
}

function isLockError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
