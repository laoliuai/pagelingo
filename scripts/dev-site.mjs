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
  const { values } = parseArgs({ options: { file: { type: 'string', default: '.env.local' } } });
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
    const service = launch(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', 'apps/document-service/src/main.ts'], env);
    const web = launch(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts', 'apps/web'], webEnv);
    await Promise.race([service, web]).then(code => { if (!stopping) stop(code || 1); });
    await Promise.all([service, web]);
  }
} catch {
  console.error('Site development startup failed; check runtime file and dependencies.');
  stop(1);
} finally { clearTimeout(forced); }
