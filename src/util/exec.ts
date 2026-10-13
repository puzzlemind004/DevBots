/**
 * Lancement de processus externes (git, claude).
 *
 * `spawn` sans shell : les arguments passent tels quels, sans interprétation,
 * ce qui évite toute injection par un titre de ticket ou un nom de branche.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolveCommand } from './resolveCommand.js';

export interface ExecOptions {
  cwd?: string;
  /** Abandon au-delà de ce délai, en millisecondes. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Texte écrit sur l'entrée standard, qui est ensuite fermée. */
  input?: string;
  /** Arrête le processus quand le signal est levé. */
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class ExecError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult,
    /** Vrai quand l'arrêt vient du signal d'annulation. */
    readonly cancelled = false
  ) {
    super(message);
    this.name = 'ExecError';
  }
}

/** Résolutions déjà faites : le PATH ne change pas pendant la vie de l'extension. */
const resolved = new Map<string, Promise<string>>();

export async function exec(
  command: string,
  args: readonly string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  let target = resolved.get(command);
  if (!target) {
    target = resolveCommand(command);
    resolved.set(command, target);
  }
  return run(await target, command, args, options);
}

function run(
  executable: string,
  command: string,
  args: readonly string[],
  options: ExecOptions
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ExecError(`« ${command} » annulé.`, { stdout: '', stderr: '', code: -1 }, true));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true
      });
    } catch (err) {
      // Windows refuse de lancer un `.cmd` sans shell (EINVAL), de façon synchrone.
      const message = err instanceof Error ? err.message : String(err);
      reject(
        new ExecError(`« ${command} » n'a pas pu démarrer : ${message}`, {
          stdout: '',
          stderr: '',
          code: -1
        })
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill();
          finish(() =>
            reject(
              new ExecError(`« ${command} » n'a pas répondu en ${options.timeoutMs} ms.`, {
                stdout,
                stderr,
                code: -1
              })
            )
          );
        }, options.timeoutMs)
      : undefined;

    const onAbort = (): void => {
      child.kill();
      finish(() =>
        reject(new ExecError(`« ${command} » annulé.`, { stdout, stderr, code: -1 }, true))
      );
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener('abort', onAbort);
      action();
    };

    if (options.input !== undefined) {
      child.stdin?.end(options.input, 'utf8');
    } else {
      child.stdin?.end();
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    // Un processus arrêté avant d'avoir lu son entrée lève EPIPE : sans intérêt.
    child.stdin?.on('error', () => undefined);

    child.on('error', (err) => {
      finish(() =>
        reject(
          new ExecError(`« ${command} » est introuvable ou n'a pas pu démarrer : ${err.message}`, {
            stdout,
            stderr,
            code: -1
          })
        )
      );
    });

    child.on('close', (code) => {
      const result: ExecResult = { stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? -1 };
      finish(() =>
        code === 0
          ? resolve(result)
          : reject(new ExecError(`« ${command} » a échoué (code ${code}) : ${result.stderr}`, result))
      );
    });
  });
}
