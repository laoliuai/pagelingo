import { randomUUID } from 'node:crypto';
import type { ReaderIR, ReaderTranslation } from '@pagelingo/document-contracts';
import { toTranslationDocument, validateReaderTranslation } from '@pagelingo/document-renderer';
import { contentHash, planUnits, PROMPT_VERSION, PROTECTION_VERSION, type TranslationCheckpoint } from '@pagelingo/translation-core';
import type { LocalTranslationJob } from './translation-types.js';

export async function translationSnapshot(ir: ReaderIR, job: LocalTranslationJob, checkpoint?: TranslationCheckpoint, cancelled = false): Promise<ReaderTranslation> {
  const document = toTranslationDocument(ir, job.selectionBlockIds, job.sourceLanguage ?? undefined);
  const plan = planUnits(document, job.targetLanguage, job.profile, job.budget, job);
  const selected = new Map(job.selectionBlockIds.map((id, index) => [id, index]));
  const units: ReaderTranslation['units'] = plan.units.map(unit => {
    const blockId = job.selectionBlockIds[unit.blockIndex];
    const saved = checkpoint?.units.find(saved => saved.id === unit.id);
    const identity = { id: unit.id, blockId, part: unit.part };
    if (checkpoint?.blocks[String(unit.blockIndex)]) return { ...identity, status: 'covered-by-block' };
    if (saved?.status === 'completed' && saved.text) return { ...identity, status: 'completed', rawText: saved.text };
    return { ...identity, status: cancelled ? 'cancelled' : saved?.status === 'failed' ? 'failed' : 'pending' };
  });
  const blocks: ReaderTranslation['blocks'] = ir.blocks.filter(block => block.type === 'text').map(block => {
    const index = selected.get(block.id);
    if (index === undefined) return { blockId: block.id, status: 'source-only', reason: block.language.language === 'zh' || block.language.reason === 'no-language' ? 'language-not-required' : 'manual-choice' };
    const full = checkpoint?.blocks[String(index)];
    if (full) return { blockId: block.id, status: 'translated', rawText: full.text };
    const blockUnits = units.filter(unit => unit.blockId === block.id);
    const reason = !blockUnits.length || blockUnits.some(unit => unit.status === 'failed') ? 'failed' : cancelled ? 'cancelled' : 'pending';
    return { blockId: block.id, status: 'source-only', reason };
  });
  const translated = blocks.filter(block => block.status === 'translated').length;
  const remaining = blocks.filter(block => block.status === 'source-only' && block.reason !== 'language-not-required');
  const status = !remaining.length ? translated ? 'completed' : 'not-required' : translated ? 'partial'
    : remaining.some(block => block.status === 'source-only' && ['pending', 'manual-choice'].includes(block.reason)) ? 'pending'
      : cancelled && remaining.some(block => block.status === 'source-only' && block.reason === 'cancelled') ? 'cancelled' : 'failed';
  const metrics = checkpoint?.metrics;
  const snapshot: ReaderTranslation = {
    schemaVersion: 'reader-translation/1', id: randomUUID(), jobId: job.jobId,
    sourceSha256: job.sourceSha256, parseId: job.parseId, readerIrSha256: job.readerIrSha256,
    sdkVersion: '0.4.0', promptVersion: PROMPT_VERSION, protectionVersion: PROTECTION_VERSION,
    sourceLanguage: job.sourceLanguage, targetLanguage: job.targetLanguage, profile: job.profile,
    budget: job.budget, glossary: job.glossary, glossaryDomain: job.glossaryDomain,
    glossarySha256: await contentHash(job.glossary), selectionBlockIds: job.selectionBlockIds,
    provider: job.provider, generationKind: translated ? job.generationKind : 'none',
    metrics: { requests: metrics?.requests ?? 0, retries: metrics?.retries ?? 0, cacheHits: metrics?.cacheHits ?? 0,
      promptTokens: metrics?.promptTokens ?? 0, completionTokens: metrics?.completionTokens ?? 0, totalTokens: metrics?.totalTokens ?? 0,
      usageRequests: metrics?.usageRequests ?? 0, startedAt: metrics?.startedAt ?? Date.now(), elapsedMs: metrics?.elapsedMs ?? 0,
      ...(metrics?.firstResultMs !== undefined ? { firstResultMs: metrics.firstResultMs } : {}),
    }, blocks, units, status,
  };
  validateReaderTranslation(ir, snapshot);
  return snapshot;
}
