import { randomUUID } from 'node:crypto';
import type { BundleFileSource } from '@pagelingo/document-bundle';
import { readerTranslationSchema, type ReaderIR, type ReaderTranslation } from '@pagelingo/document-contracts';
import { toTranslationDocument, validateReaderTranslation } from '@pagelingo/document-renderer';
import { sha256 } from './verified-input.js';
import { loadTranslationRun } from './translate.js';
import { LocalTranslationError } from './safe-config.js';
import { translationSnapshot } from './translation-snapshot.js';

export async function readExportBytes(source: BundleFileSource, path: string, limit: number): Promise<Buffer> {
  const parts: Uint8Array[] = []; let bytes = 0;
  for await (const part of source.read(path)) {
    bytes += part.byteLength;
    if (bytes > limit) throw new Error('EXPORT_INPUT_TOO_LARGE');
    parts.push(part);
  }
  return Buffer.concat(parts, bytes);
}

/** Select only a verified immutable snapshot, or construct an honest pending projection. */
export interface ExportSnapshot {
  translation: ReaderTranslation;
  original?: { path: string; sha256: string };
}
export async function exportTranslation(runDir: string, source: BundleFileSource, ir: ReaderIR, readerIrSha256: string, maxBytes: number): Promise<ExportSnapshot> {
  try {
    const local = await loadTranslationRun(runDir);
    const bytes = await readExportBytes(source, local.snapshotPath, maxBytes);
    if (sha256(bytes) !== local.snapshotSha256) throw new Error('EXPORT_TRANSLATION_CHANGED');
    const original = readerTranslationSchema.parse(JSON.parse(bytes.toString('utf8')));
    validateReaderTranslation(ir, original);
    // UUID is the only changed field. Preserve raw protected text and SDK replay bindings.
    return { translation: { ...original, id: randomUUID() }, original: { path: local.snapshotPath, sha256: local.snapshotSha256 } };
  } catch (error) {
    if (!(error instanceof LocalTranslationError) || error.code !== 'TRANSLATION_JOB_MISSING') throw error;
  }
  const selectionBlockIds = ir.blocks.filter(block => block.type === 'text' && block.language.language === 'en').map(block => block.id);
  const document = toTranslationDocument(ir, selectionBlockIds);
  const translation = await translationSnapshot(ir, {
    schemaVersion: 'pagelingo-local-translation-job/1', jobId: randomUUID(), configSha256: readerIrSha256,
    sourceSha256: ir.source.sha256, parseId: ir.parse.id, readerIrSha256,
    selection: 'auto', selectionBlockIds, sourceLanguage: document.sourceLanguage ?? null,
    targetLanguage: 'zh-CN', profile: 'academic',
    budget: { maxInputTokens: 8192, maxOutputTokens: 8192, contextWindowTokens: 32768, maxBatchBlocks: 4, reserveTokens: 512 },
    glossary: [], glossaryDomain: 'machine-learning', maxRetries: 2, backoffMs: 500,
    provider: { model: null, endpointFingerprint: null }, generationKind: 'model',
  });
  return { translation };
}
