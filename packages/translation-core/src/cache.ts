import type { TranslationDocument } from './document.js';
import { encodeBlock, PROTECTION_VERSION } from './protection.js';
import { PROMPT_VERSION } from './provider.js';
import type { TranslationInput, TranslationProfile } from './types.js';

export interface ProviderIdentity {
  endpoint: string;
  model: string;
  /** Actual generation parameters, never credentials. */
  generation: Record<string, unknown>;
}
export interface CacheEntry {
  key: string; text: string; schemaVersion: 1;
  createdAt: number; lastAccessedAt: number; bytes: number;
}
export interface TranslationCache {
  get(key: string): Promise<CacheEntry | undefined>;
  putMany(entries: CacheEntry[]): Promise<void>;
  delete(key: string): Promise<void>;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export async function contentHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function semanticInput(input: TranslationInput) {
  return { kind: input.kind, sourceText: input.sourceText, protectedText: input.protectedText,
    sectionPath: input.sectionPath, continuation: input.continuation,
    glossary: input.glossary?.map(({ ranges: _ranges, ...entry }) => entry),
    slots: input.slots.map((slot) => slot.kind === 'close' ? slot : {
      ...slot, inline: Object.fromEntries(Object.entries(slot.inline).filter(([key]) => key !== 'id')),
    }) };
}
export async function cacheKey(options: {
  input: TranslationInput; document: Pick<TranslationDocument, 'title' | 'sourceLanguage'> & { id?: string };
  targetLanguage: string; profile: TranslationProfile; identity: ProviderIdentity; dependencies?: unknown;
}): Promise<string> {
  return contentHash({ schema: 1, input: semanticInput(options.input),
    title: options.document.title, sourceLanguage: options.document.sourceLanguage,
    targetLanguage: options.targetLanguage, profile: options.profile,
    identity: { ...options.identity, endpoint: new URL(options.identity.endpoint).href },
    promptVersion: PROMPT_VERSION, protectionVersion: PROTECTION_VERSION, dependencies: options.dependencies });
}
export function documentFingerprint(document: TranslationDocument): Promise<string> {
  return contentHash({ title: document.title, sourceLanguage: document.sourceLanguage,
    blocks: document.blocks.map((block) => semanticInput(encodeBlock(block))) });
}
export function normalizeDocumentUrl(value: string): string {
  const url = new URL(value);
  for (const name of [...url.searchParams.keys()]) if (/^utm_/i.test(name) || /^(fbclid|gclid|msclkid)$/i.test(name)) url.searchParams.delete(name);
  url.searchParams.sort();
  if (!/^#!?\//.test(url.hash)) url.hash = '';
  return url.href;
}
export function makeCacheEntry(key: string, text: string): CacheEntry {
  const now = Date.now();
  return { key, text, schemaVersion: 1, createdAt: now, lastAccessedAt: now,
    bytes: new TextEncoder().encode(text).byteLength + 256 };
}
