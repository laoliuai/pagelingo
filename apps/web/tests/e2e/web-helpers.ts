import { expect, type Page } from '@playwright/test';
import type { WebCaptureManifest } from '@pagelingo/document-contracts';
import { capture } from '../../../document-service/tests/helpers/web-capture';
import { origin } from './library-helpers';
export async function archive(page: Page, html = '<article><h1>离线阅读</h1><p>这是已经归档的中文原文，可以直接阅读。</p><p>第二个段落保留源节点，供快照定位。</p></article>') {
  return uploadArchive(page, capture(html));
}
export async function uploadArchive(page: Page, fixture: { manifest: WebCaptureManifest; body: Buffer; translation?: Buffer; image?: Buffer }, targetDocumentId?: string) {
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const headers = { Origin: origin, 'X-CSRF-Token': session.csrfToken };
  const created = await page.request.post('/api/v1/captures', { headers: { ...headers, 'Idempotency-Key': fixture.manifest.captureId }, data: { manifest: fixture.manifest, ...(targetDocumentId ? { targetDocumentId } : {}), translationIntent: 'none' } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  for (const file of fixture.manifest.files) { const bytes = file.id === 'html' ? fixture.body : file.id === 'translation' ? fixture.translation : fixture.image; if (!bytes) throw Error('Missing fixture bytes'); expect((await page.request.put(`/api/v1/captures/${id}/files/${file.id}`, { headers: { ...headers, 'Content-Type': file.mediaType }, data: bytes })).status()).toBe(200); }
  const result = await page.request.post(`/api/v1/captures/${id}/commit`, { headers, data: {} });
  expect(result.status(), await result.text()).toBe(200);
  return result.json();
}
