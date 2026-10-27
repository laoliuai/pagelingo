import { randomUUID } from 'node:crypto';
import { ZipFile } from 'yazl';
import { planUnits } from '@pagelingo/translation-core';
import { toTranslationDocument } from '@pagelingo/document-renderer';
import { deriveParseId } from '@pagelingo/document-bundle';
import type { DocumentBundleManifest, ReaderIR, ReaderTranslation } from '@pagelingo/document-contracts';
import { fixture, hash, json, refresh } from '../../../../packages/document-bundle/tests/fixtures';
import { buildPdfFixture } from '../../../../tests/fixtures/pdf';
import { expect, type Page } from '@playwright/test';
import { origin } from './library-helpers';

export async function readingBundle(kind: 'pending' | 'chinese' | 'partial' | 'completed' = 'pending', corrupt = false, sourceSuffix = '') {
  const files = await fixture(kind === 'completed' ? 'pending' : kind);
  const ir: ReaderIR = JSON.parse(files.get('source-ir.json')!.toString());
  const translation: ReaderTranslation = JSON.parse(files.get('translation.json')!.toString());
  const manifest: DocumentBundleManifest = JSON.parse(files.get('manifest.json')!.toString());
  const pdf = Buffer.concat([Buffer.from(buildPdfFixture(4)), Buffer.from(sourceSuffix)]);
  files.set('source.pdf', pdf);
  Object.assign(ir.source, { sha256: hash(pdf), bytes: pdf.length });
  if (kind === 'partial') { ir.parse.status = 'partial'; ir.parse.coverage = 'partial'; }
  ir.parse.id = deriveParseId(ir.source.sha256, ir.parse.inputManifestSha256, ir.parse.projectorVersion, ir.parse.configSha256);
  Object.assign(translation, { id: randomUUID(), sourceSha256: ir.source.sha256, parseId: ir.parse.id });
  Object.assign(manifest, { packageId: randomUUID(), source: ir.source, parse: { ...manifest.parse, id: ir.parse.id } });
  if (kind === 'completed') {
    const plan = planUnits(toTranslationDocument(ir, translation.selectionBlockIds), translation.targetLanguage, translation.profile, translation.budget, translation);
    translation.blocks = plan.inputs.map(input => ({ blockId: input.id, status: 'translated', rawText: input.protectedText }));
    translation.units = translation.units.map(unit => ({ ...unit, status: 'covered-by-block' }));
    translation.status = 'completed'; translation.generationKind = 'mock';
  }
  manifest.translation = { ...manifest.translation, id: translation.id, status: translation.status, generationKind: translation.generationKind };
  files.set('source-ir.json', json(ir)); files.set('translation.json', json(translation)); files.set('manifest.json', json(manifest));
  refresh(files);
  if (corrupt) files.set('source.pdf', Buffer.from('wrong hash'));
  const zip = new ZipFile();
  for (const [path, bytes] of files) zip.addBuffer(bytes, path);
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', chunk => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
  zip.end();
  return { name: 'reading.zip', mimeType: 'application/zip', buffer: await done, pdf };
}
export async function selectBundle(page: Page, bundle: Awaited<ReturnType<typeof readingBundle>>) {
  await page.getByRole('button', { name: '导入阅读包', exact: true }).click();
  await page.getByLabel('阅读包 ZIP').setInputFiles(bundle);
}
export async function imports(page: Page) {
  return (await page.request.get('/api/v1/bundle-imports')).json();
}
export async function ingest(page: Page, bundle: Awaited<ReturnType<typeof readingBundle>>) {
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const headers = { Origin: origin, 'X-CSRF-Token': session.csrfToken };
  const created = await page.request.post('/api/v1/bundle-imports', { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: {} });
  expect(created.status()).toBe(201);
  const result = await page.request.put(`/api/v1/bundle-imports/${(await created.json()).id}/content`, { headers: { ...headers, 'Content-Type': 'application/zip' }, data: bundle.buffer });
  expect(result.status()).toBe(200);
  return result.json();
}
