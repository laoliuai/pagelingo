import { SaxesParser } from 'saxes';
import { ServiceError } from '../errors.js';
import { classifySourceUrl } from './url.js';
import type { SourceReference } from './types.js';
export interface ArxivMetadata { baseId: string; version: number; title: string; authors: string[]; summary: string; publishedAt: string; updatedAt: string; pdfUrl: string }
const atomNamespace = 'http://www.w3.org/2005/Atom';
function invalid(): never { throw new ServiceError(400, 'ARXIV_INVALID_METADATA', 'Invalid arXiv metadata'); }
function date(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) invalid();
  const parsed = new Date(value);
  // Date.parse normalizes impossible calendar days; require an exact round trip.
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value.replace('Z', '.000Z')) invalid();
  return parsed.toISOString();
}
/** Bounded SAX events only; no DOM, DTD, external entities or provider-supplied download URLs. */
export function parseArxivAtom(bytes: Uint8Array, requested: Extract<SourceReference, { provider: 'arxiv' }>): ArxivMetadata {
  if (bytes.byteLength > 1024 * 1024) invalid();
  try {
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parser = new SaxesParser({ xmlns: true });
    const stack: Array<{ local: string; uri: string }> = [];
    const fields = new Map<string, string>(); const authors: string[] = [];
    let nodes = 0, entries = 0, active: string | null = null, content = '', authorName = false;
    const node = () => { if (++nodes > 5000) invalid(); };
    parser.on('doctype', invalid); parser.on('error', invalid);
    parser.on('comment', node); parser.on('processinginstruction', node);
    parser.on('opentag', tag => {
      node(); stack.push(tag); if (stack.length > 32) invalid();
      if (stack.length === 1 && (tag.uri !== atomNamespace || tag.local !== 'feed')) invalid();
      if (tag.uri !== atomNamespace) return;
      if (tag.local === 'entry') { if (stack.length !== 2 || ++entries !== 1) invalid(); }
      if (stack[1]?.local !== 'entry' || stack[1]?.uri !== atomNamespace) return;
      if (stack.length === 3 && ['id', 'title', 'summary', 'published', 'updated'].includes(tag.local)) {
        if (fields.has(tag.local)) invalid(); active = tag.local; content = '';
      }
      if (stack.length === 3 && tag.local === 'author') { if (authors.length >= 1000) invalid(); authorName = false; }
      if (stack.length === 4 && stack[2]!.local === 'author' && stack[2]!.uri === atomNamespace && tag.local === 'name') {
        if (authorName) invalid(); authorName = true; active = 'author'; content = '';
      }
    });
    const text = (value: string) => { node(); if (active) { content += value; if (content.length > (active === 'summary' ? 20000 : 8192)) invalid(); } };
    parser.on('text', text); parser.on('cdata', text);
    parser.on('closetag', tag => {
      if (tag.uri === atomNamespace && active && ((stack.length === 3 && tag.local === active) || (stack.length === 4 && active === 'author' && tag.local === 'name'))) {
        if (active === 'author') { const name = content.trim(); if (!name || name.length > 500) invalid(); authors.push(name); }
        else fields.set(active, content.trim());
        active = null;
      }
      if (stack.length === 3 && tag.uri === atomNamespace && tag.local === 'author' && !authorName) invalid();
      stack.pop();
    });
    parser.write(xml).close();
    if (entries !== 1 || !authors.length || !['id', 'title', 'summary', 'published', 'updated'].every(key => fields.has(key))) invalid();
    const identity = classifySourceUrl(fields.get('id')!);
    if (identity?.provider !== 'arxiv' || identity.baseId !== requested.baseId || identity.version === null || identity.version > 2147483647 || (requested.version !== null && identity.version !== requested.version)) invalid();
    const title = fields.get('title')!.replace(/\s+/g, ' '); if (!title || title.length > 2000) invalid();
    const publishedAt = date(fields.get('published')!), updatedAt = date(fields.get('updated')!);
    if (updatedAt < publishedAt) invalid();
    return { baseId: identity.baseId, version: identity.version, title, authors, summary: fields.get('summary')!, publishedAt, updatedAt, pdfUrl: `https://arxiv.org/pdf/${identity.baseId}v${identity.version}` };
  } catch { return invalid(); }
}
