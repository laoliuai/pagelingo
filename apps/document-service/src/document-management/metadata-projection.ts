import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DocumentOrigin } from '@pagelingo/document-contracts';
import type { Database } from '../db/database.js';
import type { ObjectStore } from '../storage/object-store.js';

export function documentOrigin(url: string | null, kind: string): DocumentOrigin {
  if (kind === 'pdf') return 'upload';
  try {
    const host = new URL(url!).hostname.toLowerCase().replace(/\.$/, '');
    const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);
    if (matches('x.com') || matches('twitter.com')) return 'x';
    if (matches('zhihu.com')) return 'zhihu';
    if (matches('weixin.qq.com')) return 'wechat';
    if (matches('github.com')) return 'github';
    if (matches('arxiv.org')) return 'arxiv';
  } catch { /* Old malformed URLs remain ordinary web links. */ }
  return 'web';
}
export interface SearchProjection {
  ownerId: string; documentId: string; sourceVersionId: string | null; parseId: string | null;
  sourceSha256: string | null; irSha256?: string | null; metadata: Record<string, unknown>;
}
interface SelectedSourceRow {
  id: string; owner_id: string; source_url: string | null; source_id: string | null; sha256: string | null;
  parse_id: string | null; ir_sha256: string | null; object_key: string | null; bytes: string | null;
  metadata: Record<string, unknown> | null;
}
const selectedColumns = `d.id,d.owner_id,d.source_url,s.id AS source_id,s.sha256,COALESCE(r.parse_id,w.parse_id) AS parse_id,
  COALESCE(p.ir_sha256,wp.ir_sha256) AS ir_sha256,a.object_key,a.bytes,ws.metadata`;
const selectedFrom = `FROM documents d
  LEFT JOIN source_versions s ON(s.owner_id,s.document_id,s.id)=(d.owner_id,d.id,d.current_source_version_id)
  LEFT JOIN reader_versions r ON(r.owner_id,r.document_id,r.id)=(d.owner_id,d.id,d.current_reader_version_id)
  LEFT JOIN web_reader_versions w ON(w.owner_id,w.document_id,w.id)=(d.owner_id,d.id,d.current_web_reader_version_id)
  LEFT JOIN parse_runs p ON(p.owner_id,p.document_id,p.source_version_id,p.id)=(r.owner_id,r.document_id,r.source_version_id,r.parse_id)
  LEFT JOIN web_parse_runs wp ON(wp.owner_id,wp.document_id,wp.source_version_id,wp.id)=(w.owner_id,w.document_id,w.source_version_id,w.parse_id)
  LEFT JOIN assets a ON(a.owner_id,a.document_id,a.id)=(d.owner_id,d.id,COALESCE(p.ir_asset_id,wp.ir_asset_id))
  LEFT JOIN web_sources ws ON(ws.owner_id,ws.document_id,ws.source_version_id)=(d.owner_id,d.id,d.current_source_version_id)`;
const text = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : '';
function projectionInput(row: SelectedSourceRow, metadata: Record<string, unknown>): SearchProjection {
  return { ownerId: row.owner_id, documentId: row.id, sourceVersionId: row.source_id, sourceSha256: row.sha256,
    parseId: row.parse_id, irSha256: row.ir_sha256, metadata };
}

/** Source/parse/hash identity is rechecked while locking the selected document. No object I/O. */
export async function projectSearchMetadata(client: PoolClient, input: SearchProjection): Promise<boolean> {
  const selected = (await client.query<SelectedSourceRow>(`SELECT ${selectedColumns} ${selectedFrom}
    WHERE d.owner_id=$1 AND d.id=$2 AND d.deleted_at IS NULL FOR UPDATE OF d`, [input.ownerId, input.documentId])).rows[0];
  if (!selected || selected.source_id !== (input.sourceVersionId?.toLowerCase() ?? null) || selected.sha256 !== input.sourceSha256
    || selected.parse_id !== input.parseId || selected.ir_sha256 !== (input.irSha256 ?? null)) return false;
  // The selected fixed paper metadata is authoritative even for local IR/backfill.
  const paper = (await client.query(`SELECT v.title,v.authors,v.summary FROM documents d JOIN arxiv_versions v ON(v.owner_id,v.document_id,v.id)=(d.owner_id,d.id,d.current_arxiv_revision_id) WHERE d.owner_id=$1 AND d.id=$2 AND d.kind='paper'`, [input.ownerId, input.documentId])).rows[0];
  const metadata: Record<string, unknown> = paper ? { ...paper, url: selected.source_url } : input.metadata;
  const authors = Array.isArray(metadata.authors)
    ? metadata.authors.slice(0, 100).map(value => text(value, 500)).filter(Boolean).join('\n').slice(0, 8000)
    : text(metadata.author, 8000);
  const url = text(metadata.url ?? selected.source_url, 4096);
  let domain = '';
  try { domain = new URL(url).hostname.toLowerCase().slice(0, 253); } catch { /* No inferred URL. */ }
  await client.query(`INSERT INTO document_search_metadata(owner_id,document_id,source_version_id,parse_id,source_sha256,ir_sha256,authors,source_url,domain)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(owner_id,document_id) DO UPDATE SET
    source_version_id=EXCLUDED.source_version_id,parse_id=EXCLUDED.parse_id,source_sha256=EXCLUDED.source_sha256,ir_sha256=EXCLUDED.ir_sha256,
    authors=EXCLUDED.authors,source_url=EXCLUDED.source_url,domain=EXCLUDED.domain,updated_at=clock_timestamp()`,
  [input.ownerId, input.documentId, input.sourceVersionId, input.parseId, input.sourceSha256, input.irSha256 ?? null, authors, url, domain]);
  const title = typeof metadata.title === 'string' ? metadata.title.trim() : '';
  if (title && (await client.query(`UPDATE documents SET title=$3,title_origin='source',updated_at=clock_timestamp()
    WHERE owner_id=$1 AND id=$2 AND title_origin IN ('url','filename','source') AND title<>$3 RETURNING id`, [input.ownerId, input.documentId, title])).rowCount) {
    await client.query('UPDATE document_organization SET revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND document_id=$2', [input.ownerId, input.documentId]);
  }
  return true;
}

/** Called directly after current source/Reader promotion, using already saved source metadata. */
export async function projectSelectedMetadata(client: PoolClient, ownerId: string, documentId: string, metadata?: Record<string, unknown>): Promise<boolean> {
  const row = (await client.query<SelectedSourceRow>(`SELECT ${selectedColumns} ${selectedFrom} WHERE d.owner_id=$1 AND d.id=$2`, [ownerId, documentId])).rows[0];
  if (!row) return false;
  return projectSearchMetadata(client, projectionInput(row, metadata ?? { ...row.metadata, url: row.source_url }));
}

/** Explicit bounded maintenance; object reads are outside transactions and never call a model. */
export async function runMetadataBackfill({ db, store, signal }: { db: Database; store: ObjectStore; signal: AbortSignal }, { limit = 20 }: { limit?: number } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Metadata backfill limit must be between 1 and 100');
  const rows = await db.transaction(async client => {
    // Serialize only bounded selection/advancement. Failed or interrupted rows remain eligible
    // on wraparound, while independent workers continue beyond the last selected batch.
    await client.query('SELECT singleton FROM document_metadata_backfill_cursor WHERE singleton FOR UPDATE');
    const selected = (await client.query<SelectedSourceRow & { cursor_created_at: string }>(`SELECT ${selectedColumns},d.created_at::text AS cursor_created_at ${selectedFrom}
      LEFT JOIN document_search_metadata m ON(m.owner_id,m.document_id)=(d.owner_id,d.id)
      CROSS JOIN document_metadata_backfill_cursor b
      WHERE b.singleton AND d.deleted_at IS NULL AND (m.document_id IS NULL OR m.source_version_id IS DISTINCT FROM d.current_source_version_id
        OR m.parse_id IS DISTINCT FROM COALESCE(r.parse_id,w.parse_id))
      ORDER BY CASE WHEN b.last_document_id IS NULL OR (d.created_at,d.id)>(b.last_created_at,b.last_document_id) THEN 0 ELSE 1 END,
        d.created_at,d.id LIMIT $1`, [limit])).rows;
    const last = selected.at(-1);
    // Keep database timestamp precision; a JS Date would truncate microseconds at this boundary.
    if (last) await client.query('UPDATE document_metadata_backfill_cursor SET last_created_at=$1::timestamptz,last_document_id=$2 WHERE singleton', [last.cursor_created_at,last.id]);
    return selected;
  });
  let projected = 0, skipped = 0, failed = 0;
  for (const row of rows) {
    if (signal.aborted) break;
    try {
      let metadata: Record<string, unknown> = { ...row.metadata, url: row.source_url };
      if (row.object_key) {
        const maximum = 16 * 1024 * 1024;
        if (Number(row.bytes) > maximum) throw new Error('Metadata source exceeds bound');
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of store.read(row.object_key)) {
          signal.throwIfAborted(); bytes += chunk.byteLength;
          if (bytes > maximum) throw new Error('Metadata source exceeds bound');
          chunks.push(Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks);
        if (raw.length !== Number(row.bytes) || createHash('sha256').update(raw).digest('hex') !== row.ir_sha256) throw new Error('Metadata source hash mismatch');
        const ir = JSON.parse(raw.toString('utf8')) as { metadata?: Record<string, unknown> };
        metadata = { ...ir.metadata, ...metadata };
      }
      signal.throwIfAborted();
      const accepted = await db.transaction(async client => {
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [row.owner_id]);
        return projectSearchMetadata(client, projectionInput(row, metadata));
      });
      if (accepted) projected++; else skipped++;
    } catch { if (signal.aborted) break; failed++; }
  }
  return { selected: rows.length, projected, skipped, failed };
}
