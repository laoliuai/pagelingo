import { deflateSync } from 'node:zlib';

// Entirely generated fixture: deterministic RGBA noise, valid PNG chunks and CRCs.
export function ownPng(): Uint8Array {
  const chunk = (type: string, bytes: Buffer) => {
    const name = Buffer.from(type); const body = Buffer.concat([name, bytes]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(256); header.writeUInt32BE(128, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((256 * 4 + 1) * 128); let seed = 42;
  for (let y = 0; y < 128; y++) for (let x = 1; x <= 256 * 4; x++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; rows[y * 1025 + x] = seed >>> 24; }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
export const ownPngUrl = () => `data:image/png;base64,${Buffer.from(ownPng()).toString('base64')}`;
