import { describe, expect, it } from 'vitest';
import { emptyFlowState, type FlowState, type FlowStatus, type StoryRun } from '../../src/core/flowState.js';
import {
  blockers,
  dependencyView,
  normalizeFile,
  pickNext,
  schedulable,
  type ScheduleContext,
  type SchedulableStory
} from '../../src/core/schedule.js';

function story(id: string, overrides: Partial<SchedulableStory> = {}): SchedulableStory {
  return { id, declared: [], confirmed: [], refuted: [], files: [], ...overrides };
}

function run(storyId: string, status: FlowStatus, queuedAt = '2026-10-13T10:00:00Z'): StoryRun {
  return {
    storyId,
    title: storyId,
    status,
    model: 'sonnet',
    baseBranch: '',
    branch: '',
    worktree: '',
    loops: 0,
    queuedAt,
    updatedAt: queuedAt,
    followUps: []
  };
}

function ctx(stories: SchedulableStory[], state: FlowState = emptyFlowState(), done: string[] = []): ScheduleContext {
  return {
    state,
    doneIds: new Set(done),
    knownIds: new Set([...stories.map((s) => s.id), ...done]),
    stories: new Map(stories.map((s) => [s.id, s]))
  };
}

describe('schedulable', () => {
  it('lit le frontmatter de ready/', () => {
    const s = schedulable({
      source_id: '42',
      dependencies: ['40'],
      dependencies_confirmed: ['40'],
      dependencies_refuted: [],
      files: ['.\\src\\app\\a.ts']
    });
    expect(s).toEqual({ id: '42', declared: ['40'], confirmed: ['40'], refuted: [], files: ['src/app/a.ts'] });
  });

  it('normalise les chemins', () => {
    expect(normalizeFile(' ./src/a.ts ')).toBe('src/a.ts');
  });
});

describe('dependencyView', () => {
  it("n'attend qu'une dépendance confirmée par le plan", () => {
    const s = story('42', { declared: ['40', '41'], confirmed: ['40'], refuted: ['41'] });
    expect(dependencyView(s)).toEqual({ waitOn: ['40'], parallelizable: ['41'], ignored: [] });
  });

  it('respecte tes arbitrages', () => {
    const s = story('42', { declared: ['40', '41'], confirmed: ['40'], refuted: ['41'] });
    expect(dependencyView(s, { '40': 'ignore', '41': 'wait' })).toEqual({
      waitOn: ['41'],
      parallelizable: [],
      ignored: ['40']
    });
  });

  it('attend une dépendance déclarée sans verdict', () => {
    expect(dependencyView(story('42', { declared: ['40'] })).waitOn).toEqual(['40']);
  });
});

describe('blockers', () => {
  it('attend une dépendance confirmée tant qu’elle n’est pas dans done/', () => {
    const s = story('42', { confirmed: ['40'] });
    expect(blockers(s, ctx([s, story('40')]))).toEqual(['attend 40']);
    expect(blockers(s, ctx([s], emptyFlowState(), ['40']))).toEqual([]);
  });

  it('signale une dépendance absente du flux', () => {
    const s = story('42', { confirmed: ['99'] });
    expect(blockers(s, ctx([s]))).toEqual(['attend 99, absente du flux']);
  });

  it('refuse le parallélisme sur des fichiers communs', () => {
    const a = story('1', { files: ['src/a.ts', 'src/b.ts'] });
    const b = story('2', { files: ['src/b.ts'] });
    const state = emptyFlowState();
    state.stories['1'] = run('1', 'in_dev');
    expect(blockers(b, ctx([a, b], state))).toEqual(['fichiers communs avec 1 : src/b.ts']);
  });
});

describe('pickNext', () => {
  it('lance par ordre d’arrivée, sans dépasser le plafond', () => {
    const state = emptyFlowState();
    state.stories['2'] = run('2', 'queued', '2026-10-13T10:02:00Z');
    state.stories['1'] = run('1', 'queued', '2026-10-13T10:01:00Z');
    state.stories['3'] = run('3', 'queued', '2026-10-13T10:03:00Z');
    const pick = pickNext(ctx([story('1'), story('2'), story('3')], state), 2);
    expect(pick.start).toEqual(['1', '2']);
    expect(pick.waiting.get('3')).toBe('plafond de 2 agents atteint');
  });

  it('compte les agents déjà lancés', () => {
    const state = emptyFlowState();
    state.stories['1'] = run('1', 'ai_review');
    state.stories['2'] = run('2', 'queued');
    expect(pickNext(ctx([story('1'), story('2')], state), 1).start).toEqual([]);
  });

  it('une story choisie occupe ses fichiers pour la suivante de la file', () => {
    const state = emptyFlowState();
    state.stories['1'] = run('1', 'queued', '2026-10-13T10:01:00Z');
    state.stories['2'] = run('2', 'queued', '2026-10-13T10:02:00Z');
    const pick = pickNext(
      ctx([story('1', { files: ['src/a.ts'] }), story('2', { files: ['src/a.ts'] })], state),
      4
    );
    expect(pick.start).toEqual(['1']);
    expect(pick.waiting.get('2')).toContain('fichiers communs avec 1');
  });

  it('laisse en file une story sortie de ready/', () => {
    const state = emptyFlowState();
    state.stories['1'] = run('1', 'queued');
    expect(pickNext(ctx([], state), 2).waiting.get('1')).toBe('fiche absente de ready/');
  });
});
