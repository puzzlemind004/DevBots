import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSkillDir, initSkillFiles, installInitSkill, renderSettings } from '../../src/core/initSkill.js';
import { DEFAULT_SUPERVISION_FILE } from '../../src/core/supervision.js';
import { DEFAULT_CR_TEMPLATE } from '../../src/core/templates.js';

const ROOT = path.resolve(__dirname, '../..');
const RESOURCES = path.join(ROOT, 'resources', 'init-skill');

describe('renderSettings', () => {
  it('range chaque réglage par portée, défaut compris', () => {
    const md = renderSettings({
      'devbots.workDir': { scope: 'resource', default: '.work', description: 'Dossier du flux.' },
      'devbots.agents.maxParallel': { scope: 'window', default: 2, markdownDescription: 'Agents en parallèle.' }
    });
    expect(md).toContain('| `devbots.workDir` | dépôt | `".work"` | Dossier du flux. |');
    expect(md).toContain('| `devbots.agents.maxParallel` | poste | `2` | Agents en parallèle. |');
  });

  it('garde le tableau intact : ni barre verticale, ni retour à la ligne', () => {
    const md = renderSettings({ 'devbots.x': { description: 'a | b\n\nc' } });
    expect(md).toContain('| a \\| b c |');
  });
});

describe('initSkillFiles', () => {
  it('joint les gabarits et la supervision par défaut de cette version', () => {
    const files = initSkillFiles({ skill: 'S', contract: 'C', settings: {} });
    expect(Object.keys(files).sort()).toEqual([
      'SKILL.md',
      'contrat.md',
      'defauts/cr.md',
      'defauts/plan.md',
      'defauts/supervision.json',
      'parametres.md'
    ]);
    expect(files['defauts/cr.md']).toBe(DEFAULT_CR_TEMPLATE);
    expect(files['defauts/supervision.json']).toBe(DEFAULT_SUPERVISION_FILE);
  });
});

describe('installInitSkill', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'devbots-init-'));
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('écrit le skill dans .claude/skills/devbots-init', async () => {
    const result = await installInitSkill(repo, { 'SKILL.md': 'v1', 'defauts/plan.md': 'p' }, false);
    expect(result.existed).toBe(false);
    expect(await fs.readFile(path.join(repo, '.claude', 'skills', 'devbots-init', 'defauts', 'plan.md'), 'utf8')).toBe('p');
  });

  it("ne remplace un skill existant que sur demande", async () => {
    await installInitSkill(repo, { 'SKILL.md': 'v1' }, false);
    const kept = await installInitSkill(repo, { 'SKILL.md': 'v2' }, false);
    expect(kept).toMatchObject({ existed: true, written: [] });
    expect(await fs.readFile(path.join(initSkillDir(repo), 'SKILL.md'), 'utf8')).toBe('v1');

    await installInitSkill(repo, { 'SKILL.md': 'v2' }, true);
    expect(await fs.readFile(path.join(initSkillDir(repo), 'SKILL.md'), 'utf8')).toBe('v2');
  });
});

describe('ressources du skill', () => {
  it('ne cite que des réglages que l’extension déclare', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, unknown> } };
    };
    const declared = Object.keys(pkg.contributes.configuration.properties);
    for (const file of ['SKILL.md', 'contrat.md']) {
      const text = await fs.readFile(path.join(RESOURCES, file), 'utf8');
      for (const [key] of text.matchAll(/devbots\.[a-zA-Z]+\.[a-zA-Z]+|devbots\.workDir/g)) {
        expect(declared, `${file} : ${key}`).toContain(key);
      }
    }
  });

  it('est un skill que seul l’utilisateur lance', async () => {
    const skill = await fs.readFile(path.join(RESOURCES, 'SKILL.md'), 'utf8');
    expect(skill.startsWith('---\nname: devbots-init\n')).toBe(true);
    expect(skill).toContain('disable-model-invocation: true');
  });
});
