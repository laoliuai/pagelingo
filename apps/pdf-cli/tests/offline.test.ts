import { afterEach, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultBundleLimits, type DocumentBundleManifest } from '@pagelingo/document-contracts';
import { createDirectoryFileSource, validateBundle } from '@pagelingo/document-bundle';
import { exportBundle } from '../src/bundle.js';
import { readyRun } from './translation-fixture.js';
import { hash } from './fixtures/legacy-preview/create.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
it.each(['assets/offline-runtime.js', 'render/data/c_000001.js', 'assets/katex/katex.min.css'])(
  'rejects forged manifest hashes after tampering %s', async path => {
    const f = await readyRun(); roots.push(f.root);
    const outputDir = join(f.root, 'bundle');
    await exportBundle({ runDir: f.runDir, outputDir, archivePath: join(f.root, 'bundle.zip') });
    const bytes = Buffer.from(path.endsWith('.css') ? '@font-face{src:url(https://example.invalid/font.woff2)}' : 'alert("tampered")');
    await writeFile(join(outputDir, path), bytes);
    const manifest = JSON.parse(await readFile(join(outputDir, 'manifest.json'), 'utf8')) as DocumentBundleManifest;
    Object.assign(manifest.files.find(file => file.path === path)!, { bytes: bytes.length, sha256: hash(bytes) });
    await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest));
    await expect(validateBundle(createDirectoryFileSource(outputDir, defaultBundleLimits), { limits: defaultBundleLimits })).rejects.toThrow();
  },
);
