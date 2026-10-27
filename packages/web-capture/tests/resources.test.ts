import { expect, it } from 'vitest';
import { inspectImageResource, sha256 } from '../src/index.js';
import { defaultCaptureLimits, type CaptureFile } from '@pagelingo/document-contracts';
// One opaque 1x1 GIF, with one image descriptor and a complete LZW data stream.
const gif = Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'));
const file = async (data: Uint8Array, mediaType = 'image/gif'): Promise<CaptureFile> => ({ id: 'image-1', path: 'images/1.gif', bytes: data.length, sha256: await sha256(data), mediaType, role: 'image' });
it('inspects actual raster bytes and rejects descriptor spoofing and unsupported formats', async () => {
  const descriptor = await file(gif);
  expect(await inspectImageResource(gif, descriptor)).toMatchObject({ id: 'image-1', width: 1, height: 1, frames: 1, bytes: 34 });
  await expect(inspectImageResource(gif, { ...descriptor, sha256: '0'.repeat(64) })).rejects.toThrow(/digest/i);
  await expect(inspectImageResource(gif, { ...descriptor, bytes: 1 })).rejects.toThrow(/byte/i);
  await expect(inspectImageResource(gif, await file(gif, 'image/png'))).rejects.toThrow(/format/i);
  const svg = new TextEncoder().encode('<svg onload="evil()"/>');
  await expect(inspectImageResource(svg, await file(svg, 'image/png'))).rejects.toThrow(/format/i);
});
it('rejects truncated images, oversized dimensions, frames and cumulative pixels', async () => {
  const truncated = gif.slice(0, -1);
  await expect(inspectImageResource(truncated, await file(truncated))).rejects.toThrow(/truncated/i);
  const huge = gif.slice(); huge[6] = 255; huge[7] = 255;
  await expect(inspectImageResource(huge, await file(huge))).rejects.toThrow(/dimension|pixel/i);
  const twoFrames = new Uint8Array([...gif.slice(0, -1), ...gif.slice(19, -1), 59]);
  await expect(inspectImageResource(twoFrames, await file(twoFrames), { ...defaultCaptureLimits, maxGifFrames: 1 })).rejects.toThrow(/frame/i);
  await expect(inspectImageResource(twoFrames, await file(twoFrames), { ...defaultCaptureLimits, maxGifFramePixels: 1 })).rejects.toThrow(/pixel/i);
});
it('rejects a WebP extended canvas that exceeds the decoded-pixel budget', async () => {
  const bytes = new Uint8Array(44); const view = new DataView(bytes.buffer); const put = (s: string, n: number) => { for (const ch of s) bytes[n++] = ch.charCodeAt(0); };
  put('RIFF', 0); view.setUint32(4, 36, true); put('WEBP', 8); put('VP8X', 12); view.setUint32(16, 10, true);
  bytes[24] = 255; bytes[25] = 255; bytes[26] = 255; bytes[27] = 255; bytes[28] = 255; bytes[29] = 255;
  put('VP8L', 30); view.setUint32(34, 5, true); bytes[38] = 47;
  await expect(inspectImageResource(bytes, await file(bytes, 'image/webp'))).rejects.toThrow(/dimension|pixel|canvas/i);
});
