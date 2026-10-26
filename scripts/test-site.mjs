import { spawnSync } from 'node:child_process';
const env = { ...process.env };
delete env.NO_COLOR;
for (const args of [
  ['run', 'build:site'],
  ['run', 'test:e2e', '--workspace', '@pagelingo/web', '--', ...process.argv.slice(2)],
]) {
  const result = spawnSync('npm', args, { stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
