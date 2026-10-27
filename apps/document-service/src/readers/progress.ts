import type { PoolClient } from 'pg';
import { readingProgressSchema, type ReaderDescriptor, type ReaderIndex, type ReadingPosition, type ReadingProgress } from '@pagelingo/document-contracts';
import { ServiceError } from '../errors.js';
import type { VersionRow } from './repository.js';

export interface StateRow { revision: string; position: ReadingPosition | null; updated_at: Date }
export function revisionOf(row: StateRow): number {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new ServiceError(409, 'PROGRESS_CONFLICT', 'Reading progress revision is unavailable');
  return revision;
}
export async function readState(client: PoolClient, owner: string, documentId: string, lock = false): Promise<StateRow | undefined> {
  return (await client.query<StateRow>(`SELECT revision,position,updated_at FROM reading_state WHERE owner_id=$1 AND document_id=$2${lock ? ' FOR UPDATE' : ''}`, [owner, documentId])).rows[0];
}
export function progressView(row: StateRow | undefined): ReadingProgress | null {
  return row?.position ? readingProgressSchema.parse({ position: row.position, revision: revisionOf(row), updatedAt: row.updated_at.toISOString() }) : null;
}
export function validatePosition(position: ReadingPosition, version: VersionRow, index: ReaderIndex, pageCount: number): void {
  if (position.sourceVersionId !== version.source_version_id || position.parseId !== version.parse_id || position.readerVersionId !== version.id || position.pdfPageIndex >= pageCount || (position.blockId !== null && !Object.hasOwn(index.blockLocations, position.blockId))) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid reading position');
}
/** Effective restoration uses the current document acknowledgement for CAS, never a historical timestamp/revision. Reads do not persist it. */
export async function restoreProgress(client: PoolClient, owner: string, version: VersionRow, index: ReaderIndex, pageCount: number): Promise<Pick<ReaderDescriptor, 'progress' | 'restoreHint'>> {
  const state = await readState(client, owner, version.document_id);
  if (!state?.position) return { progress: null, restoreHint: null };
  const history = (await client.query<{ position: ReadingPosition }>('SELECT position FROM reading_positions WHERE owner_id=$1 AND document_id=$2 AND reader_version_id=$3', [owner, version.document_id, version.id])).rows[0];
  const previous = history?.position ?? state.position;
  const exact = previous.readerVersionId === version.id;
  const sameBlock = previous.parseId === version.parse_id && previous.blockId !== null && Object.hasOwn(index.blockLocations, previous.blockId);
  const pageFallback = !exact && !sameBlock;
  const position: ReadingPosition = { ...previous, readerVersionId: version.id, sourceVersionId: version.source_version_id, parseId: version.parse_id,
    pdfPageIndex: Math.min(previous.pdfPageIndex, pageCount - 1), ...(pageFallback ? { blockId: null, blockOffset: 0 } : {}) };
  return { progress: readingProgressSchema.parse({ position, revision: revisionOf(state), updatedAt: state.updated_at.toISOString() }), restoreHint: pageFallback ? 'version-updated-source-page' : null };
}
export async function saveProgress(client: PoolClient, owner: string, documentId: string, expectedRevision: number, position: ReadingPosition, state: StateRow | undefined): Promise<ReadingProgress> {
  if (!state || revisionOf(state) !== expectedRevision || expectedRevision === Number.MAX_SAFE_INTEGER) throw new ServiceError(409, 'PROGRESS_CONFLICT', 'Reading progress changed on another device');
  const updated = (await client.query<StateRow>(`UPDATE reading_state SET revision=revision+1,source_version_id=$3,parse_id=$4,reader_version_id=$5,position=$6,updated_at=now()
    WHERE owner_id=$1 AND document_id=$2 AND revision=$7 RETURNING revision,position,updated_at`, [owner, documentId, position.sourceVersionId, position.parseId, position.readerVersionId, JSON.stringify(position), expectedRevision])).rows[0];
  if (!updated) throw new ServiceError(409, 'PROGRESS_CONFLICT', 'Reading progress changed on another device');
  await client.query(`INSERT INTO reading_positions (owner_id,document_id,source_version_id,parse_id,reader_version_id,position,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (owner_id,document_id,reader_version_id) DO UPDATE SET position=EXCLUDED.position,updated_at=EXCLUDED.updated_at`, [owner, documentId, position.sourceVersionId, position.parseId, position.readerVersionId, JSON.stringify(position), updated.updated_at]);
  return progressView(updated)!;
}
