import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { preflight } from './site-s4-inputs.mjs';
try {
  const args = process.argv.slice(2), options = {};
  const usage = 'Usage: npm run check:site:s4 -- --samples <declaration.json> --output <new-dir>';
  for (let i = 0; i < args.length; i += 2) {
    assert(['--samples', '--output'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--') && !options[args[i]], usage);
    options[args[i]] = args[i + 1];
  }
  assert(options['--samples'] && options['--output'], usage);
  const plan = await preflight(options['--samples'], options['--output'], { requireUpgradeBaseline: true });
  await mkdir(plan.output, { mode: 0o700 });
  await writeFile(join(plan.output, 'admission.json'), JSON.stringify(plan, null, 2) + '\n');
  // Deliberately no ambient database URL, dotenv, provider key or Compose config.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|TMPDIR|LANG|TZ|DISPLAY|XDG_RUNTIME_DIR|PLAYWRIGHT_BROWSERS_PATH)$/.test(key)));
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/site/site-s4-runner.mjs', join(plan.output, 'admission.json')], { env, stdio: 'inherit', detached: true });
  let interrupted;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted ??= signal; try { process.kill(-child.pid, signal); } catch {} });
  process.exitCode = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolveExit(code ?? (signal === 'SIGINT' ? 130 : 143))); });
  if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
} catch (error) { console.error(error.message); process.exitCode = 1; }
