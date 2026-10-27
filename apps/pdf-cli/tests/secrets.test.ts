import { expect, test, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ProviderError } from '@pagelingo/translation-core';
import { main } from '../src/cli.js';
import { resolveProviderConfig } from '../src/safe-config.js';
import { translateRun } from '../src/translate.js';
import { echo, english, providerConfig, readyRun } from './translation-fixture.js';
const secret = 'FAKE_PAGELINGO_TASK5_NEVER_PERSIST_7832';
async function scan(root: string): Promise<string> {
  let text = '';
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    text += entry.isDirectory() ? await scan(path) : await readFile(path, 'utf8');
  }
  return text;
}
test('provider configuration rejects embedded credentials and never accepts raw-key CLI options', async () => {
  for (const baseUrl of [`https://user:${secret}@example.com/v1`, `https://example.com/v1?key=${secret}`, 'https://example.com/v1#secret'])
    expect(() => resolveProviderConfig({ ...providerConfig, baseUrl })).toThrow('PROVIDER_CONFIG_INVALID');
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    expect(await main(['translate', '--run-dir', '/unused', '--api-key', secret])).toBe(1);
    expect(stderr.mock.calls.flat().join('')).not.toContain(secret);
  } finally { stderr.mockRestore(); }
});
test('unique fake env key and raw provider exceptions never enter checkpoints, caches, snapshots or CLI logs', async () => {
  process.env.PAGELINGO_TASK5_FAKE_KEY = secret;
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const resolved = resolveProviderConfig({ ...providerConfig, apiKeyEnv: 'PAGELINGO_TASK5_FAKE_KEY' });
    expect(resolved.apiKey).toBe(secret);
    for (const fail of [false, true]) {
      const f = await readyRun(`<p>${english}</p>`);
      const result = await translateRun({ runDir: f.runDir, selection: 'all', provider: { ...providerConfig, apiKeyEnv: 'PAGELINGO_TASK5_FAKE_KEY' }, resume: false, newJob: false }, {
        generationKind: 'mock', provider: { generate: async request => {
          if (fail) throw new ProviderError('http', `${secret} Authorization headers https://private/`, 401);
          return echo(request);
        } },
      });
      expect(result.snapshot.status).toBe(fail ? 'failed' : 'completed');
      expect(await scan(f.runDir)).not.toContain(secret);
      expect(await scan(join(f.runDir, 'translation'))).not.toContain('https://private/');
    }
    expect(log.mock.calls.flat().join('')).not.toContain(secret);
  } finally { delete process.env.PAGELINGO_TASK5_FAKE_KEY; log.mockRestore(); }
});

test('config rejects unsafe remote HTTP and unknown budget credentials before creating durable job metadata', async () => {
  expect(() => resolveProviderConfig({ ...providerConfig, baseUrl: 'http://remote.example/v1' })).toThrow('PROVIDER_CONFIG_INVALID');
  const f = await readyRun(`<p>${english}</p>`);
  await expect(translateRun({ runDir: f.runDir, selection: 'all', provider: providerConfig, resume: false, newJob: false,
    budget: { apiKey: secret } as never,
  }, { generationKind: 'mock', provider: { generate: async request => echo(request) } })).rejects.toThrow('TRANSLATION_OPTIONS_INVALID');
  expect(await scan(f.runDir)).not.toContain(secret);
});

test('process CLI retains static usage and explicit KaTeX preparation guidance while unknown errors remain sanitized', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const f = await readyRun();
  try {
    expect(await main([])).toBe(1);
    expect(stderr.mock.calls.flat().join('')).toContain('Usage: pagelingo-pdf');
    stderr.mockClear();
    expect(await main(['--source', f.sourcePath, '--run-dir', join(f.root, 'unprepared-run'), '--p0-run', f.run, '--katex', join(f.root, 'absent-katex')])).toBe(1);
    expect(stderr.mock.calls.flat().join('')).toContain('prepare-preview-renderer.py --output');
    stderr.mockClear();
    expect(await main(['translate', '--unknown', secret])).toBe(1);
    expect(stderr.mock.calls.flat().join('')).toBe('PDF_CLI_FAILED\n');
  } finally { stderr.mockRestore(); }
});

test('public SDK HTTP transport uses only named env key and its mock response still produces a disclosed mock snapshot', async () => {
  const { createServer } = await import('node:http');
  const { createLocalProvider } = await import('../src/safe-config.js');
  const { pythonEnvironment } = await import('../src/python-runner.js');
  const f = await readyRun(`<p>${english}</p>`);
  process.env.PAGELINGO_TASK5_FAKE_KEY = secret;
  let authorization: string | undefined;
  let endpoint: string | undefined;
  const server = createServer(async (request, response) => {
    authorization = request.headers.authorization; endpoint = request.url;
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const data = JSON.parse(JSON.parse(body).messages[1].content);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: data.blocks.map((b: { id: string; protectedText: string }) => ({ id: b.id, text: b.protectedText })) }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const config = { ...providerConfig, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'PAGELINGO_TASK5_FAKE_KEY' };
    const resolved = resolveProviderConfig(config);
    const result = await translateRun({ runDir: f.runDir, selection: 'all', provider: config, resume: false, newJob: false }, {
      provider: createLocalProvider(resolved, 8192), generationKind: 'mock',
    });
    expect(result.snapshot.status).toBe('completed');
    expect(result.snapshot.generationKind).toBe('mock');
    expect(result.snapshot.metrics.totalTokens).toBe(15);
    expect(endpoint).toBe('/v1/chat/completions');
    expect(authorization).toBe(`Bearer ${secret}`);
    expect(JSON.stringify(pythonEnvironment('/owned/python', '/owned/repo'))).not.toContain(secret);
    expect(await scan(f.runDir)).not.toContain(secret);
  } finally {
    delete process.env.PAGELINGO_TASK5_FAKE_KEY;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
test('translate subcommand writes a source-only durable snapshot without attempting a provider request', async () => {
  const f = await readyRun('<p>这是中文原文。</p>');
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    expect(await main(['translate', '--run-dir', f.runDir, '--base-url', 'http://localhost:1/v1', '--model', 'fixture-model'])).toBe(0);
    const result = JSON.parse(String(stdout.mock.calls[0][0]));
    expect(result.snapshot.status).toBe('not-required');
    expect(result.snapshot.metrics.requests).toBe(0);
    expect(result.snapshot.generationKind).toBe('none');
    expect(await readFile(join(f.runDir, result.snapshotPath), 'utf8')).toContain(result.snapshot.id);
  } finally { stdout.mockRestore(); }
});
