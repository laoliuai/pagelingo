import { ServiceError } from '../errors.js';
import type { ByteRange } from './object-store.js';

export function parseByteRange(header: string | undefined, size: number): ByteRange | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  const invalid = () => new ServiceError(416, 'RANGE_NOT_SATISFIABLE', 'Requested byte range is not satisfiable');
  if (!match || (!match[1] && !match[2]) || size <= 0) throw invalid();
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) throw invalid();
  if (first === undefined) {
    if (!last || last < 1) throw invalid();
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  if (first >= size || (last !== undefined && first > last)) throw invalid();
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}
