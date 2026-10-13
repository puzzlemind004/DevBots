import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_PLAN_TEMPLATE } from '../../src/core/planRender.js';
import {
  DEFAULT_CR_TEMPLATE,
  ejectTemplates,
  resolveTemplate,
  TemplateError,
  templatePath
} from '../../src/core/templates.js';

describe('gabarits', () => {
  let repoRoot: string;
  let workRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'devbots-templates-'));
    workRoot = path.join(repoRoot, '.work');
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('retombe sur le gabarit par défaut sans fichier ni paramètre', async () => {
    const plan = await resolveTemplate('plan', { repoRoot, workRoot });
    expect(plan).toEqual({ kind: 'plan', content: DEFAULT_PLAN_TEMPLATE, origin: 'default' });
    const cr = await resolveTemplate('cr', { repoRoot, workRoot, setting: '  ' });
    expect(cr.content).toBe(DEFAULT_CR_TEMPLATE);
  });

  it('prend le fichier du dossier de travail quand il existe', async () => {
    await fs.mkdir(path.join(workRoot, 'templates'), { recursive: true });
    await fs.writeFile(templatePath(workRoot, 'cr'), 'Mon CR', 'utf8');
    const cr = await resolveTemplate('cr', { repoRoot, workRoot });
    expect(cr).toMatchObject({ content: 'Mon CR', origin: 'workDir' });
  });

  it('donne la priorité au paramètre, relatif au dépôt', async () => {
    await fs.mkdir(path.join(workRoot, 'templates'), { recursive: true });
    await fs.writeFile(templatePath(workRoot, 'plan'), 'Du dossier', 'utf8');
    await fs.writeFile(path.join(repoRoot, 'plan-equipe.md'), 'Du paramètre', 'utf8');
    const plan = await resolveTemplate('plan', { repoRoot, workRoot, setting: 'plan-equipe.md' });
    expect(plan).toMatchObject({ content: 'Du paramètre', origin: 'setting' });
  });

  it("refuse un paramètre qui désigne un fichier absent, au lieu du défaut", async () => {
    await expect(
      resolveTemplate('plan', { repoRoot, workRoot, setting: 'absent.md' })
    ).rejects.toBeInstanceOf(TemplateError);
  });

  it("dépose les gabarits par défaut sans écraser ceux du dépôt", async () => {
    await fs.mkdir(path.join(workRoot, 'templates'), { recursive: true });
    await fs.writeFile(templatePath(workRoot, 'plan'), 'Le mien', 'utf8');

    const result = await ejectTemplates(workRoot);

    expect(result.written).toEqual([templatePath(workRoot, 'cr')]);
    expect(result.kept).toEqual([templatePath(workRoot, 'plan')]);
    expect(await fs.readFile(templatePath(workRoot, 'plan'), 'utf8')).toBe('Le mien');
    expect(await fs.readFile(templatePath(workRoot, 'cr'), 'utf8')).toBe(DEFAULT_CR_TEMPLATE);
  });
});
