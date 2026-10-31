import { createHash } from 'node:crypto';
import type { CaptureFile, CaptureLimits, CaptureResource } from '@pagelingo/document-contracts';
import { inspectImageResource } from '@pagelingo/web-capture';
import { rasterizeSvg } from './rasterize.js';
import type { PreparedCapture } from './worker-client.js';

/** Sent on every public read. Some sites refuse requests with no User-Agent. */
export const CAPTURE_USER_AGENT = 'Mozilla/5.0 (compatible; PageLingo/0.4; personal reading archive)';
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';
const IMAGE_BUDGET_MS = 300_000;
type MissingReason = Extract<CaptureResource, { status: 'missing' }>['reason'];
const SIGNATURES: Array<[string, (bytes: Uint8Array) => boolean]> = [
  ['image/png', b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['image/jpeg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46],
  ['image/webp', b => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45],
];
/** Servers often send generic types for images, so the bytes decide. */
function sniffImage(bytes: Uint8Array): string | null {
  for (const [mediaType, matches] of SIGNATURES) if (matches(bytes)) return mediaType;
  const start = Buffer.from(bytes.subarray(0, 1024)).toString('utf8').trimStart().toLowerCase();
  return start.startsWith('<svg') || (start.startsWith('<?xml') && start.includes('<svg')) ? 'image/svg+xml' : null;
}
function decodeDataUrl(url: string): Uint8Array | null {
  const match = /^data:image\/[a-z0-9.+-]+(;[^,]*)?,(.*)$/is.exec(url);
  if (!match) return null;
  return match[1]?.toLowerCase().includes('base64') ? Buffer.from(match[2]!, 'base64') : Buffer.from(decodeURIComponent(match[2]!), 'utf8');
}

class ResourceUnavailable extends Error {
  constructor(readonly reason: MissingReason) { super(reason); }
}

/**
 * Downloads the images the sanitizer registered for a saved article, never CSS or linked pages.
 * A failed image stays recorded as missing with its reason; the article is still saved.
 * Returns whether any image was processed, in which case the capture must be validated again.
 */
export async function capturePublicImages(prepared: PreparedCapture, input: { fetchImage: typeof fetch; limits: CaptureLimits; signal: AbortSignal; budgetMs?: number }): Promise<boolean> {
  const { fetchImage, limits, signal } = input;
  const deadline = Date.now() + (input.budgetMs ?? IMAGE_BUDGET_MS);
  let total = prepared.files.reduce((sum, file) => sum + file.bytes.length, 0);
  let processed = false;

  async function read(url: string): Promise<Uint8Array> {
    if (url.startsWith('data:')) {
      const bytes = decodeDataUrl(url);
      if (!bytes) throw new ResourceUnavailable('unsupported');
      return bytes;
    }
    if (!/^https?:\/\//i.test(url)) throw new ResourceUnavailable('unsupported');
    const response = await fetchImage(url, { headers: { accept: ACCEPT, 'user-agent': CAPTURE_USER_AGENT }, signal: AbortSignal.any([signal, AbortSignal.timeout(limits.requestTimeoutMs)]) });
    if (!response.ok) { await response.body?.cancel(); throw new ResourceUnavailable('unavailable'); }
    return new Uint8Array(await response.arrayBuffer());
  }

  for (const resource of prepared.manifest.resources) {
    if (resource.role !== 'image' || resource.status === 'available' || !resource.url) continue;
    processed = true;
    try {
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw new ResourceUnavailable('timeout');
      if (prepared.manifest.files.length >= limits.maxFiles) throw new ResourceUnavailable('too-large');
      let bytes = await read(resource.url);
      let mediaType = sniffImage(bytes);
      if (!mediaType) throw new ResourceUnavailable('unsupported');
      if (mediaType === 'image/svg+xml') {
        if (bytes.length > limits.maxResourceBytes) throw new ResourceUnavailable('too-large');
        bytes = await rasterizeSvg(bytes, signal).catch(error => { signal.throwIfAborted(); throw error instanceof ResourceUnavailable ? error : new ResourceUnavailable('invalid'); });
        mediaType = 'image/png';
      }
      if (bytes.length > limits.maxResourceBytes || total + bytes.length > limits.maxTotalBytes) throw new ResourceUnavailable('too-large');
      const file: CaptureFile = { id: `image-${resource.id}`, path: `images/${resource.id}`, role: 'image', mediaType, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      await inspectImageResource(bytes, file, limits).catch(error => { throw new ResourceUnavailable(/budget/i.test(String(error?.message)) ? 'too-large' : 'invalid'); });
      Object.assign(resource, { status: 'available', fileId: file.id });
      delete (resource as { reason?: unknown }).reason;
      prepared.manifest.files.push(file);
      prepared.files.push({ id: file.id, bytes });
      total += bytes.length;
    } catch (error) {
      signal.throwIfAborted();
      Object.assign(resource, { reason: error instanceof ResourceUnavailable ? error.reason : 'unavailable' });
    }
  }
  return processed;
}
