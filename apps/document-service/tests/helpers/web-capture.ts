import { createHash, randomUUID } from 'node:crypto';
import type { WebCaptureManifest } from '@pagelingo/document-contracts';
export function capture(html = '<article><h1>测试标题</h1><p>这是可以直接阅读的中文原文，无需翻译。</p></article>') {
  const body = Buffer.from(html);
  const manifest: WebCaptureManifest = {
    schemaVersion: 'web-capture/1', captureId: randomUUID(),
    source: { url: 'https://example.com/article?utm_source=test#part', canonicalUrl: null, kind: 'article', method: 'extension' },
    metadata: { title: 'Test article', author: null, publishedAt: null, capturedAt: new Date().toISOString() },
    scope: { kind: 'article', rootNodeId: 'root', completeWithinScope: true, warnings: [] },
    htmlFileId: 'html', files: [{ id: 'html', path: 'source.html', role: 'html', mediaType: 'text/html', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }],
    resources: [], stylesheetFileIds: [], snapshots: { previews: [], nodeLocations: {} }, existingTranslation: null,
  };
  return { manifest, body };
}
export async function withCandidates(html: string, mismatch = false) {
  const { sanitizeNodeSnapshot, canonicalManifestBytes, sha256, captureContentFingerprint, projectWebReader } = await import('@pagelingo/web-capture/node');
  const { naturalText } = await import('@pagelingo/document-contracts');
  const { encodeBlock, PROMPT_VERSION, PROTECTION_VERSION } = await import('@pagelingo/translation-core');
  const draft = capture(html);
  const snapshot = sanitizeNodeSnapshot({ html, url: draft.manifest.source.url, scope: draft.manifest.scope });
  const value = capture(snapshot.html); value.manifest.source.url = snapshot.sourceUrl; value.manifest.scope = snapshot.scope;
  const fingerprint = await captureContentFingerprint(snapshot, [], value.manifest.files);
  const ir = await projectWebReader(snapshot, value.manifest, { manifestBytes: canonicalManifestBytes(value.manifest), assets: [] });
  const payload = {
    schemaVersion: 'web-capture-translation-candidate/1', sourceSnapshotSha256: await sha256(value.body), sourceContentFingerprint: fingerprint,
    sourceLanguage: 'en', targetLanguage: 'zh', sdkVersion: '0.4.0', promptVersion: PROMPT_VERSION, protectionVersion: PROTECTION_VERSION,
    blocks: await Promise.all(ir.blocks.filter(b => b.type === 'text').map(async b => ({ nodeId: b.sourceRefs[0].nodeId, sourceTextSha256: await sha256(new TextEncoder().encode(naturalText(b.value.content))), source: b.value, rawText: mismatch ? '[bad markers]' : encodeBlock(b.value).protectedText }))),
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  value.manifest.files.push({ id: 'translation', path: 'translation.json', role: 'translation', mediaType: 'application/json', bytes: bytes.length, sha256: await sha256(bytes) });
  value.manifest.existingTranslation = { fileId: 'translation', sourceSnapshotSha256: payload.sourceSnapshotSha256, sourceContentFingerprint: fingerprint, targetLanguage: 'zh' };
  return { ...value, translation: bytes };
}
