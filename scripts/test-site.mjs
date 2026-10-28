import { spawnSync } from 'node:child_process';
const env = { ...process.env };
delete env.NO_COLOR;
const check = process.argv[2] === '--check';
for (const args of [
  ['run', 'build:site'],
  ...(check ? [['run', 'test:integration', '--workspace', '@pagelingo/document-service']] : []),
  ['run', 'test:e2e', '--workspace', '@pagelingo/web', '--', ...process.argv.slice(check ? 3 : 2)],
]) {
  const result = spawnSync('npm', args, { stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (check) {
  const result = spawnSync(process.execPath, ['--test', 'tests/site/dev.test.mjs', 'tests/site/pdf-reader.test.mjs', 'tests/site/web-capture.test.mjs', 'tests/site/owned-cleanup.test.mjs', 'tests/site/web-capture-signals.test.mjs'], { stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
