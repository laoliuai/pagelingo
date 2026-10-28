import { createHash } from 'node:crypto';
import type { CaptureFile } from '@pagelingo/document-contracts';
import { inspectImageResource } from '@pagelingo/web-capture';
import type { JobLease } from '../web-jobs/repository.js';
import type { PreparedCapture } from '../web-captures/worker-client.js';
import { acquireSourceMaterial, loadSourceAcquisition, type SourceAcquisition } from './repository.js';
import type { SourceFetchDependencies, SourceTransport } from './types.js';
import { assertSourcePublication } from './identity.js';

export async function readSourceBytes(deps: SourceFetchDependencies, material: SourceAcquisition, maxBytes: number): Promise<Buffer> {
  if (material.bytes > maxBytes) throw new Error('Source material exceeds bound');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of deps.store.read(material.objectKey)) {
    deps.signal.throwIfAborted(); bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error('Source material exceeds bound'); chunks.push(Buffer.from(chunk));
  }
  const value = Buffer.concat(chunks);
  if (bytes !== material.bytes || createHash('sha256').update(value).digest('hex') !== material.sha256) throw new Error('Source material digest mismatch');
  return value;
}

/** Fetch only the inert sanitizer's registered images, never CSS or linked pages. */
export async function captureGithubResources(lease: JobLease, deps: SourceFetchDependencies, transport: SourceTransport, prepared: PreparedCapture): Promise<void> {
  const limits = deps.config.captureLimits; const origins = new Set<string>();
  let total = prepared.manifest.files.reduce((n, file) => n + file.bytes, 0);
  for (const resource of prepared.manifest.resources) {
    if (resource.role !== 'image' || resource.status === 'available') continue;
    try {
      if (!resource.url || !/^https?:\/\//.test(resource.url)) { resource.reason = 'unsupported'; continue; }
      const origin = new URL(resource.url).origin;
      if (origins.size >= limits.maxResourceOrigins && !origins.has(origin)) { resource.reason = 'blocked'; continue; }
      origins.add(origin);
      if (prepared.manifest.files.length >= limits.maxFiles || total >= limits.maxTotalBytes) { resource.reason = 'too-large'; continue; }
      const role = `github-image-${createHash('sha256').update(resource.url).digest('hex')}`;
      let acquisition = await loadSourceAcquisition(deps.db, lease, role);
      if (!acquisition) {
        const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(limits.requestTimeoutMs)]);
        acquisition = await transport.downloadResource(resource.url, { accept: 'image/png,image/jpeg,image/webp,image/gif', maxBytes: Math.min(limits.maxResourceBytes, limits.maxTotalBytes - total), signal }, async (body, response) => {
          if (response.status !== 200) throw new Error('Resource unavailable');
          const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
          if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) throw new Error('Resource format unsupported');
          return acquireSourceMaterial(lease, { ...deps, signal }, { role, filename: `${resource.id}.image`, mediaType, url: resource.url!, maxBytes: Math.min(limits.maxResourceBytes, limits.maxTotalBytes - total), body });
        });
      }
      const bytes = await readSourceBytes(deps, acquisition, limits.maxResourceBytes);
      if (total + bytes.length > limits.maxTotalBytes) { resource.reason = 'too-large'; continue; }
      const file: CaptureFile = { id: `image-${resource.id}`, path: `images/${resource.id}`, role: 'image', mediaType: acquisition.mediaType, bytes: acquisition.bytes, sha256: acquisition.sha256 };
      await inspectImageResource(bytes, file, limits);
      Object.assign(resource, { status: 'available', fileId: file.id }); delete (resource as unknown as Record<string, unknown>).reason;
      prepared.manifest.files.push(file); prepared.files.push({ id: file.id, bytes }); total += bytes.length;
    } catch (error) {
      deps.signal.throwIfAborted();
      // A lost lease must escape rather than being converted into a missing image.
      await deps.db.transaction(client => assertSourcePublication(client, lease));
      resource.reason = error instanceof Error && /bound|large|budget/i.test(error.message) ? 'too-large' : 'unavailable';
    }
  }
}
