import { z } from 'zod';
import { readerContractCeilings } from './reader-limits.js';
import { translationBlockSchema } from '@pagelingo/translation-core';
import { blockIdSchema, bundlePathSchema, languageDecisionSchema, nodeIdSchema, sha256Schema, safePositiveIntegerSchema, withJsonDepthLimit } from './reader-common.js';
import { pdfPageMetadataSchema, pdfSourceRefSchema, readerParseSchema, readerPdfSourceSchema } from './reader-source.js';
export { languageDecisionSchema, parseCoverageSchema } from './reader-common.js';
export type { LanguageDecision, ParseCoverage } from './reader-common.js';

const localId = z.string().min(1);
const assetId = z.string().min(1).max(240);
// Portable shape shared verbatim by Zod and generated JSON Schema. Browser URL
// authority/port legality is checked separately by validateReaderGraph.
const externalLink = z.string().regex(/^(?:https?:\/\/[^/?#\s\x00-\x1f\x7f]+[^\s\x00-\x1f\x7f]*|mailto:[^\s\x00-\x1f\x7f]+)$/)
  .describe('Portable HTTP/HTTPS/mailto shape; validateReaderGraph additionally checks WHATWG URL legality.');
export const readerBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('link'), id: localId, href: externalLink }),
  z.strictObject({ kind: z.literal('block-link'), id: localId, blockId: blockIdSchema }),
  z.strictObject({ kind: z.literal('style'), id: localId,
    emphasis: z.enum(['strong', 'emphasis', 'subscript', 'superscript', 'deletion', 'small', 'mark', 'underline']).optional(),
    align: z.enum(['left', 'center', 'right', 'justify']).optional(), monospace: z.boolean().optional(),
    color: z.string().regex(/^#[0-9a-f]{6}$/).optional(), backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/).optional(),
  }),
  z.strictObject({ kind: z.literal('protected'), id: localId, object: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('math'), latex: z.string().max(readerContractCeilings.maxLatexBytes) }),
    z.strictObject({ type: z.literal('code'), text: z.string().max(readerContractCeilings.maxCodeBytes), language: z.string().min(1).optional() }),
    z.strictObject({ type: z.literal('literal'), text: z.string().max(readerContractCeilings.maxTextBytes) }),
    z.strictObject({ type: z.literal('asset'), assetId, alt: z.string() }),
  ]) }),
]);
export type ReaderBinding = z.infer<typeof readerBindingSchema>;
export const readerAssetSchema = z.strictObject({
  id: assetId, path: bundlePathSchema, sha256: sha256Schema, bytes: safePositiveIntegerSchema,
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  width: z.number().int().min(1).max(readerContractCeilings.maxImageDimension), height: z.number().int().min(1).max(readerContractCeilings.maxImageDimension),
});
export type ReaderAsset = z.infer<typeof readerAssetSchema>;
const commonBlock = { id: blockIdSchema, sourceRefs: z.array(pdfSourceRefSchema).min(1) };
export const readerBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...commonBlock, type: z.literal('text'), value: translationBlockSchema,
    bindings: z.array(readerBindingSchema), language: languageDecisionSchema }),
  z.strictObject({ ...commonBlock, type: z.literal('image'), assetId, alt: z.string(),
    role: z.enum(['figure', 'table', 'formula', 'original-region']), originalRegion: pdfSourceRefSchema.nullable() }),
  z.strictObject({ ...commonBlock, type: z.literal('code'), code: z.string().max(readerContractCeilings.maxCodeBytes), language: z.string().min(1).optional() }),
  z.strictObject({ ...commonBlock, type: z.literal('math'), latex: z.string().max(readerContractCeilings.maxLatexBytes), displayMode: z.boolean(), fallbackAssetId: assetId.optional() }),
  z.strictObject({ ...commonBlock, type: z.literal('rule') }),
]);
export type ReaderBlock = z.infer<typeof readerBlockSchema>;
const commonNode = { id: nodeIdSchema, children: z.array(nodeIdSchema),
  presentation: z.strictObject({ align: z.enum(['left', 'center', 'right', 'justify']).optional() }).optional() };
export const readerNodeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...commonNode, kind: z.literal('section'), headingBlockId: blockIdSchema.optional() }),
  z.strictObject({ ...commonNode, kind: z.literal('group') }),
  z.strictObject({ ...commonNode, kind: z.literal('list'), ordered: z.boolean(), start: z.number().int().positive().optional() }),
  z.strictObject({ ...commonNode, kind: z.literal('list-item') }),
  z.strictObject({ ...commonNode, kind: z.literal('callout'), semantic: z.enum(['note', 'definition', 'example', 'prompt']) }),
  z.strictObject({ ...commonNode, kind: z.literal('block'), children: z.array(nodeIdSchema).max(0), blockId: blockIdSchema }),
]);
export type ReaderNode = z.infer<typeof readerNodeSchema>;
/** Shape only: closure, ordering, geometry and binding semantics are validated separately. */
export const readerIrShapeSchema = z.strictObject({
  schemaVersion: z.literal('reader-ir/1'),
  metadata: z.strictObject({ title: z.string().min(1), originalFilename: z.string().min(1), language: languageDecisionSchema }),
  source: readerPdfSourceSchema, parse: readerParseSchema,
  pages: z.array(pdfPageMetadataSchema), roots: z.array(nodeIdSchema),
  nodes: z.array(readerNodeSchema).max(readerContractCeilings.maxNodes), blocks: z.array(readerBlockSchema).max(readerContractCeilings.maxBlocks),
  assets: z.array(readerAssetSchema), warnings: z.array(z.string().min(1)),
});
export const readerIrSchema = withJsonDepthLimit(readerIrShapeSchema);
export type ReaderIR = z.infer<typeof readerIrSchema>;
export { validateReaderGraph } from './reader-graph.js';
