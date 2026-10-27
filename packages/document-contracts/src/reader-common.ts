import { z } from 'zod';
import { readerContractCeilings } from './reader-limits.js';

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const parseIdSchema = z.string().regex(/^p_[a-f0-9]{64}$/);
export const blockIdSchema = z.string().regex(/^b_[a-f0-9]{32}$/);
export const nodeIdSchema = z.string().regex(/^n_[a-f0-9]{32}$/);
export const safePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const safeNonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const languageDecisionSchema = z.strictObject({
  language: z.enum(['zh', 'en', 'mixed', 'und']),
  reason: z.enum(['no-language', 'han-only', 'insufficient-text', 'other-script', 'han-majority', 'mixed-script',
    'english-heuristic', 'uncertain', 'document-inherited', 'user-specified']),
});
export type LanguageDecision = z.infer<typeof languageDecisionSchema>;
export const parseCoverageSchema = z.enum(['full', 'partial']);
export type ParseCoverage = z.infer<typeof parseCoverageSchema>;

// ASCII paths are portable across ZIP readers; segment restrictions also avoid Windows aliases.
export const bundlePathSchema = z.string().min(1).max(readerContractCeilings.maxPathBytes)
  .regex(/^[\x20-\x7e]+$/)
  .regex(/^[^\\:%"*<>?|]+$/)
  .regex(/^(?!\/)(?!.*\/$)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*(?:^|\/)(?:[cC][oO][nN]|[pP][rR][nN]|[aA][uU][xX]|[nN][uU][lL]|[cC][oO][mM][0-9]|[lL][pP][tT][0-9])(?:\.|\/|$))(?!.*(?:[. ]\/|[. ]$)).+$/);

/** Bound untrusted structure before invoking recursive SDK/Zod schemas. JSON text depth is
 * additionally checked before JSON.parse by byte-oriented adapters. */
export function withJsonDepthLimit<T extends z.ZodType>(schema: T) {
  return z.preprocess((value, context) => {
    const stack: Array<{ value: unknown; depth: number; ancestors: Set<object> }> = [{ value, depth: 0, ancestors: new Set() }];
    while (stack.length) {
      const current = stack.pop()!;
      if (typeof current.value !== 'object' || current.value === null) continue;
      if (current.depth >= readerContractCeilings.maxJsonDepth || current.ancestors.has(current.value)) {
        context.issues.push({ code: 'custom', input: value, message: 'JSON structure depth exceeds 128 or contains a cycle' });
        return z.NEVER;
      }
      const ancestors = new Set(current.ancestors).add(current.value);
      for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1, ancestors });
    }
    return value;
  }, schema);
}

export function requireContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function uniqueById<T extends { id: string }>(items: readonly T[], label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    requireContract(!result.has(item.id), `Duplicate ${label} ID: ${item.id}`);
    result.set(item.id, item);
  }
  return result;
}
