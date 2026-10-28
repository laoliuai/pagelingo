import { z } from 'zod';

export const taxonomyNameSchema = z.string().trim().min(1).max(80);
/** Same normalization for create and rename, independent of database collation. */
export function nameKey(name: string): string { return name.normalize('NFKC').trim().toLowerCase(); }
export function literalPattern(value: string): string { return `%${value.replace(/[\\%_]/g, character => `\\${character}`)}%`; }
