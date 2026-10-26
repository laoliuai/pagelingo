import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// This runner never reads .env files or DATABASE_URL. Only an explicit test URL
// skips database-container provisioning; helpers still own only their random schemas.
// Full check:site also needs Docker Compose CLI for config validation (no daemon).
const image = 'postgres:17.11@sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe';
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
if (!args.length) throw new Error('Expected a command after --');
let ownedContainer;
let child;
let interrupted;
let forceShutdown;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = signal;
    if (child?.pid) {
      try { process.kill(-child.pid, signal); } catch {}
      forceShutdown ??= setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }, 5000);
      forceShutdown.unref();
    }
  });
}
function command(program, argv) {
  return new Promise((resolve, reject) => {
    const proc = spawn(program, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.on('error', reject);
    proc.on('exit', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${program} failed (exit ${code})`)));
  });
}
try {
  let url = process.env.PAGELINGO_TEST_DATABASE_URL;
  if (url !== undefined && !url.trim()) throw new Error('PAGELINGO_TEST_DATABASE_URL is empty');
  if (!url) {
    ownedContainer = `pgl-test-${randomUUID()}`;
    const password = randomBytes(24).toString('hex');
    await command('docker', ['run', '--detach', '--name', ownedContainer, '--publish', '127.0.0.1::5432', '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=pagelingo_test', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', image]);
    let ready = false;
    for (let attempt = 0; attempt < 120 && !interrupted; attempt++) {
      try {
        await command('docker', ['exec', ownedContainer, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'pagelingo_test']);
        ready = true;
        break;
      } catch { await delay(250); }
    }
    if (!ready && !interrupted) throw new Error('Test PostgreSQL did not become ready');
    if (!interrupted) {
      const mapping = await command('docker', ['port', ownedContainer, '5432/tcp']);
      const port = mapping.match(/^127\.0\.0\.1:(\d+)$/)?.[1];
      if (!port) throw new Error('Expected a loopback-only test PostgreSQL port');
      url = `postgresql://postgres:${password}@127.0.0.1:${port}/pagelingo_test`;
    }
  }
  if (!interrupted) {
    const result = await new Promise((resolve, reject) => {
      // A process group ensures npm's descendants receive shutdown signals too.
      child = spawn(args[0], args.slice(1), { stdio: 'inherit', detached: true, env: { ...process.env, PAGELINGO_TEST_DATABASE_URL: url } });
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    process.exitCode = result.code ?? (result.signal === 'SIGINT' ? 130 : 143);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(forceShutdown);
  if (ownedContainer) {
    try { await command('docker', ['rm', '--force', ownedContainer]); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
  if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
}
