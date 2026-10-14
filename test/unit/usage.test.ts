import { describe, expect, it } from 'vitest';
import {
  ageLabel,
  mergeSnapshots,
  parseRateLimitLine,
  probeArgs,
  usageBar,
  windowView
} from '../../src/core/usage.js';

const NOW = new Date('2026-10-14T10:00:00Z');
const seconds = (iso: string): number => new Date(iso).getTime() / 1000;

/** Un `rate_limit_event` tel que l'écrit le CLI 2.1.296. */
function event(info: object): string {
  return JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'u', session_id: 's' });
}

describe('parseRateLimitLine', () => {
  it('lit la session et la semaine du détail par fenêtre', () => {
    const line = event({
      status: 'allowed',
      resetsAt: seconds('2026-10-14T13:30:00Z'),
      rateLimitType: 'five_hour',
      unifiedWindows: {
        five_hour: { utilization: 0.04, resetsAt: seconds('2026-10-14T13:30:00Z') },
        seven_day: { utilization: 0.22, resetsAt: seconds('2026-10-17T12:00:00Z') }
      }
    });
    expect(parseRateLimitLine(line, NOW)).toEqual({
      session: { utilization: 0.04, resetsAt: '2026-10-14T13:30:00.000Z' },
      week: { utilization: 0.22, resetsAt: '2026-10-17T12:00:00.000Z' },
      status: 'allowed',
      at: NOW.toISOString()
    });
  });

  it('se rabat sur la fenêtre principale sans détail', () => {
    const line = event({
      status: 'rejected',
      resetsAt: seconds('2026-10-17T12:00:00Z'),
      rateLimitType: 'seven_day',
      utilization: 1
    });
    const snapshot = parseRateLimitLine(line, NOW);
    expect(snapshot?.week).toEqual({ utilization: 1, resetsAt: '2026-10-17T12:00:00.000Z' });
    expect(snapshot?.session).toBeUndefined();
    expect(snapshot?.status).toBe('rejected');
  });

  it('ignore le reste du flux et un événement sans chiffres', () => {
    expect(parseRateLimitLine(JSON.stringify({ type: 'result' }))).toBeUndefined();
    expect(parseRateLimitLine(event({ status: 'allowed' }))).toBeUndefined();
    expect(parseRateLimitLine('pas du json')).toBeUndefined();
  });
});

describe('mergeSnapshots', () => {
  const week = { utilization: 0.3, resetsAt: '2026-10-17T12:00:00.000Z' };
  const session = { utilization: 0.1, resetsAt: '2026-10-14T13:00:00.000Z' };

  it("garde la fenêtre que le nouveau relevé ne donne pas, tant qu'elle court", () => {
    const merged = mergeSnapshots({ session, week, status: 'allowed', at: 'a' }, { session: { ...session, utilization: 0.2 }, status: 'allowed', at: 'b' }, NOW);
    expect(merged).toEqual({ session: { ...session, utilization: 0.2 }, week, status: 'allowed', at: 'b' });
  });

  it('oublie une fenêtre déjà réinitialisée', () => {
    const old = { utilization: 0.9, resetsAt: '2026-10-14T09:00:00.000Z' };
    expect(mergeSnapshots({ session: old, status: 'allowed', at: 'a' }, { week, status: 'allowed', at: 'b' }, NOW).session).toBeUndefined();
  });
});

describe('affichage', () => {
  it('donne le pourcentage, la réinitialisation et le temps restant', () => {
    const view = windowView({ utilization: 0.456, resetsAt: '2026-10-14T12:05:00.000Z' }, NOW);
    expect(view.percent).toBe(46);
    expect(view.elapsed).toBe(false);
    expect(view.resetIn).toBe('dans 2 h 05');
    expect(view.resetLabel).toMatch(/^à \d\d:\d\d$/);
  });

  it('remet à zéro une fenêtre dont la réinitialisation est passée', () => {
    const view = windowView({ utilization: 0.8, resetsAt: '2026-10-14T09:00:00.000Z' }, NOW);
    expect(view).toMatchObject({ percent: 0, elapsed: true });
  });

  it('nomme un jour lointain et compte les jours', () => {
    const view = windowView({ utilization: 0.2, resetsAt: '2026-10-17T12:00:00.000Z' }, NOW);
    expect(view.resetLabel).toMatch(/^\S+\. 17 oct\. à \d\d:\d\d$/);
    expect(view.resetIn).toBe('dans 3 j 2 h');
  });

  it('dessine la jauge et l’âge du relevé', () => {
    expect(usageBar(46)).toBe('█████░░░░░');
    expect(usageBar(130)).toBe('██████████');
    expect(ageLabel('2026-10-14T09:57:00Z', NOW)).toBe('il y a 3 min');
    expect(ageLabel('2026-10-14T09:59:30Z', NOW)).toBe("à l'instant");
  });
});

describe('probeArgs', () => {
  it('fait un appel minimal, sans outil ni session gardée', () => {
    const args = probeArgs();
    expect(args).toEqual(expect.arrayContaining(['stream-json', '--verbose', 'haiku', '--no-session-persistence']));
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).not.toContain('--bare');
  });
});
