import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import matter from 'gray-matter';
import {
  parseVerification,
  renderVerificationReport,
  VERIFY_ALLOWED_TOOLS,
  VERIFY_SCHEMA,
  verificationPrompt,
  verifyAlreadyDone
} from '../../src/core/alreadyDone.js';
import type { ClaudeResponse, ClaudeStreamRequest } from '../../src/core/claudeCli.js';
import { WorkDir, type StoryFile } from '../../src/core/workDir.js';
import { SAMPLE_CARD } from './fixtures.js';

describe('parseVerification', () => {
  it('garde un verdict « done » dont chaque critère est couvert', () => {
    const v = parseVerification({
      verdict: 'done',
      summary: 'Tout est là.',
      criteria: [{ criterion: 'Email refusé', status: 'covered', evidence: 'src/email.ts:12' }]
    });
    expect(v.verdict).toBe('done');
    expect(v.criteria).toHaveLength(1);
  });

  it('rétrograde un « done » qui laisse un critère de côté', () => {
    const v = parseVerification({
      verdict: 'done',
      summary: '',
      criteria: [
        { criterion: 'A', status: 'covered', evidence: '' },
        { criterion: 'B', status: 'missing', evidence: '' }
      ]
    });
    expect(v.verdict).toBe('partial');
  });

  it('lit une réponse abîmée comme « pas trouvé »', () => {
    expect(parseVerification(null)).toEqual({ verdict: 'not_done', summary: '', criteria: [] });
    expect(parseVerification({ verdict: 'oui', criteria: [{ status: 'bof' }] }).criteria[0]?.status).toBe('missing');
  });
});

describe('vérification « déjà fait »', () => {
  let root: string;
  let workDir: WorkDir;
  let story: StoryFile;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'devbots-done-'));
    workDir = new WorkDir(path.join(root, '.work'));
    await workDir.ensureFolders();
    await fs.writeFile(path.join(workDir.folderPath('ready'), '42-email.md'), SAMPLE_CARD, 'utf8');
    story = (await workDir.listStories('ready'))[0]!;
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("donne la fiche et ton indication à un agent en lecture seule, et écrit son rapport", async () => {
    const requests: ClaudeStreamRequest[] = [];
    const stream = async (request: ClaudeStreamRequest): Promise<ClaudeResponse> => {
      requests.push(request);
      request.onEvent({ kind: 'tool', name: 'Grep', detail: 'email' });
      return {
        sessionId: 's1',
        output: {
          verdict: 'done',
          summary: 'Validateur et message en place.',
          criteria: [
            { criterion: 'Un email invalide est refusé', status: 'covered', evidence: 'src/email.validator.ts:4' },
            { criterion: 'Un message explique pourquoi', status: 'covered', evidence: 'signup.html | ligne 9' }
          ]
        },
        permissionDenials: ['Bash : npm test']
      };
    };

    const verification = await verifyAlreadyDone(
      { repoRoot: root, workDir, stream, model: 'opus', now: () => new Date('2026-10-14T10:00:00Z') },
      story,
      'branche feature/email'
    );

    expect(verification.verdict).toBe('done');
    const request = requests[0]!;
    expect(request.schema).toBe(VERIFY_SCHEMA);
    expect(request.cwd).toBe(root);
    expect(request.tools).not.toContain('Edit');
    expect(request.tools).not.toContain('Write');
    expect(request.allowedTools).toEqual(VERIFY_ALLOWED_TOOLS);
    expect(request.disallowedTools).toContain('Bash(git commit:*)');
    expect(request.prompt).toContain(story.filePath);
    expect(request.prompt).toContain('branche feature/email');

    const runDir = path.join(workDir.runsPath(), '42');
    const report = await fs.readFile(path.join(runDir, 'verification.md'), 'utf8');
    expect(report).toContain('**déjà fait**');
    expect(report).toContain('signup.html \\| ligne 9');
    const journal = await fs.readFile(path.join(runDir, 'journal.log'), 'utf8');
    expect(journal).toContain('→ Grep : email');
    expect(journal).toContain('Refusé : Bash : npm test');
    // La vérification ne déplace pas la fiche : c'est à l'appelant de décider.
    expect((await workDir.listStories('ready'))).toHaveLength(1);
  });

  it('sans indication, le prompt ne parle que de la fiche', () => {
    expect(verificationPrompt(story, '  ')).not.toContain("Indication de l'utilisateur");
  });

  it('le rapport cite ton indication et chaque critère', () => {
    const report = renderVerificationReport(
      story,
      { verdict: 'partial', summary: 'Message absent.', criteria: [{ criterion: 'Message', status: 'missing', evidence: 'rien' }] },
      'PR #12',
      new Date('2026-10-14T10:00:00Z')
    );
    expect(report).toContain('**fait en partie**');
    expect(report).toContain('Ton indication : PR #12');
    expect(report).toContain('| Message | ❌ manquant | rien |');
  });

  it('passe la fiche dans Done avec sa marque, sans champ vide', async () => {
    const target = await workDir.moveToDone(story, {
      done_outside: 'direct',
      done_at: '2026-10-14T10:00:00.000Z',
      done_note: undefined
    });
    const data = matter(await fs.readFile(target, 'utf8')).data;
    expect(data).toMatchObject({ source_id: '42', done_outside: 'direct', done_at: '2026-10-14T10:00:00.000Z' });
    expect('done_note' in data).toBe(false);
    expect(await workDir.listStories('ready')).toHaveLength(0);
  });
});
