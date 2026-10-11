import { z } from 'zod';
import { inlineContentSchema, translationDocumentSchema } from '@pagelingo/translation-core';
import { pageCommandSchema, metricsSchema } from './types';

export const TRANSLATION_PORT = 'pagelingo:translation';
export const translationStartSchema = z.strictObject({
  type: z.literal('translation:start'), sessionId: z.uuid(), document: translationDocumentSchema,
  resume: z.boolean().default(false),
});
export const translationEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('translation:batch'), value: z.object({
    documentId: z.string(), completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
    translations: z.array(z.object({ id: z.string(), text: z.string(), content: z.array(inlineContentSchema) })),
    failures: z.array(z.object({ id: z.string(), error: z.string() })).optional(), metrics: metricsSchema.optional(),
  }) }),
  z.object({ type: z.literal('translation:done') }),
  z.object({ type: z.literal('translation:error'), error: z.string() }),
  z.object({ type: z.literal('translation:heartbeat') }),
]);
export type TranslationEvent = z.infer<typeof translationEventSchema>;

// The session capability is issued only by the background after a trusted user command.
export const contentCommandSchema = z.object({ command: pageCommandSchema, translationSessionId: z.uuid().optional() });

export function isTrustedExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL('')));
}
