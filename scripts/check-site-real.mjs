// Saves real public pages through an isolated copy of the site and photographs the result.
// Uses the live network and makes no model request. Not part of `check`: results depend on the sites.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { readLlmConfiguration } from './llm-config.mjs';
import { createCompose } from './site-ops.mjs';

const DEFAULT_URLS = [
  'https://lilianweng.github.io/posts/2021-07-11-diffusion-models/',
  'https://lilianweng.github.io/posts/2023-06-23-agent/',
  'https://jalammar.github.io/illustrated-transformer/',
  'https://karpathy.github.io/2015/05/21/rnn-effectiveness/',
  'https://www.anthropic.com/engineering/building-effective-agents',
  'https://martinfowler.com/articles/microservices.html',
  'https://distill.pub/2021/gnn-intro/',
  'https://kubernetes.io/docs/concepts/overview/',
  'https://github.com/karpathy/nanoGPT',
  'https://arxiv.org/abs/1706.03762',
  'https://arxiv.org/abs/2312.00752v2',
  'https://arxiv.org/abs/2005.14165',
];
const JOB_TIMEOUT_MS = 8 * 60_000;
const TRANSLATION_TIMEOUT_MS = 90 * 60_000;
const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' }, verbose: { type: 'boolean', default: false }, 'allow-fake-ip': { type: 'boolean', default: false }, translate: { type: 'string' } } });
if (!values.output) throw new Error('Usage: check-site-real --output <new-directory> [url...]');
const output = resolve(values.output);
await mkdir(output);
const urls = positionals.length ? positionals : DEFAULT_URLS;

const directory = await mkdtemp(join(tmpdir(), 'pgl-real-'));
const freePort = () => new Promise((done, fail) => {
  const server = createServer();
  server.once('error', fail);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); });
});
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const envFile = join(directory, '.env');
await writeFile(envFile, [
  `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`, `PAGELINGO_SITE_PORT=${port}`, `PAGELINGO_SITE_ORIGIN=${origin}`,
  `PAGELINGO_ALLOW_FAKE_IP=${values['allow-fake-ip'] ? 1 : 0}`,
  'PAGELINGO_MASTER_KEY_ID=real', `PAGELINGO_MASTER_KEYS_JSON='${JSON.stringify({ real: randomBytes(32).toString('base64') })}'`, '',
].join('\n'), { mode: 0o600 });
const project = `pgl-real-${randomUUID().slice(0, 8)}`;
const compose = createCompose({ project, envFile, mode: 'local', verbose: values.verbose });

let actor;
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { Origin: origin, ...(actor ? { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrfToken } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.status === 204 ? undefined : response.json();
}
async function finished(jobId, timeoutMs = JOB_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await api(`/api/v1/web-jobs/${jobId}`);
    if (!['queued', 'running'].includes(job.status)) return job;
    await delay(1000);
  }
  return { status: 'timed-out' };
}
async function describe(document, job) {
  const report = { title: document.title, kind: document.kind, url: document.url, job: job.status, error: job.errorCode ?? null, save: document.saveStatus };
  if (!document.reader || document.kind === 'pdf' || 'assetId' in (document.source ?? {})) return report;
  const reader = await api(`/api/v1/documents/${document.id}/web-reader`);
  const manifest = await api(`/api/v1/documents/${document.id}/web-snapshots/${reader.source.sourceVersionId}/manifest`);
  const images = manifest.resources.filter(resource => resource.role === 'image');
  const missing = images.filter(resource => resource.status === 'missing');
  return {
    ...report,
    author: manifest.metadata.author,
    complete: manifest.scope.completeWithinScope,
    blocks: Object.keys(reader.index.blockLocations).length,
    images: images.length,
    imagesSaved: images.length - missing.length,
    imagesMissing: Object.fromEntries(Object.entries(Object.groupBy(missing, resource => resource.reason)).map(([reason, items]) => [reason, items.length])),
    warnings: reader.warnings?.length ?? 0,
  };
}

const inlineText = content => content.map(item => item.type === 'text' ? item.text : item.type === 'protected' ? (item.kind === 'math' ? `$${item.source}$` : item.source) : inlineText(item.children)).join('');
/** Real model, real worker, real outbound path. Only runs with --translate because it costs money. */
async function translateDocument(id) {
  const { baseUrl, model, apiKey, responseFormat } = readLlmConfiguration();
  const { revision, hasApiKey: _hasKey, ...settings } = await api('/api/v1/settings/provider');
  const thinkingMode = new URL(baseUrl).hostname === 'api.deepseek.com' ? 'disabled' : settings.thinkingMode;
  await api('/api/v1/settings/provider', { method: 'PUT', body: { expectedRevision: revision, settings: { ...settings, baseUrl, model, thinkingMode, ...(responseFormat ? { responseFormat } : {}) }, key: { action: 'replace', value: apiKey } } });
  const descriptor = await api(`/api/v1/documents/${id}/web-reader`);
  const profile = await api('/api/v1/settings/provider');
  const glossary = await api('/api/v1/settings/glossary');
  const started = Date.now();
  const created = await api(`/api/v1/documents/${id}/web-jobs`, { method: 'POST', body: { sourceVersionId: descriptor.source.sourceVersionId, parseId: descriptor.parseId, profileRevision: profile.revision, glossaryRevision: glossary.revision } });
  let job = created;
  const deadline = Date.now() + TRANSLATION_TIMEOUT_MS;
  while (['queued', 'running'].includes(job.status) && Date.now() < deadline) {
    await delay(5000);
    job = await api(`/api/v1/web-jobs/${created.id}`);
  }
  const report = { status: job.status, error: job.errorCode, units: `${job.completedUnits}/${job.totalUnits}`, minutes: Math.round((Date.now() - started) / 6000) / 10, warnings: job.warnings };
  console.log(JSON.stringify(report));
  const reader = await api(`/api/v1/documents/${id}/web-reader${job.readerVersionId ? `?versionId=${job.readerVersionId}` : ''}`);
  const lines = [`# ${reader.source.sourceVersionId}`, '', JSON.stringify(report), ''];
  for (const { id: chunkId } of reader.index.chunks) {
    const chunk = await api(`/api/v1/documents/${id}/web-reader/versions/${reader.versionId}/chunks/${chunkId}`);
    for (const block of chunk.blocks) {
      if (block.source.type !== 'text' || chunk.contextBlockIds.includes(block.source.id)) continue;
      lines.push(`EN: ${inlineText(block.source.value.content).replace(/\s+/g, ' ').trim()}`, `ZH: ${block.translation ? inlineText(block.translation.content).replace(/\s+/g, ' ').trim() : `(${block.sourceOnlyReason})`}`, '');
    }
  }
  await writeFile(join(output, 'translation.md'), lines.join('\n'));
  return { ...report, versionId: reader.versionId };
}

const results = [];
let translated;
let browser;
try {
  await compose.run(['config', '--quiet']);
  await compose.run(['build', 'app']);
  await compose.run(['up', '--detach', '--wait']);
  const password = randomBytes(24).toString('hex');
  await compose.run(['exec', '-T', 'app', 'node', 'apps/document-service/dist/cli/bootstrap-admin.js', '--username', 'realreader', '--password-stdin'], { input: `${password}\n` });
  const login = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'realreader', password }) });
  actor = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] };

  const seen = new Set();
  for (const url of urls) {
    const saved = await api('/api/v1/documents/links', { method: 'POST', body: { url, translationIntent: 'none' }, headers: { 'Idempotency-Key': randomUUID() } });
    const job = saved.jobId ? await finished(saved.jobId) : { status: 'no-job' };
    results.push(await describe(await api(`/api/v1/documents/${saved.documentId}`), job));
    seen.add(saved.documentId);
    // A paper may have added its HTML reading version as a second document.
    const relations = await api(`/api/v1/documents/${saved.documentId}/relations`);
    for (const relation of relations.items) {
      const id = relation.fromDocumentId === saved.documentId ? relation.toDocumentId : relation.fromDocumentId;
      if (seen.has(id)) continue;
      seen.add(id);
      let reading = await api(`/api/v1/documents/${id}`);
      const jobs = await api(`/api/v1/documents/${id}/web-jobs`);
      const readingJob = jobs.items[0] ? await finished(jobs.items[0].id) : { status: 'no-job' };
      reading = await api(`/api/v1/documents/${id}`);
      results.push(await describe(reading, readingJob));
    }
    console.log(JSON.stringify(results.at(-1)));
  }

  if (values.translate) {
    const library = await api(`/api/v1/library?${new URLSearchParams({ q: '', pageSize: '100' })}`);
    const document = library.items.map(item => item.document).find(item => item.url === values.translate);
    if (!document) throw new Error(`No saved document has the URL ${values.translate}`);
    translated = { id: document.id, ...await translateDocument(document.id) };
  }
  browser = await chromium.launch();
  const [name, value] = actor.cookie.split(/=(.*)/s);
  for (const [viewport, size] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport: size, colorScheme: 'light' });
    await context.addCookies([{ name, value, url: origin }]);
    const page = await context.newPage();
    for (const [index, id] of [...seen].entries()) {
      await page.goto(`${origin}/library/${id}`);
      const body = page.getByLabel('正文，可独立滚动');
      await body.first().waitFor({ timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(output, `${String(index).padStart(2, '0')}-${viewport}-top.png`) });
      if (await body.count()) {
        await body.first().evaluate(element => { element.scrollTop = element.scrollHeight * 0.35; });
        await page.waitForTimeout(1500);
        await page.screenshot({ path: join(output, `${String(index).padStart(2, '0')}-${viewport}-middle.png`) });
      }
    }
    if (translated) {
      await page.goto(`${origin}/library/${translated.id}`);
      const body = page.getByLabel('正文，可独立滚动').first();
      await body.waitFor({ timeout: 20_000 });
      await page.getByLabel('正文模式', { exact: true }).selectOption('bilingual');
      for (const position of [0.1, 0.4]) {
        await body.evaluate((element, value) => { element.scrollTop = element.scrollHeight * value; }, position);
        await page.waitForTimeout(1500);
        await page.screenshot({ path: join(output, `translated-${viewport}-${position}.png`) });
      }
    }
    await context.close();
  }

  const usage = await new Promise(done => {
    import('node:child_process').then(({ execFile }) => execFile('docker', ['stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}}'], (_error, stdout) => done(stdout.split('\n').filter(line => line.startsWith(project)))));
  });
  await writeFile(join(output, 'report.json'), `${JSON.stringify({ urls, results, translated, memory: usage }, null, 2)}\n`);
  console.table(results.map(({ title, kind, job, error, save, complete, blocks, images, imagesSaved }) => ({ title: title.slice(0, 40), kind, job, error, save, complete, blocks, images, imagesSaved })));
  console.log(usage.join('\n'));
} finally {
  await browser?.close();
  await compose.run(['down', '--volumes', '--remove-orphans', '--rmi', 'local']).catch(() => {
    console.error(`Failed to clean isolated project ${project}`);
    process.exitCode ||= 1;
  });
  await rm(directory, { recursive: true, force: true });
}
