import { captureResourceUrlSchema, captureUrlSchema, type CaptureFile, type CaptureResource, type SanitizedSnapshot } from '@pagelingo/document-contracts';
import { check, utf8 } from './tree.js';
export function normalizeCaptureUrl(input: string): string {
  captureUrlSchema.parse(input);
  const url = new URL(input);
  for (const key of [...url.searchParams.keys()]) if (/^(?:utm_.*|fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
  return url.href;
}
/** Normalize tracking on network URLs only; local locators retain their exact provenance. */
export function normalizeCaptureResourceUrl(input: string, sourceUrl?: string): string {
  captureResourceUrlSchema.parse(input);
  if (input.startsWith('data:')) return input;
  if (input.startsWith('blob:')) {
    if (sourceUrl) check(new URL(input).origin === new URL(sourceUrl).origin, 'Blob resource belongs to another source origin');
    return input;
  }
  return normalizeCaptureUrl(input);
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function canonicalManifestBytes(value: unknown): Uint8Array<ArrayBuffer> { return utf8(canonicalJson(value)); }
export async function captureContentFingerprint(snapshot: SanitizedSnapshot, resources: readonly CaptureResource[], files: readonly CaptureFile[] = []): Promise<string> {
  const byId = new Map(files.map(file => [file.id, file]));
  const normalized = resources.map(resource => {
    if (resource.status === 'missing') return { id: resource.id, role: resource.role, url: normalizeCaptureResourceUrl(resource.url, snapshot.sourceUrl), status: resource.status, reason: resource.reason };
    const file = byId.get(resource.fileId); check(file, 'Fingerprint requires actual resource descriptor');
    const url = normalizeCaptureResourceUrl(resource.url, snapshot.sourceUrl);
    // Available bytes establish content equality independently of ephemeral object URLs.
    const provenance = url.startsWith('blob:') ? { kind: 'document-blob', origin: new URL(url).origin } : url;
    return { id: resource.id, role: resource.role, url: provenance, status: resource.status, sha256: file.sha256, bytes: file.bytes, mediaType: file.mediaType };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return sha256(utf8(canonicalJson({ html: snapshot.html, scope: { kind: snapshot.scope.kind, completeWithinScope: snapshot.scope.completeWithinScope }, resources: normalized })));
}
