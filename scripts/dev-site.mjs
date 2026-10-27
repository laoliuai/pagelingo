import { readFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
const children = new Set();
let stopping = false;
let forced;
function stop(code, signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) { try { process.kill(-child.pid, signal); } catch {} }
  forced = setTimeout(() => {
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  }, 5000);
  forced.unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal === 'SIGINT' ? 130 : 143, signal));
try {
  const { values } = parseArgs({ options: { file: { type: 'string', default: '.env.site-dev.local' } } });
  const env = { ...process.env, ...parseEnv(await readFile(values.file, 'utf8')) };
  // Vite never loads the file itself. Expose only the local ports to its process.
  const webEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PAGELINGO_|DATABASE_URL$|POSTGRES_|VITE_)/.test(key)));
  webEnv.PAGELINGO_VITE_PORT = env.PAGELINGO_VITE_PORT ?? '5174';
  webEnv.PAGELINGO_SERVICE_PORT = env.PAGELINGO_SERVICE_PORT ?? '4320';
  function launch(program, args, runtimeEnv) {
    return new Promise((resolve, reject) => {
      const child = spawn(program, args, { env: runtimeEnv, stdio: 'inherit', detached: true });
      children.add(child);
      child.on('error', () => { children.delete(child); reject(new Error('Child process failed')); });
      child.on('exit', (code) => { children.delete(child); resolve(code ?? 1); });
    });
  }
  const built = await launch('npm', ['run', 'build:contracts'], webEnv);
  if (built !== 0 && !stopping) stop(built);
  if (!stopping) {
    const service = launch(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'apps/document-service/src/main.ts'], env);
    const worker = (async () => {
      // Service owns migrations; worker verifies the same schema before claiming.
      while (!stopping) {
        try { if ((await fetch(`http://127.0.0.1:${env.PAGELINGO_SERVICE_PORT ?? '4320'}/health/ready`, { signal: AbortSignal.timeout(500) })).ok) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (stopping) return 0;
      const entry = env.PAGELINGO_SITE_MODE === 'test' ? 'apps/document-service/tests/helpers/mock-worker-process.ts' : 'apps/document-service/src/worker/main.ts';
      return launch(process.execPath, ['--import', 'tsx', entry], env);
    })();
    const web = launch(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts', 'apps/web'], webEnv);
    await Promise.race([service, worker, web]).then(code => { if (!stopping) stop(code || 1); });
    await Promise.all([service, worker, web]);
  }
} catch {
  console.error('Site development startup failed; check runtime file and dependencies.');
  stop(1);
} finally { clearTimeout(forced); }
