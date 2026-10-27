import { expect, it } from 'vitest';
import { PROMPT_VERSION, PROTECTION_VERSION } from '@pagelingo/translation-core';
import { webCaptureTranslationCandidateSchema } from '@pagelingo/document-contracts';
import { sha256 } from '@pagelingo/web-capture';
import { collectOriginalCapture } from '../../src/archive/collector';
import { extractBlocksSync } from '../../src/dom/extractor';
import { finalizeCaptureTranslation } from '../../src/archive/resource-manifest';
const captureId = 'a90c086e-f741-4e18-8192-cb6da71f523c';
const provenance = { sdkVersion: '0.4.0', promptVersion: PROMPT_VERSION, protectionVersion: PROTECTION_VERSION, sourceLanguage: 'en', targetLanguage: 'zh-CN' };
it('exports a genuine whole-block SDK result and finalizes its fingerprint only after resource resolution', async () => {
  document.body.innerHTML = '<article><p>This is the original source paragraph.</p><img src="https://example.org/image.png"></article>';
  const block = extractBlocksSync(document)[0]!;
  const draft = await collectOriginalCapture(document, { captureId, translations: { ...provenance, blocks: [{ source: block.block, rawText: '这是原文段落。' }] } });
  expect(draft.existingTranslation?.blocks).toHaveLength(1);
  expect(draft.existingTranslation?.blocks[0]?.source).toEqual(block.block);
  expect(draft.existingTranslation?.sourceSnapshotSha256).toBe(await sha256(new TextEncoder().encode(draft.snapshot.html)));
  expect(draft.existingTranslation?.sourceContentFingerprint).toBeNull();
  expect(webCaptureTranslationCandidateSchema.safeParse(draft.existingTranslation).success).toBe(false);
  const finalized = await finalizeCaptureTranslation(draft, draft.pendingResources.map(resource => ({ ...resource, status: 'missing', reason: 'unavailable' })), []);
  expect(webCaptureTranslationCandidateSchema.safeParse(finalized).success).toBe(true);
  expect(finalized?.blocks[0]?.rawText).toBe('这是原文段落。');
  const altered = structuredClone(draft); altered.snapshot.html += '<p>Changed</p>';
  await expect(finalizeCaptureTranslation(altered, [], [])).rejects.toThrow(/snapshot/i);
});
it('skips changed, ambiguous, formatted and old empty-section candidates with warnings while preserving source', async () => {
  document.body.innerHTML = '<article><p>Changed source.</p><p>Repeat source.</p><p>Repeat source.</p><p>With <strong>format</strong>.</p><p>Old plain source.</p></article>';
  const blocks = extractBlocksSync(document);
  const evidence = blocks.map(block => ({ source: block.block, rawText: block.input.protectedText }));
  evidence[0]!.source = { ...evidence[0]!.source, content: [{ type: 'text', text: 'Previous source.' }] };
  evidence.at(-1)!.source = { ...evidence.at(-1)!.source, sectionPath: [] };
  const draft = await collectOriginalCapture(document, { captureId, translations: { ...provenance, blocks: evidence } });
  expect(draft.existingTranslation).toBeNull();
  expect(draft.snapshot.html).toContain('Changed source.');
  expect(draft.snapshot.warnings.join(' ')).toMatch(/candidate.*(match|ambiguous)/i);
});
it('rejects invalid SDK markers instead of trusting rendered translation HTML', async () => {
  document.body.innerHTML = '<article><p>Original source paragraph.</p></article>';
  const source = extractBlocksSync(document)[0]!.block;
  const draft = await collectOriginalCapture(document, { captureId, translations: { ...provenance, blocks: [{ source, rawText: '⟦PL:a:999⟧' }] } });
  expect(draft.existingTranslation).toBeNull();
  expect(draft.snapshot.warnings.join(' ')).toMatch(/candidate/);
});
it('produces a candidate accepted by the actual server projector and import validator', async () => {
  const { projectWebReader, canonicalManifestBytes } = await import('@pagelingo/web-capture');
  const { defaultCaptureLimits, webCaptureManifestSchema } = await import('@pagelingo/document-contracts');
  const { importCandidates } = await import('../../../document-service/src/web-captures/candidates');
  document.body.innerHTML = '<article><p>This is a source paragraph with exact SDK evidence.</p></article>';
  const source = extractBlocksSync(document)[0]!.block;
  const draft = await collectOriginalCapture(document, { captureId, translations: { ...provenance, blocks: [{ source, rawText: '经过服务端验证的译文。' }] } });
  const candidate = await finalizeCaptureTranslation(draft, [], []);
  expect(candidate).not.toBeNull();
  const htmlBytes = new TextEncoder().encode(draft.snapshot.html);
  const candidateBytes = new TextEncoder().encode(JSON.stringify(candidate));
  const manifest = webCaptureManifestSchema.parse({ schemaVersion: 'web-capture/1', captureId,
    source: { url: draft.snapshot.sourceUrl, canonicalUrl: null, kind: draft.kind, method: 'extension' },
    metadata: draft.metadata, scope: draft.snapshot.scope, htmlFileId: 'html',
    files: [{ id: 'html', path: 'snapshot.html', bytes: htmlBytes.length, sha256: await sha256(htmlBytes), mediaType: 'text/html', role: 'html' },
      { id: 'candidate', path: 'candidate.json', bytes: candidateBytes.length, sha256: await sha256(candidateBytes), mediaType: 'application/json', role: 'translation' }],
    resources: [], stylesheetFileIds: [], snapshots: { previews: [], nodeLocations: {} },
    existingTranslation: { fileId: 'candidate', sourceSnapshotSha256: candidate!.sourceSnapshotSha256, sourceContentFingerprint: candidate!.sourceContentFingerprint, targetLanguage: candidate!.targetLanguage },
  });
  const ir = await projectWebReader(draft.snapshot, manifest, { manifestBytes: canonicalManifestBytes(manifest), assets: [] });
  const warnings: string[] = [];
  const imported = await importCandidates(ir, manifest, candidate!.sourceContentFingerprint, await sha256(new TextEncoder().encode(JSON.stringify(ir))), candidateBytes, warnings, defaultCaptureLimits);
  expect(imported?.generationKind).toBe('import');
  expect(imported?.status).toBe('completed');
  expect(imported?.blocks[0]?.rawText).toBe('经过服务端验证的译文。');
  expect(warnings).toEqual([]);
});
