import { captureDraftSchema, createWebCaptureRequestSchema, defaultCaptureLimits, type CaptureDraft, type CaptureFile, type CaptureResource, type WebCaptureManifest } from '@pagelingo/document-contracts';
import { sha256, inspectImageResource } from '@pagelingo/web-capture';
import { finalizeCaptureTranslation } from './resource-manifest.js';
import type { ArchiveEntry, ArchiveDatabase } from './database.js';
import type { SiteBinding } from './binding.js';
export interface AcquiredResource { bytes: Uint8Array; mediaType: string }
export async function describeFile(id: string, path: string, role: CaptureFile['role'], mediaType: string, bytes: Uint8Array): Promise<CaptureFile> {
  return { id, path, role, mediaType, bytes: bytes.byteLength, sha256: await sha256(bytes) };
}
/** Every successfully acquired file is durable before another acquisition starts. */
export async function prepareCapture(entry: ArchiveEntry, binding: SiteBinding, db: ArchiveDatabase,
  acquire: (draft: CaptureDraft, resourceId: string, entry: ArchiveEntry) => Promise<AcquiredResource>, assertCurrent: () => Promise<void>): Promise<void> {
  const draft = captureDraftSchema.parse(entry.draft); await assertCurrent();
  let stored = await db.files(binding, entry.id);
  if (!stored.some(file => file.descriptor.id === 'html')) {
    const bytes = new TextEncoder().encode(draft.snapshot.html);
    const descriptor = await describeFile('html', 'source.html', 'html', 'text/html', bytes);
    await assertCurrent(); await db.putFile(binding, entry.id, descriptor, bytes);
  }
  for (const pending of draft.pendingResources) {
    if (entry.resources.some(resource => resource.id === pending.id)) continue;
    await assertCurrent(); stored = await db.files(binding, entry.id);
    const id = `resource-${draft.pendingResources.indexOf(pending)}`;
    let resource: CaptureResource;
    try {
      let file = stored.find(file => file.descriptor.id === id);
      if (!file) {
        const acquired = await acquire(draft, pending.id, entry); await assertCurrent();
        const descriptor = await describeFile(id, `resources/${id}`, pending.role, acquired.mediaType, acquired.bytes);
        if (descriptor.bytes > defaultCaptureLimits.maxResourceBytes || stored.length >= defaultCaptureLimits.maxFiles - 1 || stored.reduce((n, f) => n + f.descriptor.bytes, 0) + descriptor.bytes > defaultCaptureLimits.maxTotalBytes) throw new Error('too-large');
        if (pending.role === 'image') await inspectImageResource(acquired.bytes, descriptor);
        await assertCurrent(); await db.putFile(binding, entry.id, descriptor, acquired.bytes);
        file = { partition: entry.partition, captureId: entry.id, descriptor, bytes: acquired.bytes };
      }
      resource = { ...pending, status: 'available', fileId: file.descriptor.id };
    } catch (error) {
      await assertCurrent();
      const reason = error instanceof Error && ['blocked','too-large','timeout','invalid','unsupported','not-loaded'].includes(error.message) ? error.message as 'blocked' : 'unavailable';
      resource = { ...pending, status: 'missing', reason };
      entry.warnings.push(`资源 ${pending.id} 缺失：${reason}`);
    }
    entry.resources.push(resource); await assertCurrent(); await db.put(binding, entry);
  }
  stored = await db.files(binding, entry.id);
  const candidate = await finalizeCaptureTranslation(draft, entry.resources, stored.map(file => file.descriptor));
  if (candidate && !stored.some(file => file.descriptor.id === 'translation')) {
    const bytes = new TextEncoder().encode(JSON.stringify(candidate));
    const descriptor = await describeFile('translation', 'translation.json', 'translation', 'application/json', bytes);
    await assertCurrent(); await db.putFile(binding, entry.id, descriptor, bytes); stored = await db.files(binding, entry.id);
  }
  const manifest: WebCaptureManifest = { schemaVersion: 'web-capture/1', captureId: entry.id,
    source: { url: draft.snapshot.sourceUrl, canonicalUrl: draft.canonicalUrl, kind: draft.kind, method: 'extension' }, metadata: draft.metadata,
    scope: draft.snapshot.scope, htmlFileId: 'html', files: stored.map(file => file.descriptor), resources: entry.resources,
    stylesheetFileIds: entry.resources.filter(resource => resource.role === 'css' && resource.status === 'available').map(resource => (resource as Extract<CaptureResource, { status: 'available' }>).fileId),
    // Server constructs authoritative preview files and Reader IR from these actual source bytes.
    snapshots: { previews: [], nodeLocations: {} }, existingTranslation: candidate ? { fileId: 'translation', sourceSnapshotSha256: candidate.sourceSnapshotSha256, sourceContentFingerprint: candidate.sourceContentFingerprint, targetLanguage: candidate.targetLanguage } : null };
  entry.request = createWebCaptureRequestSchema.parse({ manifest, translationIntent: 'none' });
  if (new TextEncoder().encode(JSON.stringify(entry.request)).byteLength > defaultCaptureLimits.maxIrBytes) throw new Error('采集请求超过限制。');
  await assertCurrent(); await db.put(binding, entry);
}
