import { test, expect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultBundleLimits } from '@pagelingo/document-contracts';
import { createMemoryFileSource, createArchiveFileSource, readArchive, validateWebBundle, writeWebBundle } from '../../../../packages/document-bundle/src/index';
import { webFixture, hash } from '../../../../packages/document-bundle/tests/web-fixtures';

test('opens the validated streamed Web ZIP offline with real archived preview and image bytes', async ({ page }, info) => {
  const root = info.outputPath('exported'); await mkdir(root, { recursive: true });
  const fixture = await webFixture(true), options = { limits: defaultBundleLimits };
  const archivePath = join(root, 'reader.zip'), before = [...fixture.files].map(([path, body]) => [path, hash(body)]);
  const identity = await writeWebBundle(createMemoryFileSource(fixture.files, defaultBundleLimits), archivePath, options);
  await validateWebBundle(createArchiveFileSource(archivePath, defaultBundleLimits), options);
  const unpacked = join(root, 'unpacked');
  for await (const entry of readArchive(archivePath, defaultBundleLimits)) {
    const chunks = []; for await (const chunk of entry.content) chunks.push(chunk);
    const destination = join(unpacked, entry.path); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, Buffer.concat(chunks));
  }
  const outbound: string[] = [], errors: string[] = [];
  page.on('request', request => { if (/^https?:/.test(request.url())) outbound.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https?:/, route => route.abort());
  await page.goto(pathToFileURL(join(unpacked, 'render/index.html')).href);
  await expect(page.locator('#content')).toContainText('Original paragraph.');
  await page.getByRole('button', { name: '译文', exact: true }).click();
  await expect(page.locator('#content')).toContainText('保存的标题');
  await expect(page.locator('#content')).toContainText('待翻译，保留原文');
  await page.getByRole('button', { name: '双语', exact: true }).click();
  await expect(page.locator('#content')).toContainText('Saved title'); await expect(page.locator('#content')).toContainText('保存的标题');
  await page.getByRole('button', { name: '定位快照', exact: true }).first().click();
  const frame = page.frameLocator('iframe'); await expect(frame.locator('body')).toContainText('ARCHIVED PREVIEW ONLY');
  expect(await page.locator('iframe').getAttribute('sandbox')).toBe('');
  expect(await frame.locator('script,form,iframe').count()).toBe(0);
  await expect.poll(() => frame.locator('img').first().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(7);
  expect(outbound).toEqual([]); expect(errors).toEqual([]);
  expect([...fixture.files].map(([path, body]) => [path, hash(body)])).toEqual(before);
  expect(hash(await readFile(join(unpacked, 'manifest.json')))).toBe(identity.manifestSha256);
  await page.screenshot({ path: info.outputPath('validated-preview.png') });
  await writeFile(info.outputPath('identities.json'), JSON.stringify({ ...identity, archiveSha256: hash(await readFile(archivePath)), inputs: before, outbound, errors }, null, 2));
});
