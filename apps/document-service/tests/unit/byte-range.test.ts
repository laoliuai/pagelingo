import { describe, expect, it } from 'vitest';
import { parseByteRange } from '../../src/storage/byte-range.js';

describe('single byte ranges', () => {
  it('accepts full, explicit, open and suffix requests and clamps the end', () => {
    expect(parseByteRange(undefined, 10)).toBeUndefined();
    expect(parseByteRange('bytes=0-4', 10)).toEqual({ start: 0, end: 4 });
    expect(parseByteRange('bytes=6-', 10)).toEqual({ start: 6, end: 9 });
    expect(parseByteRange('bytes=-4', 10)).toEqual({ start: 6, end: 9 });
    expect(parseByteRange('bytes=-40', 10)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=0-40', 10)).toEqual({ start: 0, end: 9 });
  });
  it.each(['bytes=0-1,4-5', 'bytes=10-', 'bytes=5-4', 'bytes=-0', 'items=0-1', 'bytes=a-b', 'bytes=9007199254740992-', 'bytes=-'])('rejects invalid or unsatisfiable %s', header => {
    expect(() => parseByteRange(header, 10)).toThrow(expect.objectContaining({ statusCode: 416 }));
  });
  it('rejects every range on an empty object', () => {
    expect(() => parseByteRange('bytes=0-', 0)).toThrow(expect.objectContaining({ statusCode: 416 }));
  });
});
