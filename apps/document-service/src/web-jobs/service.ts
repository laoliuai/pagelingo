import { assertOperationNotRetired } from '../document-lifecycle/retired-identities.js';
import { assertDocumentActive, lockDocument } from '../document-lifecycle/guards.js';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  createWebJobRequestSchema,
  retryWebJobRequestSchema,
  webJobSchema,
  webReaderIrSchema,
  webLanguageDecisionSchema,
  defaultCaptureLimits,
  type CreateWebJobRequest,
  type RetryWebJobRequest,
  type WebJob,
  type WebLanguageDecision,
} from '@pagelingo/document-contracts';
import { toWebTranslationDocument } from '@pagelingo/document-renderer';
import { canonicalManifestBytes } from '@pagelingo/web-capture';
import { assertActorCurrent, type Actor } from '../auth/guards.js';
import type { Database } from '../db/database.js';
import type { ObjectStore } from '../storage/object-store.js';
import { ServiceError } from '../errors.js';
import { findProviderProfile } from '../providers/repository.js';
import { currentGlossaryRevision, ensureGlossaryRevision } from '../glossary/repository.js';
import * as readers from '../web-readers/repository.js';
import { readWebAsset, webNotFound } from '../web-readers/assets.js';
import type { CapturePublicationHook } from '../web-captures/service.js';
import { readSavePreferences } from './preferences.js';
import { profileChanged } from './profile.js';
import * as repo from './repository.js';
export function publicWebJob(row: repo.WebJobRow): WebJob {
  return webJobSchema.parse({
    id: row.id,
    documentId: row.document_id,
    kind: row.kind,
    status: row.status,
    sourceVersionId: row.source_version_id,
    parseId: row.parse_id,
    profileRevision: row.profile_revision,
    glossaryRevision: row.glossary_revision,
    sourceLanguage: row.source_language,
    selectionBlockIds: row.selection_block_ids,
    readerVersionId: row.reader_version_id,
    completedUnits: row.completed_units,
    totalUnits: row.total_units,
    errorCode: row.error_code,
    warnings: row.warnings,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}
function languageEligible(language: WebLanguageDecision, override?: string): boolean {
  if (language.reason === 'no-language') return false;
  if (override) return override.split('-')[0]!.toLowerCase() !== 'zh';
  return ['en', 'foreign'].includes(language.language);
}
async function dependencies(
  client: PoolClient,
  ownerId: string,
  documentId: string,
  sourceId: string,
  parseId: string,
) {
  await assertDocumentActive(client, ownerId, documentId);
  const source = await readers.findWebSource(client, ownerId, documentId, sourceId);
  const parse = await readers.findWebParse(client, ownerId, documentId, sourceId, parseId);
  if (!source || !parse) throw webNotFound();
  return { source, parse };
}
async function createBoundJob(
  client: PoolClient,
  ownerId: string,
  authVersion: number,
  documentId: string,
  input: CreateWebJobRequest,
  irSha256: string,
) {
  const identity = {
    kind: 'translate',
    sourceVersionId: input.sourceVersionId,
    parseId: input.parseId,
    readerIrSha256: irSha256,
    profileRevision: input.profileRevision,
    glossaryRevision: input.glossaryRevision,
    sourceLanguage: input.sourceLanguage?.toLowerCase() ?? null,
    selectionBlockIds: input.selectionBlockIds ?? null,
    ...(input.requestId ? { requestId: input.requestId } : {}),
  };
  const inputSha256 = createHash('sha256').update(canonicalManifestBytes(identity)).digest('hex');
  if (input.requestId) {
    const accepted = await repo.findWebJobByRequest(client, ownerId, documentId, authVersion, input.requestId);
    if (accepted) {
      if (accepted.input_sha256 !== inputSha256)
        throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', 'This start action was already accepted with different input');
      return accepted;
    }
  }
  const current = await findProviderProfile(client, ownerId);
  if (!current?.key_id || !current.base_url || !current.model.trim())
    throw new ServiceError(409, 'PROVIDER_NOT_CONFIGURED', 'Configure your provider before starting translation');
  const glossaryRevision = await currentGlossaryRevision(client, ownerId);
  if (current.revision !== input.profileRevision || glossaryRevision !== input.glossaryRevision) throw profileChanged();
  const existing = await repo.findWebJobByInput(client, ownerId, documentId, authVersion, inputSha256);
  if (existing) return existing;
  if (glossaryRevision === 0) await ensureGlossaryRevision(client, ownerId);
  // Profiles predating S3 gain their immutable public snapshot only when explicitly used.
  await repo.insertProviderRevision(client, ownerId, current.revision, {
    baseUrl: current.base_url,
    model: current.model,
    temperature: current.temperature,
    responseFormat: current.response_format,
    maxOutputTokens: current.max_output_tokens,
    maxTokensParameter: current.max_tokens_parameter,
    thinkingMode: current.thinking_mode,
    stream: current.stream,
    maxInputTokens: current.max_input_tokens,
    contextWindowTokens: current.context_window_tokens,
  });
  const job = await repo.insertWebJob(client, {
    id: randomUUID(),
    ownerId,
    authVersion,
    documentId,
    inputSha256,
    kind: 'translate',
    sourceVersionId: input.sourceVersionId,
    parseId: input.parseId,
    profileRevision: input.profileRevision,
    glossaryRevision: input.glossaryRevision,
    sourceLanguage: identity.sourceLanguage,
    selectionBlockIds: identity.selectionBlockIds,
    requestId: input.requestId,
  });
  await readers.setRequestedWebJob(client, ownerId, documentId, job.id);
  return job;
}
/** Owner lock is already held. Lock slots before jobs, and release only the matching token. */
async function stopJob(client: PoolClient, row: repo.WebJobRow, status: 'cancelled' | 'paused-config') {
  if (row.slot_id !== null) await client.query('SELECT id FROM web_worker_slots WHERE id=$1 FOR UPDATE', [row.slot_id]);
  await client.query('SELECT id FROM web_jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE', [row.owner_id, row.id]);
  if (row.slot_id !== null)
    await client.query(
      `UPDATE web_worker_slots SET owner_id=NULL,job_id=NULL,lease_owner=NULL,lease_until=NULL
    WHERE id=$1 AND epoch=$2 AND owner_id=$3 AND job_id=$4 AND lease_owner=$5`,
      [row.slot_id, row.slot_epoch, row.owner_id, row.id, row.lease_owner],
    );
  return (
    await client.query<repo.WebJobRow>(
      `UPDATE web_jobs SET status=$3,epoch=epoch+1,lease_owner=NULL,lease_until=NULL,slot_id=NULL,slot_epoch=NULL,error_code=$4,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 RETURNING *`,
      [row.owner_id, row.id, status, status === 'paused-config' ? 'PROFILE_CHANGED' : null],
    )
  ).rows[0]!;
}
export function createWebJobsService({ db, store }: { db: Database; store: ObjectStore }) {
  async function owned<T>(actor: Actor, fn: (c: PoolClient) => Promise<T>) {
    return db.transaction(async (c) => {
      await assertActorCurrent(c, actor);
      return fn(c);
    });
  }
  async function currentJob(c: PoolClient, actor: Actor, id: string) {
    let row = await repo.findWebJob(c, actor.userId, id);
    if (!row) throw webNotFound();
    await lockDocument(c, actor.userId, row.document_id);
    await assertDocumentActive(c, actor.userId, row.document_id);
    if (row.kind === 'translate' && ['queued', 'running'].includes(row.status)) {
      const current = await findProviderProfile(c, actor.userId);
      if (row.auth_version !== actor.authVersion || current?.revision !== row.profile_revision || !current.key_id)
        row = await stopJob(c, row, 'paused-config');
    }
    return row;
  }
  return {
    async create(actor: Actor, documentId: string, raw: CreateWebJobRequest) {
      const parsed = createWebJobRequestSchema.safeParse(raw);
      if (!parsed.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid translation request');
      const input = parsed.data;
      const loaded = await owned(actor, async (c) => {
        if (input.requestId) await assertOperationNotRetired(c, actor.userId, 'web-job-request', input.requestId, { documentId, authVersion: actor.authVersion });
        const d = await dependencies(c, actor.userId, documentId, input.sourceVersionId, input.parseId);
        const asset = (
          await c.query<readers.WebAssetRow>(
            'SELECT id,object_key,sha256,bytes,media_type FROM assets WHERE owner_id=$1 AND document_id=$2 AND id=$3',
            [actor.userId, documentId, d.parse.ir_asset_id],
          )
        ).rows[0];
        if (!asset || Number(asset.bytes) > defaultCaptureLimits.maxIrBytes) throw webNotFound();
        return { ...d, asset, epoch: (await assertDocumentActive(c, actor.userId, documentId)).epoch };
      });
      const ir = webReaderIrSchema.parse(JSON.parse((await readWebAsset(store, loaded.asset)).toString('utf8')));
      if (
        ir.parse.id !== input.parseId ||
        ir.source.manifestSha256 !== loaded.source.sha256 ||
        loaded.asset.sha256 !== loaded.parse.ir_sha256
      )
        throw webNotFound();
      const all = ir.blocks.filter((b) => b.type === 'text').map((b) => b.id);
      const selection = input.selectionBlockIds ? new Set(input.selectionBlockIds) : null;
      const selected = selection ? all.filter((id) => selection.has(id)) : all;
      if (!selected.length || (input.selectionBlockIds && selected.length !== input.selectionBlockIds.length))
        throw new ServiceError(400, 'INVALID_REQUEST', 'Selection must contain source text blocks');
      if (!languageEligible(ir.metadata.language, input.sourceLanguage))
        throw new ServiceError(
          409,
          'SOURCE_LANGUAGE_REQUIRED',
          'Select a known non-Chinese source language for translatable text',
        );
      toWebTranslationDocument(ir, selected, input.sourceLanguage ?? ir.metadata.language.sourceLanguage ?? undefined);
      const canonical = {
        ...input,
        sourceVersionId: loaded.source.source_version_id,
        ...(input.requestId ? { requestId: input.requestId.toLowerCase() } : {}),
        sourceLanguage: input.sourceLanguage?.toLowerCase(),
        selectionBlockIds: selected.length === all.length ? undefined : selected,
      };
      return owned(actor, async (c) => {
        await lockDocument(c, actor.userId, documentId);
        await assertDocumentActive(c, actor.userId, documentId, loaded.epoch);
        const actual = await dependencies(c, actor.userId, documentId, input.sourceVersionId, input.parseId);
        if (actual.parse.ir_sha256 !== loaded.parse.ir_sha256 || actual.source.sha256 !== loaded.source.sha256)
          throw webNotFound();
        await c.query('SELECT id FROM documents WHERE owner_id=$1 AND id=$2 FOR UPDATE', [actor.userId, documentId]);
        return publicWebJob(
          await createBoundJob(c, actor.userId, actor.authVersion, documentId, canonical, actual.parse.ir_sha256),
        );
      });
    },
    async get(actor: Actor, id: string) {
      return owned(actor, async (c) => publicWebJob(await currentJob(c, actor, id)));
    },
    async cancel(actor: Actor, id: string) {
      return owned(actor, async (c) => {
        await assertOperationNotRetired(c, actor.userId, 'web-job', id);
        const row = await currentJob(c, actor, id);
        return publicWebJob(
          ['completed', 'cancelled', 'failed'].includes(row.status) ? row : await stopJob(c, row, 'cancelled'),
        );
      });
    },
    async retry(actor: Actor, id: string, raw: RetryWebJobRequest) {
      const parsed = retryWebJobRequestSchema.safeParse(raw);
      if (!parsed.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid retry');
      // Commit fencing even when returning PROFILE_CHANGED; errors outside the transaction preserve it.
      const result = await owned(actor, async (c) => {
        await assertOperationNotRetired(c, actor.userId, 'web-job', id);
        const row = await currentJob(c, actor, id);
        if (row.kind === 'export-web') throw new ServiceError(409,'EXPORT_TERMINAL','Start a new export action');
        await assertDocumentActive(c, actor.userId, row.document_id, Number(row.document_epoch));
        const profile = await findProviderProfile(c, actor.userId);
        if (
          row.auth_version !== actor.authVersion ||
          (row.kind === 'translate' &&
            (profile?.revision !== row.profile_revision ||
              !profile.key_id ||
              parsed.data.profileRevision !== row.profile_revision ||
              parsed.data.glossaryRevision !== row.glossary_revision))
        )
          return null;
        if (['failed', 'cancelled', 'partial'].includes(row.status))
          return (
            await c.query<repo.WebJobRow>(
              "UPDATE web_jobs SET status='queued',epoch=epoch+1,error_code=NULL,next_request_at=NULL,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 RETURNING *",
              [actor.userId, id],
            )
          ).rows[0]!;
        if (row.status === 'paused-config') return null;
        return row;
      });
      if (!result) throw profileChanged();
      return publicWebJob(result);
    },
  };
}
/** SQL-only policy hook. Producer has locked and revalidated owner; selected immutable rows are authoritative. */
export function createCaptureJobScheduler(): CapturePublicationHook {
  return async (client, event) => {
    if (event.translationIntent === 'none') return null;
    if (event.translationIntent === 'auto' && !(await readSavePreferences(client, event.ownerId)).autoTranslate)
      return null;
    const user = (await client.query('SELECT active,auth_version FROM users WHERE id=$1', [event.ownerId])).rows[0];
    if (!user?.active || user.auth_version !== event.authVersion) return null;
    const reader = await readers.findWebReaderVersion(client, event.ownerId, event.documentId, event.readerVersionId);
    if (
      !reader ||
      reader.source_version_id !== event.sourceVersionId ||
      ['completed', 'not-required'].includes(reader.translation_status)
    )
      return null;
    const { source, parse } = await dependencies(
      client,
      event.ownerId,
      event.documentId,
      event.sourceVersionId,
      reader.parse_id,
    );
    const language = webLanguageDecisionSchema.safeParse(source.metadata.language);
    if (!language.success || !languageEligible(language.data)) return null;
    const profile = await findProviderProfile(client, event.ownerId);
    if (!profile?.key_id || !profile.base_url || !profile.model.trim()) return null;
    const glossaryRevision = await currentGlossaryRevision(client, event.ownerId);
    return (
      await createBoundJob(
        client,
        event.ownerId,
        event.authVersion,
        event.documentId,
        {
          sourceVersionId: event.sourceVersionId,
          parseId: parse.id,
          profileRevision: profile.revision,
          glossaryRevision,
        },
        parse.ir_sha256,
      )
    ).id;
  };
}
