import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { buildClaudeArgs, ClaudeError, parseClaudeResult } from '../../src/core/claudeCli.js';
import { safeId } from '../../src/core/planStore.js';
import { shimTarget } from '../../src/util/resolveCommand.js';

describe('buildClaudeArgs', () => {
  const base = { prompt: 'ignoré', cwd: '/repo', schema: { type: 'object' }, tools: ['Read', 'Grep'] };

  it('demande une sortie JSON structurée, sans --bare ni prompt en argument', () => {
    const args = buildClaudeArgs(base);
    expect(args.slice(0, 5)).toEqual(['-p', '--output-format', 'json', '--json-schema', '{"type":"object"}']);
    expect(args).toContain('Read,Grep');
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('ignoré');
  });

  it('reprend une session et choisit le modèle', () => {
    const args = buildClaudeArgs({ ...base, resume: 'abc', model: 'opus' });
    expect(args.join(' ')).toContain('--model opus');
    expect(args.join(' ')).toContain('--resume abc');
  });

  it("ne laisse aucun outil quand la liste est vide", () => {
    const args = buildClaudeArgs({ ...base, tools: [] });
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).not.toContain('--allowedTools');
  });
});

describe('parseClaudeResult', () => {
  it('lit la session et la sortie structurée', () => {
    const out = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 's1',
      structured_output: { word: 'pomme' },
      total_cost_usd: 0.01
    });
    expect(parseClaudeResult(`avertissement\n${out}`)).toEqual({
      sessionId: 's1',
      output: { word: 'pomme' },
      costUsd: 0.01
    });
  });

  it('remonte une erreur du CLI', () => {
    const out = JSON.stringify({ subtype: 'error_max_turns', is_error: true, session_id: 's1', result: '' });
    expect(() => parseClaudeResult(out)).toThrow(ClaudeError);
  });

  it('refuse une réponse sans sortie structurée', () => {
    const out = JSON.stringify({ subtype: 'success', is_error: false, session_id: 's1', result: 'texte' });
    expect(() => parseClaudeResult(out)).toThrow(/structurée/);
  });
});

describe('shimTarget', () => {
  it("trouve l'exécutable natif d'un lanceur npm", () => {
    const shim = '@ECHO off\r\nGOTO start\r\n:start\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
    expect(shimTarget(shim, 'C:\\npm')).toBe(
      path.win32.join('C:\\npm', 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe')
    );
  });

  it('ignore un lanceur qui passe par node', () => {
    const shim = '"%_prog%"  "%dp0%\\node_modules\\x\\cli.js" %*\r\nIF EXIST "%dp0%\\node.exe" (';
    expect(shimTarget(shim, 'C:\\npm')).toBeUndefined();
  });
});

describe('safeId', () => {
  it('empêche de sortir du dossier des plans', () => {
    expect(safeId('LOCAL-3')).toBe('LOCAL-3');
    expect(safeId('../../etc')).toBe('__.._etc');
    expect(safeId('..')).toBe('_');
    expect(safeId('a/b\\c')).toBe('a_b_c');
  });
});
