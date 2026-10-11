import { z } from 'zod';

export const displayModeSchema = z.enum(['source', 'translation', 'bilingual']);
export type DisplayMode = z.infer<typeof displayModeSchema>;
export const metricsSchema = z.object({
  requests: z.number().nonnegative(), retries: z.number().nonnegative(), cacheHits: z.number().nonnegative(),
  promptTokens: z.number().nonnegative(), completionTokens: z.number().nonnegative(), totalTokens: z.number().nonnegative(),
  usageRequests: z.number().nonnegative(), startedAt: z.number(), elapsedMs: z.number().nonnegative(),
  firstResultMs: z.number().nonnegative().optional(), storageWarning: z.string().optional(),
});

export const pageStatusSchema = z.object({
  pageSessionId: z.string(),
  status: z.enum(['idle', 'extracting', 'translating', 'recovering', 'partial', 'completed', 'cancelled', 'stale', 'error']),
  mode: displayModeSchema,
  execution: z.enum(['preview', 'translation']).default('preview'),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  fallback: z.number().int().nonnegative(),
  recoveries: z.number().int().nonnegative().default(0),
  metrics: metricsSchema.optional(),
  error: z.string().optional(),
});
export type PageStatus = z.infer<typeof pageStatusSchema>;

export const pageCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('page:status') }),
  z.object({ type: z.literal('page:preview'), mode: displayModeSchema }),
  z.object({ type: z.literal('page:translate'), mode: displayModeSchema }),
  z.object({ type: z.literal('page:mode'), mode: displayModeSchema }),
  z.object({ type: z.literal('page:stop') }),
  z.object({ type: z.literal('page:restore') }),
  z.object({ type: z.literal('page:selection'), text: z.string().max(30_000) }),
  z.object({ type: z.literal('page:selection-preview'), text: z.string().max(30_000) }),
]);
export type PageCommand = z.infer<typeof pageCommandSchema>;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}
