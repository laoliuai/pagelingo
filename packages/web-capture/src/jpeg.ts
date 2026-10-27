import { check } from './tree.js';

/** Validate encoded marker/scan framing without decompressing image pixels. */
export function inspectJpeg(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (end: number) => check(end <= bytes.length, 'Truncated JPEG segment or marker');
  let offset = 2;
  let frame: { width: number; height: number } | undefined;
  let progressive = false;
  let scans = 0;
  const components = new Set<number>();
  while (offset < bytes.length) {
    check(bytes[offset++] === 0xff, 'Invalid JPEG marker prefix');
    while (bytes[offset] === 0xff) offset++;
    need(offset + 1);
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      check(frame && scans > 0 && offset === bytes.length, 'Invalid JPEG end or missing scan');
      return frame;
    }
    const supported = [0xc0, 0xc1, 0xc2, 0xc4, 0xdb, 0xdd, 0xda, 0xfe].includes(marker)
      || (marker >= 0xe0 && marker <= 0xef);
    check(supported, 'Unsupported or misplaced JPEG marker');
    need(offset + 2);
    const size = view.getUint16(offset);
    check(size >= 2, 'Invalid JPEG segment length');
    need(offset + size);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      check(!frame && size >= 8, 'Invalid or repeated JPEG frame');
      const count = bytes[offset + 7];
      check(count > 0 && count <= 4 && size === 8 + 3 * count, 'Invalid JPEG frame component header');
      const precision = bytes[offset + 2];
      check(precision === 8 || (marker !== 0xc0 && precision === 12), 'Unsupported JPEG precision');
      for (let i = 0; i < count; i++) {
        const component = offset + 8 + 3 * i;
        const id = bytes[component];
        const sampling = bytes[component + 1];
        check(!components.has(id) && (sampling >> 4) >= 1 && (sampling >> 4) <= 4
          && (sampling & 15) >= 1 && (sampling & 15) <= 4 && bytes[component + 2] <= 3,
        'Invalid JPEG frame component');
        components.add(id);
      }
      frame = { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      progressive = marker === 0xc2;
    }
    if (marker === 0xdd) check(size === 4, 'Invalid JPEG restart interval');
    if (marker !== 0xda) {
      offset += size;
      continue;
    }
    check(frame && size >= 6, 'Invalid JPEG scan before frame or missing SOS header');
    const count = bytes[offset + 2];
    check(count > 0 && count <= components.size && size === 6 + 2 * count, 'Invalid JPEG SOS component header');
    const selected = new Set<number>();
    for (let i = 0; i < count; i++) {
      const component = offset + 3 + 2 * i;
      const id = bytes[component];
      const tables = bytes[component + 1];
      check(components.has(id) && !selected.has(id) && (tables >> 4) <= 3 && (tables & 15) <= 3,
        'Invalid JPEG SOS component selector');
      selected.add(id);
    }
    const spectralStart = bytes[offset + size - 3];
    const spectralEnd = bytes[offset + size - 2];
    const approximation = bytes[offset + size - 1];
    if (progressive) {
      check(spectralStart <= spectralEnd && spectralEnd <= 63
        && (spectralStart === 0 ? spectralEnd === 0 : count === 1)
        && (approximation >> 4) <= 13 && (approximation & 15) <= 13,
      'Invalid progressive JPEG SOS parameters');
    } else {
      check(spectralStart === 0 && spectralEnd === 63 && approximation === 0, 'Invalid sequential JPEG SOS parameters');
    }
    offset += size;
    let entropyBytes = 0;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        entropyBytes++;
        continue;
      }
      const markerStart = offset++;
      while (bytes[offset] === 0xff) offset++;
      need(offset + 1);
      const next = bytes[offset];
      if (next === 0x00) {
        check(offset === markerStart + 1, 'Invalid JPEG entropy byte stuffing');
        entropyBytes++;
        offset++;
      } else if (next >= 0xd0 && next <= 0xd7) {
        check(entropyBytes > 0, 'JPEG restart marker before scan data');
        offset++;
      } else {
        // Leave the complete marker for the outer parser; progressive scans may
        // be followed by tables or another SOS rather than the final EOI.
        offset = markerStart;
        break;
      }
    }
    check(entropyBytes > 0, 'JPEG scan has no encoded data');
    scans++;
  }
  throw new Error('Truncated JPEG: missing end marker');
}
