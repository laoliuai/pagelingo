import { z } from 'zod';
import { readingDocumentSchema, quoteSchema } from '@pagelingo/assistant-core';
export const assistantDeliverySchema = z.object({
  id: z.string(),
  windowId: z.number().int(),
  tabId: z.number().int(),
  document: readingDocumentSchema,
  quote: quoteSchema.optional(),
});
export type AssistantDelivery = z.infer<typeof assistantDeliverySchema>;
export const assistantRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('extension:assistant-context'),
    tabId: z.number().int().nonnegative(),
    selectionText: z.string().max(50_000).optional(),
  }),
  z.object({
    type: z.literal('extension:assistant-deliver'),
    tabId: z.number().int().nonnegative(),
    selectionText: z.string().max(50_000).optional(),
  }),
  z.object({ type: z.literal('extension:assistant-pending'), windowId: z.number().int() }),
  z.object({ type: z.literal('extension:assistant-ack'), windowId: z.number().int(), id: z.string() }),
  z.object({
    type: z.literal('extension:assistant-reveal'),
    tabId: z.number().int(),
    blockId: z.string().max(160),
    revision: z.string().max(160),
  }),
]);
export const contentAssistantSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('assistant:read'),
    selectionText: z.string().max(50_000).optional(),
    includeSelection: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('assistant:reveal'),
    blockId: z.string().max(160),
    revision: z.string().max(160),
  }),
]);
export const pendingAssistantKey = (windowId: number) => `assistantPending:${windowId}`;
