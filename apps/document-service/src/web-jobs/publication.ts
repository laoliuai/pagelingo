import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { defaultCaptureLimits, providerSettingsSchema, glossaryRevisionSchema, webReaderIrSchema, type WebModelTranslation } from '@pagelingo/document-contracts';
import { buildWebReader, toWebTranslationDocument, validateWebTranslation } from '@pagelingo/document-renderer';
import { canonicalManifestBytes } from '@pagelingo/web-capture';
import { CheckpointConflictError, contentHash, planUnits, PROMPT_VERSION, PROTECTION_VERSION, type TranslationCheckpoint } from '@pagelingo/translation-core';
import type { Database } from '../db/database.js';
import type { ObjectStore } from '../storage/object-store.js';
import { lockObjectPublication } from '../documents/repository.js';
import { readWebAsset } from '../web-readers/assets.js';
import * as readers from '../web-readers/repository.js';
import { checkRetainedDependencies } from '../web-captures/retained-dependencies.js';
import { findWebJob, type WebJobRow } from './repository.js';
export interface PublicationDependencies { db: Database; store: ObjectStore; generationKind: 'model' | 'mock' }
export type PublicationGuard = (client: PoolClient) => Promise<void>;
export const publicationConflict = () => new CheckpointConflictError('Web publication is no longer current');

/** No key is needed to replay confirmed text; only immutable public configuration is loaded. */
export async function loadPublication(jobId: string, ownerId: string, deps: PublicationDependencies, guard: PublicationGuard) {
  const loaded = await deps.db.transaction(async client => {
    await guard(client);
    const job = await findWebJob(client, ownerId, jobId);
    if (!job || job.kind !== 'translate') throw publicationConflict();
    const source = await readers.findWebSource(client, ownerId, job.document_id, job.source_version_id!);
    const parse = await readers.findWebParse(client, ownerId, job.document_id, job.source_version_id!, job.parse_id!);
    const asset = parse && (await client.query<readers.WebAssetRow>('SELECT id,object_key,sha256,bytes,media_type FROM assets WHERE owner_id=$1 AND document_id=$2 AND id=$3', [ownerId,job.document_id,parse.ir_asset_id])).rows[0];
    const reader = (await client.query<readers.WebReaderVersionRow>('SELECT * FROM web_reader_versions WHERE owner_id=$1 AND document_id=$2 AND source_version_id=$3 AND parse_id=$4 ORDER BY created_at,id LIMIT 1', [ownerId,job.document_id,job.source_version_id,job.parse_id])).rows[0];
    if (!source || !parse || !asset || !reader || Number(asset.bytes)>defaultCaptureLimits.maxIrBytes) throw publicationConflict();
    const settings = providerSettingsSchema.parse((await client.query('SELECT settings FROM web_provider_revisions WHERE owner_id=$1 AND revision=$2', [ownerId,job.profile_revision])).rows[0]?.settings);
    const glossary = glossaryRevisionSchema.parse((await client.query('SELECT revision,entries FROM glossary_revisions WHERE owner_id=$1 AND revision=$2', [ownerId,job.glossary_revision])).rows[0]).entries;
    return { job, source, parse, asset, reader, settings, glossary };
  });
  const ir = webReaderIrSchema.parse(JSON.parse((await readWebAsset(deps.store, loaded.asset)).toString('utf8')));
  if (ir.parse.id !== loaded.job.parse_id || ir.source.manifestSha256 !== loaded.source.sha256 || loaded.asset.sha256 !== loaded.parse.ir_sha256) throw publicationConflict();
  const identity = { kind: 'translate', sourceVersionId: loaded.job.source_version_id, parseId: loaded.job.parse_id, readerIrSha256: loaded.parse.ir_sha256, profileRevision: loaded.job.profile_revision, glossaryRevision: loaded.job.glossary_revision, sourceLanguage: loaded.job.source_language, selectionBlockIds: loaded.job.selection_block_ids };
  if (createHash('sha256').update(canonicalManifestBytes(identity)).digest('hex') !== loaded.job.input_sha256) throw publicationConflict();
  const selection = loaded.job.selection_block_ids ?? ir.blocks.filter(b => b.type === 'text').map(b => b.id);
  const sourceLanguage = loaded.job.source_language ?? ir.metadata.language.sourceLanguage;
  const document = toWebTranslationDocument(ir, selection, sourceLanguage ?? undefined);
  const { maxInputTokens, maxOutputTokens, contextWindowTokens } = loaded.settings;
  const budget = { maxInputTokens, maxOutputTokens, contextWindowTokens, maxBatchBlocks: 4 };
  const plan = planUnits(document, 'zh', 'technical', budget, { glossary: loaded.glossary });
  return { ...loaded, ir, document, selection, sourceLanguage, budget, plan };
}
export type PublicationContext = Awaited<ReturnType<typeof loadPublication>>;

/** Adapter only: public SDK planning and renderer replay remain authoritative. */
export async function checkpointTranslation(context: PublicationContext, checkpoint: TranslationCheckpoint, terminal: boolean, generationKind: 'model' | 'mock'): Promise<WebModelTranslation> {
  const { ir, job, selection, glossary, budget, plan } = context;
  const selected = new Map(selection.map((id,index) => [id,index]));
  const cancelled = ['cancelled','paused-config'].includes(job.status);
  const units: WebModelTranslation['units'] = plan.units.map(unit => {
    const identity = { id: unit.id, blockId: selection[unit.blockIndex]!, part: unit.part };
    const saved = checkpoint.units.find(saved => saved.id === unit.id);
    if (checkpoint.blocks[String(unit.blockIndex)]) return { ...identity, status: 'covered-by-block' };
    if (saved?.status === 'completed' && saved.text) return { ...identity, status: 'completed', rawText: saved.text };
    return { ...identity, status: cancelled ? 'cancelled' : terminal || saved?.status === 'failed' ? 'failed' : 'pending' };
  });
  const blocks: WebModelTranslation['blocks'] = ir.blocks.filter(b => b.type === 'text').map(block => {
    const index = selected.get(block.id);
    if (index === undefined) return { blockId: block.id, status: 'source-only', reason: block.language.language === 'zh' || block.language.reason === 'no-language' ? 'language-not-required' : 'manual-choice' };
    const full = checkpoint.blocks[String(index)];
    if (full) return { blockId: block.id, status: 'translated', rawText: full.text };
    const ownUnits = units.filter(unit => unit.blockId === block.id);
    const reason = !ownUnits.length || ownUnits.some(u => u.status === 'failed') ? 'failed' : cancelled ? 'cancelled' : 'pending';
    return { blockId: block.id, status: 'source-only', reason };
  });
  const translated = blocks.filter(b => b.status === 'translated').length;
  const remaining = blocks.filter(b => b.status === 'source-only' && b.reason !== 'language-not-required');
  const status = !remaining.length ? 'completed' : translated ? 'partial' : cancelled ? 'cancelled' : terminal ? 'failed' : 'pending';
  const { storageWarning: _warning, ...metrics } = checkpoint.metrics;
  const artifact: WebModelTranslation = {
    schemaVersion: 'web-reader-translation/1', id: randomUUID(), jobId: job.id,
    sourceSha256: ir.source.manifestSha256, parseId: ir.parse.id, readerIrSha256: context.parse.ir_sha256,
    sdkVersion: '0.4.0', promptVersion: PROMPT_VERSION, protectionVersion: PROTECTION_VERSION,
    sourceLanguage: context.sourceLanguage, targetLanguage: 'zh', profile: 'technical', budget,
    glossary, glossaryDomain: 'machine-learning', glossarySha256: await contentHash(glossary), selectionBlockIds: selection,
    provider: { model: context.settings.model, endpointFingerprint: createHash('sha256').update(new URL(context.settings.baseUrl).href).digest('hex') },
    generationKind: translated ? generationKind : 'none', metrics, blocks, units, status,
  };
  validateWebTranslation(ir, artifact);
  return artifact;
}

/** Objects/renderer run outside transactions; marker, references and promotion commit together. */
export async function publishCheckpoint(context: PublicationContext, checkpoint: TranslationCheckpoint, milestone: number, deps: PublicationDependencies, guard: PublicationGuard): Promise<void> {
  const { job, source, parse, reader } = context;
  if (milestone < 4 && milestone <= job.publication_milestone) return;
  if (milestone === 4 && job.finalized_epoch === job.epoch) return;
  const translation = await checkpointTranslation(context, checkpoint, milestone === 4, deps.generationKind);
  const build = buildWebReader(context.ir, translation);
  const versionId = randomUUID();
  const values = [{ kind: 'translation', id: translation.id, value: translation }, { kind: 'index', id: 'index', value: build.index }, ...build.chunks.map(chunk => ({ kind: 'chunk', id: chunk.id, value: chunk }))];
  const assets: Array<{ bytes: number; sha256: string; key: string; id: string; kind: string; localId: string }> = [];
  for (const value of values) {
    const bytes = Buffer.from(JSON.stringify(value.value)); const key = randomUUID();
    const stored = await deps.store.putImmutable(key, (async function* () { yield bytes; })(), bytes.length);
    assets.push({ ...stored, key, id: randomUUID(), kind: value.kind, localId: value.id });
  }
  await deps.db.transaction(async client => {
    await guard(client);
    const currentJob = (await findWebJob(client, job.owner_id, job.id))!;
    if (currentJob.input_sha256 !== job.input_sha256 || currentJob.epoch !== job.epoch) throw publicationConflict();
    if (milestone < 4 && currentJob.publication_milestone >= milestone || milestone === 4 && currentJob.finalized_epoch === currentJob.epoch) return;
    const confirmed = (await client.query('SELECT 1 FROM web_job_checkpoints WHERE owner_id=$1 AND job_id=$2 AND input_sha256=$3 AND checkpoint=$4::jsonb', [job.owner_id,job.id,job.input_sha256,JSON.stringify(checkpoint)])).rowCount;
    if (!confirmed) throw publicationConflict();
    await client.query('SELECT id FROM documents WHERE owner_id=$1 AND id=$2 FOR UPDATE', [job.owner_id,job.document_id]);
    await lockObjectPublication(client);
    const actual = await readers.findWebParse(client, job.owner_id, job.document_id, source.source_version_id, parse.id);
    if (actual?.ir_asset_id !== parse.ir_asset_id || actual.ir_sha256 !== parse.ir_sha256) throw publicationConflict();
    await checkRetainedDependencies(client, deps.store, job.owner_id, job.document_id, source.source_version_id, reader.id, true);
    for (const asset of assets) {
      if ((await deps.store.stat(asset.key)).bytes !== asset.bytes) throw publicationConflict();
      await readers.insertWebAsset(client, { id: asset.id, ownerId: job.owner_id, documentId: job.document_id, objectKey: asset.key, sha256: asset.sha256, bytes: asset.bytes, mediaType: 'application/json' });
    }
    const common = { ownerId: job.owner_id, documentId: job.document_id, sourceVersionId: source.source_version_id, parseId: parse.id };
    const artifact = assets.find(a => a.kind === 'translation')!;
    await readers.insertWebTranslation(client, { ...common, id: translation.id, jobId: job.id, translationAssetId: artifact.id, sha256: artifact.sha256 });
    await readers.insertWebReaderVersion(client, { ...common, id: versionId, translationId: translation.id, indexAssetId: assets.find(a => a.kind === 'index')!.id, translationStatus: build.index.translationStatus, warnings: build.index.warnings });
    for (const asset of assets.filter(a => a.kind === 'chunk')) await readers.insertWebReaderChunk(client, { ...common, readerVersionId: versionId, id: asset.localId, dataAssetId: asset.id });
    await client.query(`INSERT INTO web_reader_assets (owner_id,document_id,reader_version_id,local_id,asset_id)
      SELECT owner_id,document_id,$4,local_id,asset_id FROM web_reader_assets WHERE owner_id=$1 AND document_id=$2 AND reader_version_id=$3`, [job.owner_id,job.document_id,reader.id,versionId]);
    await promote(client, job, source, translation, versionId);
    await client.query(`UPDATE web_jobs SET reader_version_id=$2,publication_milestone=GREATEST(publication_milestone,$3),
      finalized_epoch=CASE WHEN $3=4 THEN epoch ELSE finalized_epoch END,updated_at=clock_timestamp() WHERE id=$1`, [job.id,versionId,milestone]);
  });
}
async function promote(client: PoolClient, job: WebJobRow, source: readers.WebSourceRow, translation: WebModelTranslation, versionId: string) {
  const document = (await readers.findWebDocument(client, job.owner_id, job.document_id))!;
  if (document.requested_web_job_id !== job.id || document.latest_web_source_version_id !== source.source_version_id) return;
  const current = await readers.findWebReaderVersion(client, job.owner_id, job.document_id);
  const previous = current && await readers.findWebSource(client, job.owner_id, job.document_id, current.source_version_id);
  const rank = (status: string) => ['completed','not-required'].includes(status) ? 2 : status === 'partial' ? 1 : 0;
  if (current && (rank(translation.status)<rank(current.translation_status) || previous && (
    String(previous.metadata.capturedAt ?? '')>String(source.metadata.capturedAt ?? '') ||
    previous.scope.completeWithinScope && !source.scope.completeWithinScope ||
    previous.metadata.coverage === 'full' && source.metadata.coverage !== 'full'))) return;
  await readers.setCurrentWebReader(client, job.owner_id, job.document_id, source.source_version_id, versionId);
}
