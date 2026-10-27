import { crc32 } from 'node:zlib';
import { check } from './errors.js';
export interface ImageMetadata {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
}
/** Header/container checks are independent of extension and uploaded mediaType. No image decompression. */
export function inspectImage(data: Buffer): ImageMetadata {
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return png(data);
  if (data[0] === 0xff && data[1] === 0xd8) return jpeg(data);
  if (
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.toString('latin1', 8, 12) === 'WEBP'
  )
    return webp(data);
  check(false);
}
function png(data: Buffer): ImageMetadata {
  let offset = 8,
    width = 0,
    height = 0,
    idat = false,
    ended = false,
    first = true;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    check(length <= data.length - offset - 12);
    const type = data.toString('latin1', offset + 4, offset + 8),
      end = offset + 8 + length;
    // Latin-1 preserves every byte; Node's ASCII decoder masks high bits.
    check(/^[A-Za-z]{4}$/.test(type));
    check(crc32(data.subarray(offset + 4, end)) === data.readUInt32BE(end));
    if (first) {
      check(type === 'IHDR' && length === 13);
      width = data.readUInt32BE(offset + 8);
      height = data.readUInt32BE(offset + 12);
      check(width > 0 && height > 0);
      const depth = data[offset + 16],
        color = data[offset + 17];
      check(
        (
          {
            0: [1, 2, 4, 8, 16],
            2: [8, 16],
            3: [1, 2, 4, 8],
            4: [8, 16],
            6: [8, 16],
          } as Record<number, number[]>
        )[color]?.includes(depth),
      );
      check(
        data[offset + 18] === 0 &&
          data[offset + 19] === 0 &&
          data[offset + 20] <= 1,
      );
      first = false;
    } else check(type !== 'IHDR');
    if (type === 'IDAT') {
      check(length > 0);
      idat = true;
    }
    if (type === 'IEND') {
      check(length === 0 && idat);
      ended = true;
      offset = end + 4;
      break;
    }
    offset = end + 4;
  }
  check(ended && offset === data.length);
  return { mediaType: 'image/png', width, height };
}
function jpeg(data: Buffer): ImageMetadata {
  let offset = 2,
    width = 0,
    height = 0,
    sos = false;
  while (offset < data.length) {
    check(data[offset++] === 0xff);
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xd9) {
      check(sos && width > 0 && height > 0 && offset === data.length);
      return { mediaType: 'image/jpeg', width, height };
    }
    check(marker !== 0 && marker !== 0xd8 && offset + 2 <= data.length);
    const length = data.readUInt16BE(offset);
    check(length >= 2 && offset + length <= data.length);
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    )
      check([0xc0, 0xc1, 0xc2].includes(marker));
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      check(width === 0 && length >= 8);
      const components = data[offset + 7];
      check(components > 0 && components <= 4 && length === 8 + components * 3);
      height = data.readUInt16BE(offset + 3);
      width = data.readUInt16BE(offset + 5);
      check(width > 0 && height > 0);
    }
    offset += length;
    if (marker === 0xda) {
      check(width > 0 && height > 0);
      sos = true;
      while (offset + 1 < data.length) {
        if (data[offset] !== 0xff) {
          offset++;
          continue;
        }
        const next = data[offset + 1];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
          continue;
        }
        break;
      }
    }
  }
  check(false);
}
function webp(data: Buffer): ImageMetadata {
  check(data.length >= 20 && data.readUInt32LE(4) === data.length - 8);
  let offset = 12,
    width = 0,
    height = 0,
    payload = false;
  while (offset + 8 <= data.length) {
    const type = data.toString('latin1', offset, offset + 4),
      length = data.readUInt32LE(offset + 4),
      start = offset + 8;
    check(/^[\x20-\x7e]{4}$/.test(type));
    check(length <= data.length - start);
    if (type === 'VP8X') {
      check(
        offset === 12 &&
          length === 10 &&
          (data[start] & 0xc3) === 0 &&
          data[start + 1] === 0 &&
          data[start + 2] === 0 &&
          data[start + 3] === 0,
      );
      width = 1 + data.readUIntLE(start + 4, 3);
      height = 1 + data.readUIntLE(start + 7, 3);
    }
    if (type === 'VP8 ') {
      check(!payload);
      check(
        length >= 10 &&
          data[start + 3] === 0x9d &&
          data[start + 4] === 1 &&
          data[start + 5] === 0x2a,
      );
      const w = data.readUInt16LE(start + 6) & 0x3fff,
        h = data.readUInt16LE(start + 8) & 0x3fff;
      if (!width) {
        width = w;
        height = h;
      } else check(width === w && height === h);
      check(w > 0 && h > 0);
      payload = true;
    }
    if (type === 'VP8L') {
      check(!payload);
      check(length >= 5 && data[start] === 0x2f);
      const bits = data.readUInt32LE(start + 1);
      check(bits >>> 29 === 0);
      const w = (bits & 0x3fff) + 1,
        h = ((bits >>> 14) & 0x3fff) + 1;
      if (!width) {
        width = w;
        height = h;
      } else check(width === w && height === h);
      payload = true;
    }
    offset = start + length + (length % 2);
  }
  check(offset === data.length && width > 0 && height > 0 && payload);
  return { mediaType: 'image/webp', width, height };
}
