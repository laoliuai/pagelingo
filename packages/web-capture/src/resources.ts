import { captureFileSchema, webReaderAssetSchema, webCaptureManifestSchema, type WebCaptureManifest, type PendingCaptureResource, type CaptureFile, type CaptureLimits, type WebReaderAsset } from '@pagelingo/document-contracts';
import { inspectJpeg } from './jpeg.js';
import { sha256 } from './fingerprint.js';
import { check, limitsFor } from './tree.js';
interface Dimensions { width: number; height: number; frames: number }
/** Bounded structural inspection of actual encoded bytes, not Content-Type or HTML
 * dimensions. Full codec decoding is the display adapter's responsibility. */
export async function inspectImageResource(input: Uint8Array, descriptor: CaptureFile, options?: CaptureLimits): Promise<WebReaderAsset> {
  const limits = limitsFor(options); const file = captureFileSchema.parse(descriptor);
  check(input.length === file.bytes && input.length <= limits.maxResourceBytes, 'Image byte budget or descriptor mismatch');
  // Copy before awaiting: a caller cannot mutate the hashed bytes during inspection.
  const bytes = new Uint8Array(input);
  check(await sha256(bytes) === file.sha256, 'Image digest mismatch');
  check(file.role === 'image', 'Unsupported resource role');
  const view = new DataView(bytes.buffer); const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  const need = (end: number) => check(end <= bytes.length, 'Truncated image format');
  const dimensions = (width: number, height: number, frames = 1): Dimensions => {
    check(width > 0 && height > 0 && width <= limits.maxImageDimension && height <= limits.maxImageDimension, 'Image dimension budget exceeded');
    check(width * height <= limits.maxImagePixels && width * height * frames <= limits.maxGifFramePixels, 'Image pixel budget exceeded');
    check(frames <= limits.maxGifFrames, 'Image frame budget exceeded'); return { width, height, frames };
  };
  let result: Dimensions | undefined; let mediaType: WebReaderAsset['mediaType'] | undefined;
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') {
    mediaType = 'image/gif'; need(13); const width = view.getUint16(6, true), height = view.getUint16(8, true);
    dimensions(width, height); let offset = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0); let frames = 0; let ended = false;
    const subblocks = () => { for (;;) { need(offset + 1); const length = bytes[offset++]; need(offset + length); offset += length; if (!length) return; } };
    while (offset < bytes.length) {
      const marker = bytes[offset++];
      if (marker === 59) { ended = true; break; }
      if (marker === 33) { need(++offset); subblocks(); }
      else if (marker === 44) {
        need(offset + 9); const x = view.getUint16(offset, true), y = view.getUint16(offset + 2, true);
        const w = view.getUint16(offset + 4, true), h = view.getUint16(offset + 6, true);
        check(w > 0 && h > 0 && x + w <= width && y + h <= height, 'GIF frame outside canvas');
        const packed = bytes[offset + 8]; offset += 9 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0);
        need(offset + 1); check(bytes[offset] >= 2 && bytes[offset] <= 8, 'Invalid GIF LZW format'); offset++; subblocks();
        dimensions(width, height, ++frames);
      } else throw new Error('Invalid GIF format');
    }
    check(ended && offset === bytes.length && frames > 0, 'Truncated or trailing GIF format'); result = dimensions(width, height, frames);
  } else if (bytes.length >= 8 && ascii(1, 4) === 'PNG' && bytes[0] === 137 && ascii(4, 8) === '\r\n\x1a\n') {
    mediaType = 'image/png'; let offset = 8; let data = false; let ended = false;
    while (offset < bytes.length) {
      need(offset + 12); const length = view.getUint32(offset); const tag = ascii(offset + 4, offset + 8); need(offset + 12 + length);
      if (offset === 8) { check(tag === 'IHDR' && length === 13, 'Invalid PNG header format'); result = dimensions(view.getUint32(offset + 8), view.getUint32(offset + 12)); }
      check(tag !== 'acTL', 'Animated PNG format unsupported');
      if (tag === 'IDAT') data = true;
      if (tag === 'IEND') { check(length === 0, 'Invalid PNG end format'); ended = true; }
      offset += length + 12; if (ended) break;
    }
    check(ended && data && offset === bytes.length, 'Truncated or trailing PNG format');
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    mediaType = 'image/jpeg';
    const jpeg = inspectJpeg(bytes);
    result = dimensions(jpeg.width, jpeg.height);
  } else if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    mediaType = 'image/webp'; need(20); check(view.getUint32(4, true) + 8 === bytes.length, 'Truncated WEBP format');
    let offset = 12; let image = false; let canvas: Dimensions | undefined;
    while (offset < bytes.length) {
      need(offset + 8); const tag = ascii(offset, offset + 4); const length = view.getUint32(offset + 4, true); const start = offset + 8; need(start + length + (length % 2));
      check(tag !== 'ANIM' && tag !== 'ANMF', 'Animated WEBP format unsupported');
      if (tag === 'VP8 ') { check(length >= 10 && bytes[start + 3] === 157 && bytes[start + 4] === 1 && bytes[start + 5] === 42, 'Invalid WEBP frame format'); result = dimensions(view.getUint16(start + 6, true) & 16383, view.getUint16(start + 8, true) & 16383); image = true; }
      if (tag === 'VP8L') { check(length >= 5 && bytes[start] === 47, 'Invalid WEBP lossless format'); const bits = view.getUint32(start + 1, true); result = dimensions((bits & 16383) + 1, ((bits >>> 14) & 16383) + 1); image = true; }
      if (tag === 'VP8X') { check(length === 10 && !(bytes[start] & 2), 'Animated or invalid WEBP format'); canvas = dimensions(1 + bytes[start + 4] + bytes[start + 5] * 256 + bytes[start + 6] * 65536, 1 + bytes[start + 7] + bytes[start + 8] * 256 + bytes[start + 9] * 65536); }
      offset = start + length + length % 2;
    }
    check(image, 'Missing WEBP image format');
    check(!canvas || (canvas.width === result?.width && canvas.height === result?.height), 'WEBP canvas/frame mismatch');
  }
  check(result && mediaType === file.mediaType, 'Unsupported or mismatched image format');
  return webReaderAssetSchema.parse({ id: file.id, path: file.path, sha256: file.sha256, bytes: file.bytes, mediaType, ...result });
}

export function replayResourcesFromManifest(manifest: WebCaptureManifest): PendingCaptureResource[] {
  return webCaptureManifestSchema.parse(manifest).resources.map(({ id, url, role }) => ({ id, url, role }));
}
