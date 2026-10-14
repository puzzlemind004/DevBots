import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installSteps } from '../../src/core/devEnv.js';

describe('installSteps', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devbots-env-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function touch(rel: string): Promise<void> {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), '{}', 'utf8');
  }

  it('installe à la racine quand le projet y est, sans chercher plus loin', async () => {
    await touch('pnpm-lock.yaml');
    await touch('apps/web/package-lock.json');
    expect(await installSteps(dir, '')).toEqual([
      { cwd: dir, command: ['pnpm', 'install', '--frozen-lockfile'] }
    ]);
  });

  it('trouve les projets en sous-dossier, hors node_modules et dossiers cachés', async () => {
    await touch('apps/web/package-lock.json');
    await touch('apps/web/node_modules/x/package.json');
    await touch('api/package.json');
    await touch('.claude/package.json');
    await touch('node_modules/y/package.json');
    expect(await installSteps(dir, '')).toEqual([
      { cwd: path.join(dir, 'api'), command: ['npm', 'install'] },
      { cwd: path.join(dir, 'apps', 'web'), command: ['npm', 'ci'] }
    ]);
  });

  it('suit le paramètre : une commande à la racine, ou rien', async () => {
    await touch('apps/web/package-lock.json');
    expect(await installSteps(dir, 'npm ci --prefix apps/web')).toEqual([
      { cwd: dir, command: ['npm', 'ci', '--prefix', 'apps/web'] }
    ]);
    expect(await installSteps(dir, 'none')).toEqual([]);
  });
});
