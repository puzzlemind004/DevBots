/**
 * Lancement de processus externes (git, claude).
 *
 * `spawn` sans shell : les arguments passent tels quels, sans interprétation,
 * ce qui évite toute injection par un titre de ticket ou un nom de branche.
 */

import { spawn } from 'node:child_process';

export interface ExecOptions {
  cwd?: string;
  /** Abandon au-delà de ce délai, en millisecondes. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class ExecError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult
  ) {
    super(message);
    this.name = 'ExecError';
  }
}

export function exec(
  command: string,
  args: readonly string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true
    });

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

    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      action();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

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
