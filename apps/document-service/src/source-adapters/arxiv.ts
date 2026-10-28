import { createHash } from 'node:crypto';
import { ServiceError } from '../errors.js';
import { validatePdf } from '../documents/pdf-validation.js';
import { assertJobLeaseCurrent, type JobLease } from '../web-jobs/repository.js';
import { finishWebJob } from '../web-jobs/lease.js';
import { assertSourcePublication, resolveSourceIdentity } from './identity.js';
import { acquireSourceMaterial, loadSourceAcquisition } from './repository.js';
import { readSourceBytes } from './capture-resources.js';
import { parseArxivAtom } from './arxiv-atom.js';
import { publishArxivMetadata, publishArxivPdf } from './arxiv-publication.js';
import { withArxivRequest } from './rate-limit.js';
import { createSourceTransport } from './network.js';
import type { SourceFetchDependencies, SourceReference } from './types.js';
const MiB = 1024 * 1024;
function checkStatus(status: number): void {
  if (status === 429 || status === 503) throw new ServiceError(429, 'ARXIV_RATE_LIMITED', 'arXiv unavailable');
  if (status !== 200) throw new ServiceError(400, 'ARXIV_SOURCE_UNAVAILABLE', 'arXiv unavailable');
}
export async function runArxivFetchJob(lease: JobLease, deps: SourceFetchDependencies): Promise<void> {
  if (lease.kind !== 'fetch-link') throw new Error('arXiv fetch requires fetch-link lease');
  if (deps.sourceTransport && deps.config.mode !== 'test') throw new Error('Source transport injection requires test mode');
  if (deps.config.mode === 'test' && !deps.sourceTransport) throw new Error('Test source jobs require explicit source transport');
  const transport = deps.sourceTransport ?? createSourceTransport(); const { db, signal } = deps;
  const request = await db.transaction(async client => { await assertJobLeaseCurrent(client, lease); return (await client.query<{ reference: SourceReference }>('SELECT reference FROM source_requests WHERE owner_id=$1 AND job_id=$2', [lease.ownerId, lease.jobId])).rows[0]; });
  if (request?.reference.provider !== 'arxiv') throw new Error('arXiv request required');
  const reference = request.reference;
  try {
    signal.throwIfAborted();
    const identity = await resolveSourceIdentity(db, lease, { provider: 'arxiv', id: reference.baseId });
    if (identity.resolution !== 'self') { await finishWebJob(lease, db, 'failed', 'SOURCE_IDENTITY_CONFLICT'); return; }
    let atom = await loadSourceAcquisition(db, lease, 'arxiv-atom');
    if (!atom) {
      const url = `https://export.arxiv.org/api/query?id_list=${reference.baseId}${reference.version === null ? '' : `v${reference.version}`}`;
      const result = await withArxivRequest(db, lease, async () => {
        await db.transaction(c => assertSourcePublication(c, lease)); signal.throwIfAborted();
        const response = await transport.readSmall(url, { accept: 'application/atom+xml', maxBytes: MiB, signal });
        const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
        try { if (reader) for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > MiB) throw new ServiceError(400, 'ARXIV_INVALID_METADATA', 'Atom exceeds bound'); chunks.push(next.value); } }
        finally { await reader?.cancel(); }
        return { status: response.status, retryAfter: response.headers.get('retry-after'), bytes: Buffer.concat(chunks) };
      }, value => value.retryAfter);
      if (!result.executed) return;
      checkStatus(result.value.status); parseArxivAtom(result.value.bytes, reference);
      atom = await acquireSourceMaterial(lease, deps, { role: 'arxiv-atom', url, filename: 'arxiv.atom', mediaType: 'application/atom+xml', maxBytes: MiB, body: (async function* () { yield result.value.bytes; })() });
    }
    const value = parseArxivAtom(await readSourceBytes(deps, atom, MiB), reference);
    const revisionId = await db.transaction(client => publishArxivMetadata(client, lease, value, atom!));
    let pdf = await loadSourceAcquisition(db, lease, 'arxiv-pdf');
    if (!pdf) {
      const result = await withArxivRequest(db, lease, async () => {
        await db.transaction(c => assertSourcePublication(c, lease)); signal.throwIfAborted();
        // Managed callback completion AND HTTP cleanup are awaited before the limiter cooldown.
        return transport.downloadPdf(value.pdfUrl, { maxBytes: deps.config.maxPdfBytes, signal }, async (body, response) => {
          if (response.status !== 200) return { status: response.status, retryAfter: response.headers.get('retry-after'), pdf: null };
          const acquired = await acquireSourceMaterial(lease, deps, { role: 'arxiv-pdf', url: value.pdfUrl, filename: `${value.baseId.replace('/', '-')}v${value.version}.pdf`, mediaType: 'application/pdf', maxBytes: deps.config.maxPdfBytes, body: validatePdf(body, deps.config.maxPdfBytes) });
          return { status: response.status, retryAfter: response.headers.get('retry-after'), pdf: acquired };
        });
      }, value => value.retryAfter);
      if (!result.executed) return;
      checkStatus(result.value.status); pdf = result.value.pdf!;
    }
    // Reopened immutable acquisitions are checked by streaming, never PDF-sized Buffer assembly.
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of validatePdf(deps.store.read(pdf.objectKey), deps.config.maxPdfBytes)) { signal.throwIfAborted(); bytes += chunk.byteLength; hash.update(chunk); }
    if (bytes !== pdf.bytes || hash.digest('hex') !== pdf.sha256) throw new ServiceError(400, 'SOURCE_HASH_MISMATCH', 'Stored source changed');
    await publishArxivPdf(lease, deps, revisionId, pdf);
    await db.transaction(c => assertSourcePublication(c, lease));
    await finishWebJob(lease, db, 'completed');
  } catch (error) {
    signal.throwIfAborted();
    await db.transaction(c => assertSourcePublication(c, lease));
    await finishWebJob(lease, db, 'failed', error instanceof ServiceError ? error.code : 'ARXIV_SOURCE_UNAVAILABLE');
  }
}
