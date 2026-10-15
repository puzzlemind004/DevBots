import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  buildClaudeArgs,
  ClaudeError,
  formatStreamEvent,
  parseClaudeResult,
  parseStreamLine,
  subscriptionEnv
} from '../../src/core/claudeCli.js';
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

  it('ouvre les dossiers supplémentaires, un par option', () => {
    const args = buildClaudeArgs({ ...base, addDirs: ['/repo/.work', '/autre'] });
    expect(args.join(' ')).toContain('--add-dir /repo/.work --add-dir /autre');
    expect(buildClaudeArgs(base)).not.toContain('--add-dir');
  });

  it('plafonne les tours quand on le demande', () => {
    expect(buildClaudeArgs({ ...base, maxTurns: 40 }).join(' ')).toContain('--max-turns 40');
    expect(buildClaudeArgs(base)).not.toContain('--max-turns');
  });

    it("ne laisse aucun outil quand la liste est vide", () => {
    const args = buildClaudeArgs({ ...base, tools: [] });
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).not.toContain('--allowedTools');
  });

  it('refuse tout ce qui n’est pas autorisé : mode de permission par défaut', () => {
    const args = buildClaudeArgs(base);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
  });

  it('passe chaque règle de permission comme un argument à part', () => {
    const args = buildClaudeArgs(
      {
        ...base,
        tools: ['Read', 'Bash'],
        allowedTools: ['Read', 'Bash(npm run build:*)'],
        disallowedTools: ['Bash(git push:*)'],
        agent: 'reviewer'
      },
      true
    );
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    const allowed = args.indexOf('--allowedTools');
    expect(args.slice(allowed + 1, allowed + 3)).toEqual(['Read', 'Bash(npm run build:*)']);
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash(git push:*)');
    expect(args[args.indexOf('--agent') + 1]).toBe('reviewer');
  });
});

describe('parseStreamLine', () => {
  const line = (event: object) => JSON.stringify(event);

  it("garde le texte et les appels d'outils de l'agent", () => {
    const events = parseStreamLine(
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'secret' },
            { type: 'text', text: 'Je lance le build.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'npm run build' } },
            { type: 'tool_use', name: 'StructuredOutput', input: {} }
          ]
        }
      })
    );
    expect(events.map(formatStreamEvent)).toEqual(['Je lance le build.', '→ Bash : npm run build']);
  });

  it("signale les erreurs d'outils et ignore le reste", () => {
    const refused = line({
      type: 'user',
      message: { content: [{ type: 'tool_result', is_error: true, content: 'This command requires approval' }] }
    });
    expect(parseStreamLine(refused)).toEqual([{ kind: 'toolError', detail: 'This command requires approval' }]);
    const schema = line({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', is_error: true, content: "Output does not match required schema: root: must have required property 'lint'" }
        ]
      }
    });
    expect(parseStreamLine(schema).map(formatStreamEvent)).toEqual([
      "↻ Sortie hors schéma, Claude la corrige : root: must have required property 'lint'"
    ]);
    expect(parseStreamLine(line({ type: 'rate_limit_event' }))).toEqual([]);
    expect(parseStreamLine('pas du json')).toEqual([]);
  });

  it('lit la session et le résultat', () => {
    expect(parseStreamLine(line({ type: 'system', subtype: 'init', session_id: 's1', model: 'sonnet' }))).toEqual([
      { kind: 'init', sessionId: 's1', model: 'sonnet' }
    ]);
    const [result] = parseStreamLine(
      line({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.5 })
    );
    expect(result && formatStreamEvent(result)).toBe('Terminé — success · 3 tours · 0.50 $');
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
      costUsd: 0.01,
      permissionDenials: []
    });
  });

  it('résume les appels refusés faute de permission', () => {
    const out = JSON.stringify({
      subtype: 'success',
      session_id: 's1',
      structured_output: {},
      permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'git push' } }]
    });
    expect(parseClaudeResult(out).permissionDenials).toEqual(['Bash : git push']);
  });

  it('remonte une erreur du CLI, avec ce que la session a coûté', () => {
    const out = JSON.stringify({ subtype: 'error_during_execution', is_error: true, session_id: 's1', result: '', total_cost_usd: 0.4 });
    expect(() => parseClaudeResult(out)).toThrow(ClaudeError);
    try {
      parseClaudeResult(out);
    } catch (err) {
      expect((err as ClaudeError).costUsd).toBe(0.4);
    }
  });

  it('dit clairement que le plafond de tours est atteint', () => {
    const out = JSON.stringify({ subtype: 'error_max_turns', is_error: true, session_id: 's1', num_turns: 41 });
    expect(() => parseClaudeResult(out)).toThrow('plafond de tours (41 tours)');
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

describe('subscriptionEnv', () => {
  it("retire ce qui ferait passer le CLI par l'API, et garde le reste", () => {
    const env = subscriptionEnv({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'sk-x',
      anthropic_auth_token: 't',
      CLAUDE_CODE_USE_BEDROCK: '1'
    });
    expect(env).toEqual({ PATH: '/bin' });
  });
});
