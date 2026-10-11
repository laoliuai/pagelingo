import { z } from 'zod';
import type { GlossaryEntry } from './glossary.js';
import type { BlockKind, FormatInline, InlineContent, ProtectedInline, TextInline } from './document.js';

export type InlineSlot =
  | { token: string; kind: 'atom'; inline: ProtectedInline | TextInline }
  | { token: string; kind: 'open'; pair: string; inline: Omit<FormatInline, 'children'> }
  | { token: string; kind: 'close'; pair: string };

export type AppliedGlossaryEntry = GlossaryEntry & { tokens: string[]; ranges?: Array<{ start: number; end: number }> };

/** Model-facing representation, never containing DOM nodes or format-specific source locations. */
export interface TranslationInput {
  id: string;
  kind: BlockKind;
  sourceText: string;
  protectedText: string;
  slots: InlineSlot[];
  sectionPath?: string[];
  glossary?: AppliedGlossaryEntry[];
  /** Internal terminology slots restored before adapters receive model text. */
  terminologyTokens?: string[];
  /** Artificial formatting wrappers must remain at the exact split boundaries. */
  continuation?: { prefix: string; suffix: string };
}

export const translationOutputSchema = z.strictObject({
  translations: z.array(z.strictObject({ id: z.string().min(1), text: z.string().min(1) })),
});
export type TranslationOutput = z.infer<typeof translationOutputSchema>;

export interface TranslatedBlock {
  id: string;
  /** Validated model text containing the original markers. */
  text: string;
  /** Portable output tree: protected objects are restored locally, never from model values. */
  content: InlineContent[];
}

export interface TranslationBatchResult {
  documentId: string;
  translations: TranslatedBlock[];
  completed: number;
  total: number;
  failures?: Array<{ id: string; error: string }>;
  metrics?: TranslationMetrics;
}

export interface TranslationMetrics {
  requests: number; retries: number; cacheHits: number;
  promptTokens: number; completionTokens: number; totalTokens: number;
  usageRequests: number; startedAt: number; elapsedMs: number; firstResultMs?: number;
  storageWarning?: string;
}

export const translationProfileSchema = z.enum(['technical', 'academic']);
export type TranslationProfile = z.infer<typeof translationProfileSchema>;

export interface TranslationOptions {
  targetLanguage: string;
  profile?: TranslationProfile;
  signal?: AbortSignal;
  glossary?: readonly GlossaryEntry[];
  glossaryDomain?: GlossaryEntry['domain'];
}
