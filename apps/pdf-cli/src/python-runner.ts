import { spawn } from 'node:child_process';
import { dirname, delimiter } from 'node:path';
import type { PythonRequest, PythonResult } from './local-run.js';
/** Positive allowlist: inherited provider keys, Python hooks and application configuration never cross this boundary. */
export function pythonEnvironment(
  python: string,
  repo: string,
): Record<string, string> {
  return {
    PATH: `${dirname(python)}:${dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PYTHONNOUSERSITE: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONPATH: [
      `${repo}/services/document-parser/src`,
      `${repo}/benchmarks/pdf/tools`,
    ].join(delimiter),
  };
}
export async function runPython(request: PythonRequest): Promise<PythonResult> {
  request.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let tooLarge = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* process already exited */
        }
    };
    const abort = () => {
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    request.signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > 16 * 1024 * 1024) {
        tooLarge = true;
        kill('SIGTERM');
      } else stdout += chunk.toString();
    });
    // Drain stderr without persisting arbitrary worker output or secrets in checkpoints.
    child.stderr.on('data', () => {});
    const cleanup = () => {
      request.signal.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
    };
    child.on('error', () => {
      cleanup();
      reject(
        new Error(
          'Python process could not start; prepare the local parser environment',
        ),
      );
    });
    child.on('close', (code) => {
      cleanup();
      if (request.signal.aborted)
        reject(new Error('Local processing cancelled'));
      else if (tooLarge) reject(new Error('Python output exceeded limit'));
      else resolve({ exitCode: code ?? 1, stdout });
    });
  });
}
