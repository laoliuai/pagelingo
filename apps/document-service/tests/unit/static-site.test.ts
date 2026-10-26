import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerStaticSite } from '../../src/static-site.js';
import type { RuntimeConfig } from '../../src/config.js';

it('only caches built assets immutably even when the deployment parent is named assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pgl-static-'));
  const webDir = join(directory, 'assets', 'web');
  const app = Fastify();
  try {
    await mkdir(join(webDir, 'assets'), { recursive: true });
    await writeFile(join(webDir, 'index.html'), '<html>shell</html>');
    await writeFile(join(webDir, 'assets', 'app-hash.js'), 'export {};');
    const config: RuntimeConfig = {
      mode: 'production',
      publicOrigin: 'https://example.com',
      host: '127.0.0.1',
      port: 4320,
      dataDir: directory,
      databaseUrl: 'postgresql://unused/test',
      webDir,
      keyring: { activeKeyId: 'test', keys: { test: new Uint8Array(32) } },
      maxPdfBytes: 1024,
    };
    await registerStaticSite(app, config);
    const shell = await app.inject('/index.html');
    expect(shell.statusCode).toBe(200);
    expect(shell.headers['cache-control']).toBe('no-store');
    expect(shell.headers['content-security-policy']).toContain('upgrade-insecure-requests');
    const asset = await app.inject('/assets/app-hash.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
