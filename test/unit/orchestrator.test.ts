/**
 * L'orchestrateur sur un faux git et un faux CLI : la boucle de dev, les
 * corrections, le budget, les retours humains. Le parcours complet et les
 * merges sur un vrai dépôt sont dans `orchestrator.git.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FlowStateStore, FlowStatus } from '../../src/core/flowState.js';
import type { DevSettings, Orchestrator, OrchestratorEvent } from '../../src/core/orchestrator.js';
import { DEV_SCHEMA, ISSUES_SCHEMA, REVIEW_SCHEMA } from '../../src/core/supervision.js';
import type { FakeGit } from './fakeGit.js';
import { approved, devWrites, Harness, noIssues, type FakeClaude } from './orchestratorHarness.js';

describe('Orchestrator', () => {
  let h: Harness;
  let work: string;
  let claude: FakeClaude;
  let events: OrchestratorEvent[];
  let settings: DevSettings;
  let orchestrator: Orchestrator;
  let store: FlowStateStore;
  let fakeGit: FakeGit;

  beforeEach(async () => {
    h = await Harness.create();
    ({ work, claude, events, settings, store, orchestrator } = h);
    fakeGit = h.fakeGit!;
  });

  afterEach(() => h.dispose());

  function makeOrchestrator(deps: Parameters<Harness['replaceOrchestrator']>[0]): Orchestrator {
    return h.replaceOrchestrator(deps);
  }

  const addReady = (id: string, files: string[], extra = '') => h.addReady(id, files, extra);
  const settle = (id: string, wanted?: FlowStatus) => h.settle(id, wanted);

  it("renvoie les corrections à un agent neuf, puis relit dans une session neuve", async () => {
    await addReady('42', ['src/email.ts']);
    claude.dev.push(devWrites('src/email.ts'), devWrites('src/email.ts', 'export const ok = 1;\n'));
    claude.review.push(
      () => ({ verdict: 'changes_requested', summary: '', corrections: [{ description: 'Couvrir C2', location: 'CR' }] }),
      approved
    );
    claude.steps.push(noIssues);

    await orchestrator.enqueue('42', 'sonnet');
    expect(await settle('42')).toBe('awaiting_human');

    const devs = claude.requests.filter((r) => r.schema === DEV_SCHEMA);
    expect(devs).toHaveLength(2);
    expect(devs[1]!.resume).toBeUndefined();
    expect(devs[1]!.maxTurns).toBe(40);
    expect(devs[1]!.prompt.startsWith('/dev-story\n')).toBe(true);
    expect(devs[1]!.prompt).toContain('- Couvrir C2 (CR)');
    expect(devs[1]!.prompt).toContain('Session neuve');
    const reviews = claude.requests.filter((r) => r.schema === REVIEW_SCHEMA);
    expect(reviews.every((r) => r.resume === undefined)).toBe(true);

    const run = (await store.read()).stories['42']!;
    expect(run.loops).toBe(1);
    expect(fakeGit.log(run.branch, 2)).toEqual(['42 : corrections (boucle 1)', '42 : Story 42']);
  });

  it('renvoie un build en échec sans appeler la revue', async () => {
    await addReady('42', ['src/email.ts']);
    claude.dev.push(
      async (r) => ({ ...((await devWrites('src/email.ts')(r)) as object), build: 'failed' }),
      devWrites('src/email.ts', 'export const ok = 2;\n')
    );
    claude.review.push(approved);
    claude.steps.push(noIssues);

    await orchestrator.enqueue('42', 'sonnet');
    expect(await settle('42')).toBe('awaiting_human');
    expect(claude.requests.map((r) => r.schema)).toEqual([DEV_SCHEMA, DEV_SCHEMA, REVIEW_SCHEMA, ISSUES_SCHEMA]);
    expect(claude.requests[1]!.prompt).toContain('Le build est en échec');
  });

  it('te rend la main au plafond de boucles, et reprend les corrections à la relance', async () => {
    await addReady('42', ['src/email.ts']);
    await fs.writeFile(
      path.join(work, 'supervision.json'),
      JSON.stringify({ maxLoops: 0, steps: [{ skill: 'pre-pr-check' }] }),
      'utf8'
    );
    claude.dev.push(devWrites('src/email.ts'));
    claude.review.push(approved);
    claude.steps.push(() => ({
      summary: '',
      issues: [
        {
          title: 'Fuite',
          description: 'Abonnement jamais fermé.',
          severity: 'blocking',
          file: 'src/email.ts',
          line: 3,
          classification: 'blocking',
          mini_plan: ''
        }
      ]
    }));

    await orchestrator.enqueue('42', 'sonnet');
    expect(await settle('42', 'blocked')).toBe('blocked');
    const blocked = (await store.read()).stories['42']!;
    expect(blocked.reason).toContain('Plafond de 0 boucle');
    expect(blocked.pendingCorrections).toContain('Fuite');
    expect(events.some((e) => e.kind === 'blocked')).toBe(true);

    claude.dev.push(devWrites('src/email.ts', 'export const ok = 3;\n'));
    claude.review.push(approved);
    claude.steps.push(noIssues);
    await orchestrator.retry('42');
    expect(await settle('42')).toBe('awaiting_human');
    const resumed = claude.requests.filter((r) => r.schema === DEV_SCHEMA)[1]!;
    expect(resumed.resume).toBeUndefined();
    expect(resumed.prompt).toContain('Fuite (src/email.ts:3)');
    // La relance vérifie la correction : le CR, déjà approuvé, ne repasse pas en revue.
    expect(claude.requests.filter((r) => r.schema === REVIEW_SCHEMA)).toHaveLength(1);
    expect(claude.requests.at(-1)!.prompt).toContain('vérification des corrections');
  });

  const FUITE = {
    title: 'Fuite',
    description: 'Abonnement jamais fermé.',
    severity: 'blocking',
    file: 'src/email.ts',
    line: 3,
    classification: 'blocking',
    mini_plan: ''
  };

  it('après une correction, ne revérifie que les problèmes bloquants, sur le diff de la correction', async () => {
    await addReady('42', ['src/email.ts']);
    await fs.writeFile(
      path.join(work, 'supervision.json'),
      JSON.stringify({ steps: [{ skill: 'pre-pr-check' }, { name: 'securite', skill: 'secu' }] }),
      'utf8'
    );
    const suivi = {
      title: 'Revoir la validation',
      description: 'À part.',
      severity: 'major',
      file: '',
      line: 0,
      classification: 'followup_complex',
      mini_plan: ''
    };
    claude.dev.push(devWrites('src/email.ts'), devWrites('src/email.ts', 'export const ok = 1;\n'));
    claude.review.push(approved);
    claude.steps.push(() => ({ summary: '', issues: [FUITE, suivi] }), noIssues, () => ({ summary: 'Corrigé.', issues: [] }));

    await orchestrator.enqueue('42', 'sonnet');
    expect(await settle('42')).toBe('awaiting_human');

    // Le CR, déjà approuvé, ne repasse pas ; l'étape sans bloquant non plus.
    expect(claude.requests.map((r) => r.schema)).toEqual([
      DEV_SCHEMA,
      REVIEW_SCHEMA,
      ISSUES_SCHEMA,
      ISSUES_SCHEMA,
      DEV_SCHEMA,
      ISSUES_SCHEMA
    ]);
    const verification = claude.requests[5]!;
    expect(verification.prompt.startsWith('/')).toBe(false);
    expect(verification.prompt).toContain('vérification des corrections');
    expect(verification.prompt).toContain('Fuite (src/email.ts:3)');
    expect(verification.prompt).toContain('.devbots/fix.patch');

    const run = (await store.read()).stories['42']!;
    const devbots = path.join(run.worktree, '.devbots');
    const fix = await fs.readFile(path.join(devbots, 'fix.patch'), 'utf8');
    expect(fix).toContain('+export const ok = 1;');
    expect(fix).not.toContain('+export const ok = true;');
    expect(await fs.readFile(path.join(devbots, 'corrections.md'), 'utf8')).toContain('Fuite');
    // Le suivi trouvé au premier passage est bien trié.
    expect(run.followUps).toEqual(['LOCAL-1']);
    expect(run.verification).toBeUndefined();
  });

  it('ne relance pas de boucle pour un problème bloquant de gravité mineure', async () => {
    await addReady('42', ['src/email.ts']);
    claude.dev.push(devWrites('src/email.ts'));
    claude.review.push(approved);
    claude.steps.push(() => ({
      summary: '',
      issues: [{ ...FUITE, title: 'Lien manquant dans la doc', severity: 'minor', mini_plan: '1. Ajouter le lien.' }]
    }));

    await orchestrator.enqueue('42', 'sonnet');
    expect(await settle('42')).toBe('awaiting_human');
    expect(claude.requests.filter((r) => r.schema === DEV_SCHEMA)).toHaveLength(1);
    expect((await store.read()).stories['42']!.followUps).toEqual(['LOCAL-1']);
    await expect(fs.access(path.join(work, 'ready', 'LOCAL-1-lien-manquant-dans-la-doc.md'))).resolves.toBeUndefined();
  });

  it("lance les checks après la session, et renvoie un échec à l'agent sans revue", async () => {
    await addReady('42', ['src/email.ts']);
    const checks: string[] = [];
    orchestrator = makeOrchestrator({
      check: async (_dir, command) => {
        checks.push(command);
        if (checks.length === 1) {
          throw new Error('erreur TS2345');
        }
      }
    });
    settings.checkCommands = ['npm run build', 'npm test'];
    claude.dev.push(devWrites('src/email.ts'), async (r) => ({
      ...((await devWrites('src/email.ts', 'export const ok = 1;\n')(r)) as object),
      build: 'not_run',
      tests: 'failed'
    }));
    claude.review.push(approved);
    claude.steps.push(noIssues);

    await orchestrator.enqueue('42', 'sonnet');
    expect(await settle('42')).toBe('awaiting_human');

    // Le premier échec arrête la série ; les checks font foi sur le statut déclaré.
    expect(checks).toEqual(['npm run build', 'npm run build', 'npm test']);
    expect(claude.requests.map((r) => r.schema)).toEqual([DEV_SCHEMA, DEV_SCHEMA, REVIEW_SCHEMA, ISSUES_SCHEMA]);
    const [first, second] = claude.requests;
    expect(first!.prompt).toContain('DevBots lance lui-même : npm run build, npm test');
    expect(first!.appendSystemPrompt).toContain('jamais en tâche de fond');
    expect(second!.prompt).toContain('« npm run build » échoue');
    expect(second!.prompt).toContain('erreur TS2345');
    expect((await store.read()).stories['42']!.lastDev!.checks).toEqual([
      { command: 'npm run build', passed: true },
      { command: 'npm test', passed: true }
    ]);
  });

  it('bloque une story qui a épuisé son budget, et la relance lui en rouvre un', async () => {
    await addReady('42', ['src/email.ts']);
    settings.storyBudgetUsd = 1;
    claude.cost = 0.6;
    claude.dev.push(devWrites('src/email.ts'));
    claude.review.push(approved);

    await orchestrator.enqueue('42', 'sonnet');
    expect(await settle('42', 'blocked')).toBe('blocked');
    const blocked = (await store.read()).stories['42']!;
    expect(blocked.reason).toContain('Budget de 1 $ atteint (1.20 $');
    // Dev puis revue du CR : l'étape suivante n'a pas été lancée.
    expect(claude.requests.map((r) => r.schema)).toEqual([DEV_SCHEMA, REVIEW_SCHEMA]);

    claude.cost = 0;
    claude.dev.push(devWrites('src/email.ts'));
    claude.review.push(approved);
    claude.steps.push(noIssues);
    await orchestrator.retry('42');
    expect(await settle('42')).toBe('awaiting_human');
    expect((await store.read()).stories['42']!.costUsd).toBeUndefined();
    expect(claude.requests[2]!.prompt).toContain('Une session précédente a commencé cette story');
  });

  it('ne lance pas en parallèle deux stories qui touchent un même fichier', async () => {
    await addReady('42', ['src/shared.ts']);
    await addReady('43', ['src/shared.ts']);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    claude.dev.push(async (r) => {
      await gate;
      return devWrites('src/shared.ts')(r);
    }, devWrites('src/shared.ts', 'export const b = 1;\n'));
    claude.review.push(approved, approved);
    claude.steps.push(noIssues, noIssues);

    await orchestrator.enqueue('42', 'sonnet');
    await orchestrator.enqueue('43', 'sonnet');
    const state = await store.read();
    expect(state.stories['43']!.status).toBe('queued');
    expect(state.stories['43']!.reason).toContain('fichiers communs avec 42');
    release();
    expect(await settle('42')).toBe('awaiting_human');
    // 42 attend ton feu vert : ses fichiers restent occupés jusqu'au merge.
    expect((await store.read()).stories['43']!.status).toBe('queued');
  });

  it("s'arrête à ta demande, et la story passe bloquée", async () => {
    await addReady('42', ['src/email.ts']);
    claude.dev.push(
      (r) =>
        new Promise((_, reject) =>
          r.signal!.addEventListener('abort', () => reject(new Error('tué')), { once: true })
        )
    );
    await orchestrator.enqueue('42', 'sonnet');
    await settle('42', 'in_dev');
    for (let i = 0; i < 100 && claude.requests.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(orchestrator.stop('42')).toBe(true);
    expect(await settle('42', 'blocked')).toBe('blocked');
    expect((await store.read()).stories['42']!.reason).toBe('Arrêtée par toi.');
  });

  it("retente l'installation des dépendances à la relance si elle a échoué", async () => {
    await addReady('42', ['src/email.ts']);
    const installs: string[] = [];
    settings.installCommand = 'npm ci';
    orchestrator = makeOrchestrator({
      install: async (dir, command) => {
        installs.push(command.join(' '));
        if (installs.length === 1) {
          throw new Error('registre injoignable');
        }
      }
    });

    await orchestrator.enqueue('42', 'sonnet');
    expect(await settle('42', 'blocked')).toBe('blocked');
    expect((await store.read()).stories['42']!.reason).toBe('registre injoignable');

    claude.dev.push(devWrites('src/email.ts'));
    claude.review.push(approved);
    claude.steps.push(noIssues);
    await orchestrator.retry('42');
    expect(await settle('42')).toBe('awaiting_human');
    expect(installs).toEqual(['npm ci', 'npm ci']);
  });

  it('au redémarrage, bloque les stories dont le processus a disparu', async () => {
    await store.update((s) => {
      s.stories['42'] = {
        storyId: '42',
        title: 'x',
        status: 'in_dev',
        model: 'sonnet',
        baseBranch: 'main',
        branch: 'story/42',
        worktree: '',
        loops: 0,
        queuedAt: '',
        updatedAt: '',
        followUps: []
      };
    });
    expect(await orchestrator.recover()).toEqual(['42']);
    expect((await store.read()).stories['42']).toMatchObject({ status: 'blocked' });
  });

  describe('revue humaine', () => {
    it("renvoie tes retours à un agent neuf, sans dupliquer les fiches du tri", async () => {
      await addReady('42', ['src/email.ts']);
      const issue = {
        title: 'Extraire la constante',
        description: 'Valeur magique.',
        severity: 'minor',
        file: 'src/email.ts',
        line: 1,
        classification: 'followup_complex',
        mini_plan: ''
      };
      claude.dev.push(devWrites('src/email.ts'), devWrites('src/email.ts', 'export const valid = true;\n'));
      claude.review.push(approved, approved);
      claude.steps.push(() => ({ summary: '', issues: [issue] }), () => ({ summary: '', issues: [issue] }));
      await orchestrator.enqueue('42', 'sonnet');
      expect(await settle('42')).toBe('awaiting_human');

      await orchestrator.sendFeedback('42', 'Renomme ok en valid.');
      expect(await settle('42')).toBe('awaiting_human');

      const dev = claude.requests.filter((r) => r.schema === DEV_SCHEMA)[1]!;
      expect(dev.resume).toBeUndefined();
      expect(dev.prompt).toContain('Retours de la revue humaine');
      expect(dev.prompt).toContain('Renomme ok en valid.');
      expect((await store.read()).stories['42']!.followUps).toEqual(['LOCAL-1']);
      expect(await fs.readdir(path.join(work, 'new'))).toEqual(['LOCAL-1-extraire-la-constante.md']);
    });

    it("transmet ta réponse à un agent bloqué, en session neuve", async () => {
      await addReady('42', ['src/email.ts']);
      claude.dev.push(async () => ({
        status: 'blocked',
        summary: '',
        build: 'not_run',
        tests: 'not_run',
        tests_detail: '',
        lint: 'not_run',
        blocked_reason: 'Quel format de date ?'
      }));
      await orchestrator.enqueue('42', 'sonnet');
      expect(await settle('42', 'blocked')).toBe('blocked');

      claude.dev.push(devWrites('src/email.ts'));
      claude.review.push(approved);
      claude.steps.push(noIssues);
      await orchestrator.sendFeedback('42', 'ISO 8601.');
      expect(await settle('42')).toBe('awaiting_human');

      const dev = claude.requests.filter((r) => r.schema === DEV_SCHEMA)[1]!;
      expect(dev.resume).toBeUndefined();
      expect(dev.prompt).toContain('Réponse humaine à ton blocage');
      expect(dev.prompt).toContain('Quel format de date ?');
      expect(dev.prompt).toContain('ISO 8601.');
    });

    it("n'accepte feu vert et retours que sur une story à valider ou bloquée", async () => {
      await addReady('42', ['src/email.ts']);
      await expect(orchestrator.approve('42')).rejects.toThrow("n'attend pas ton feu vert");
      await expect(orchestrator.sendFeedback('42', 'x')).rejects.toThrow("n'attend ni ta revue ni ta réponse");
    });

    it('donne à chaque worktree un port stable, sans doublon', async () => {
      await store.update((s) => {
        for (const id of ['42', '43']) {
          s.stories[id] = {
            storyId: id,
            title: id,
            status: 'awaiting_human',
            model: 'sonnet',
            baseBranch: 'main',
            branch: `story/${id}`,
            worktree: '',
            loops: 0,
            queuedAt: '',
            updatedAt: '',
            followUps: []
          };
        }
      });
      expect(await orchestrator.assignPort('42', 4201)).toBe(4201);
      expect(await orchestrator.assignPort('43', 4201)).toBe(4202);
      expect(await orchestrator.assignPort('42', 4201)).toBe(4201);
    });

    it('au redémarrage, un merge interrompu revient à valider', async () => {
      await store.update((s) => {
        s.stories['42'] = {
          storyId: '42',
          title: 'x',
          status: 'merging',
          model: 'sonnet',
          baseBranch: 'main',
          branch: 'story/42',
          worktree: '',
          loops: 0,
          queuedAt: '',
          updatedAt: '',
          followUps: []
        };
      });
      expect(await orchestrator.recover()).toEqual([]);
      expect((await store.read()).stories['42']).toMatchObject({ status: 'awaiting_human' });
    });
  });
});
