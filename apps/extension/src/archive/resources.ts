import { defaultCaptureLimits, type PendingCaptureResource } from '@pagelingo/document-contracts';
import { inspectImageResource } from '@pagelingo/web-capture';
import { describeFile, type AcquiredResource } from './upload';
import { hostPermission } from './binding';
import { RESOURCE_FRAME_BYTES, type CaptureGrant } from './grants';
export { RESOURCE_FRAME_BYTES } from './grants';
export function decodeResourceFrame(data: string): Uint8Array {
  if (!data.length || data.length > RESOURCE_FRAME_BYTES || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('invalid');
  const raw = atob(data); if (btoa(raw) !== data) throw new Error('invalid');
  return Uint8Array.from(raw, value => value.charCodeAt(0));
}
export async function boundedResourceResponse(response: Response): Promise<AcquiredResource> {
  if (!response.ok || !response.body) throw new Error('unavailable');
  const declared = Number(response.headers.get('content-length'));
  if (declared > defaultCaptureLimits.maxResourceBytes) { await response.body.cancel(); throw new Error('too-large'); }
  const chunks: Uint8Array[] = []; let size = 0; const reader = response.body.getReader();
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > defaultCaptureLimits.maxResourceBytes) throw new Error('too-large'); chunks.push(part.value); } }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, mediaType: response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '' };
}
export async function validateNativeImage(resource: AcquiredResource): Promise<void> {
  const descriptor = await describeFile('image', 'image', 'image', resource.mediaType, resource.bytes);
  await inspectImageResource(resource.bytes, descriptor);
  try { const bitmap = await createImageBitmap(new Blob([resource.bytes as BlobPart], { type: resource.mediaType })); bitmap.close(); }
  catch { throw new Error('invalid'); }
}
export async function acquireLocalResource(grant: CaptureGrant, id: string, lookup: (grant: CaptureGrant, id: string) => PendingCaptureResource,
  validate: (resource: AcquiredResource) => Promise<void> = validateNativeImage): Promise<AcquiredResource> {
  const resource = lookup(grant, id);
  if (resource.role !== 'image' || !(resource.url.startsWith('data:') || (resource.url.startsWith('blob:') && new URL(resource.url).origin === new URL(grant.url).origin))) throw new Error('blocked');
  const response = await fetch(resource.url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000) });
  const acquired = await boundedResourceResponse(response); lookup(grant, id);
  await validate(acquired); const current = lookup(grant, id); if (current.url !== resource.url || current.role !== resource.role) throw new Error('stale resource');
  return acquired;
}
export async function sendLocalResource(grant: CaptureGrant, id: string, lookup: (grant: CaptureGrant, id: string) => PendingCaptureResource): Promise<void> {
  const acquired = await acquireLocalResource(grant, id, lookup);
  // Base64 itself never exceeds 256 KiB. Frame metadata is separately bounded JSON.
  const rawFrameBytes = RESOURCE_FRAME_BYTES / 4 * 3;
  for (let offset = 0; offset < acquired.bytes.length; offset += rawFrameBytes) {
    lookup(grant, id); let raw = '';
    for (const byte of acquired.bytes.subarray(offset, offset + rawFrameBytes)) raw += String.fromCharCode(byte);
    const result = await chrome.runtime.sendMessage({ type: 'capture:resource-frame', grant, resourceId: id, offset, total: acquired.bytes.length, mediaType: acquired.mediaType, data: btoa(raw) });
    lookup(grant, id); if (!result?.ok) throw new Error('资源传输已失效。');
  }
}
export async function acquireNetworkResource(resource: PendingCaptureResource): Promise<AcquiredResource> {
  if (resource.url === null) throw new Error('blocked');
  const url = new URL(resource.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('blocked');
  if (!await chrome.permissions.contains({ origins: [hostPermission(resource.url)] })) throw new Error('blocked');
  const acquired = await boundedResourceResponse(await fetch(resource.url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000), referrerPolicy: 'no-referrer' }));
  if (resource.role === 'image') await validateNativeImage(acquired);
  else if (acquired.mediaType !== 'text/css') throw new Error('unsupported');
  return acquired;
}
