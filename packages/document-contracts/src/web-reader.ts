import { webGenerationKindSchema } from './web-translation.js';
import { z } from 'zod';
import { translationBlockSchema, type InlineContent } from '@pagelingo/translation-core';
import { blockIdSchema, nodeIdSchema, parseCoverageSchema, parseIdSchema, safeNonnegativeIntegerSchema, sha256Schema, withJsonDepthLimit } from './reader-common.js';
import { readerBindingSchema, readerNodeSchema } from './reader.js';
import { readerTranslationStatusSchema } from './reader-translation.js';
import { webLanguageDecisionSchema } from './language.js';
import { bundlePathSchema } from './reader-common.js';
import { defaultCaptureLimits, snapshotPreviewIndexSchema, webLocalIdSchema } from './web-capture.js';
import { webReadingProgressSchema } from './web-progress.js';

const svgTags = ['svg', 'g', 'defs', 'path', 'use', 'text', 'tspan', 'rect', 'line', 'polyline', 'polygon', 'circle', 'ellipse'] as const;
const mathTags = ['math', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace', 'ms', 'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover', 'mfrac', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'menclose', 'mphantom', 'mpadded', 'semantics', 'annotation'] as const;
// Presentation attributes are CSS inputs even when HTML-escaped. Only these
// literal grammars are supported: no escapes, comments, variables or URL paints.
const mathNumber = String.raw`[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?`;
const mathLength = `${mathNumber}(?:px|em|ex|rem|ch|pt|pc|in|cm|mm|%)?`;
const mathLengthSchema = z.string().regex(new RegExp(`^${mathLength}$`));
const mathLengthListSchema = z.string().regex(new RegExp(`^${mathLength}(?:[ ,]+${mathLength})*$`));
const mathFragmentIdSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]*$/);
const mathPaintSchema = z.string().regex(/^(?:[A-Za-z]+|#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|(?:rgb|rgba|hsl|hsla)\([0-9+.,% /-]+\))$/);
const mathBooleanSchema = z.enum(['true', 'false']);
const mathFontFamily = String.raw`(?:[A-Za-z][A-Za-z0-9 -]*|'[A-Za-z][A-Za-z0-9 -]*'|"[A-Za-z][A-Za-z0-9 -]*")`;
const mathAttributesSchema = z.strictObject({
  id: mathFragmentIdSchema.optional(),
  href: z.string().regex(/^#[A-Za-z_][A-Za-z0-9_.:-]*$/).optional(),
  'xlink:href': z.string().regex(/^#[A-Za-z_][A-Za-z0-9_.:-]*$/).optional(),
  xmlns: z.enum(['http://www.w3.org/2000/svg', 'http://www.w3.org/1998/Math/MathML']).optional(),
  d: z.string().max(defaultCaptureLimits.maxMathBytes).regex(/^[MmZzLlHhVvCcSsQqTtAa0-9eE+., -]*$/).optional(),
  viewBox: z.string().regex(new RegExp(`^${mathNumber}(?:[ ,]+${mathNumber}){3}$`)).optional(),
  x: mathLengthListSchema.optional(),
  y: mathLengthListSchema.optional(),
  dx: mathLengthListSchema.optional(),
  dy: mathLengthListSchema.optional(),
  x1: mathLengthSchema.optional(),
  y1: mathLengthSchema.optional(),
  x2: mathLengthSchema.optional(),
  y2: mathLengthSchema.optional(),
  width: mathLengthSchema.optional(),
  height: mathLengthSchema.optional(),
  rx: mathLengthSchema.optional(),
  ry: mathLengthSchema.optional(),
  r: mathLengthSchema.optional(),
  cx: mathLengthSchema.optional(),
  cy: mathLengthSchema.optional(),
  points: z.string().regex(new RegExp(`^${mathNumber}(?:[ ,]+${mathNumber})+$`)).optional(),
  transform: z.string().regex(/^ *(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([0-9eE+., -]+\) *)+$/).optional(),
  fill: mathPaintSchema.optional(),
  stroke: mathPaintSchema.optional(),
  'stroke-width': mathLengthSchema.optional(),
  'fill-rule': z.enum(['nonzero', 'evenodd']).optional(),
  'text-anchor': z.enum(['start', 'middle', 'end']).optional(),
  'font-size': mathLengthSchema.optional(),
  'font-family': z.string().regex(new RegExp(`^${mathFontFamily}(?:, *${mathFontFamily})*$`)).optional(),
  'font-weight': z.string().regex(/^(?:normal|bold|bolder|lighter|[1-9][0-9]{0,2}|1000)$/).optional(),
  mathvariant: z.enum(['normal', 'bold', 'italic', 'bold-italic', 'double-struck', 'bold-fraktur', 'script', 'bold-script', 'fraktur', 'sans-serif', 'bold-sans-serif', 'sans-serif-italic', 'sans-serif-bold-italic', 'monospace', 'initial', 'tailed', 'looped', 'stretched']).optional(),
  mathsize: z.union([mathLengthSchema, z.enum(['small', 'normal', 'big'])]).optional(),
  mathcolor: mathPaintSchema.optional(),
  displaystyle: mathBooleanSchema.optional(),
  scriptlevel: z.string().regex(/^[+-]?[0-9]+$/).optional(),
  stretchy: mathBooleanSchema.optional(),
  fence: mathBooleanSchema.optional(),
  separator: mathBooleanSchema.optional(),
  accent: mathBooleanSchema.optional(),
  accentunder: mathBooleanSchema.optional(),
  linethickness: z.union([mathLengthSchema, z.enum(['thin', 'medium', 'thick'])]).optional(),
  rowalign: z.string().regex(/^(?:top|bottom|center|baseline|axis)(?: +(?:top|bottom|center|baseline|axis))*$/).optional(),
  columnalign: z.string().regex(/^(?:left|center|right)(?: +(?:left|center|right))*$/).optional(),
  rowspacing: mathLengthListSchema.optional(),
  columnspacing: mathLengthListSchema.optional(),
  columnspan: z.string().regex(/^[1-9][0-9]*$/).optional(),
  rowspan: z.string().regex(/^[1-9][0-9]*$/).optional(),
  notation: z.string().regex(/^(?:longdiv|actuarial|radical|box|roundedbox|circle|left|right|top|bottom|updiagonalstrike|downdiagonalstrike|verticalstrike|horizontalstrike|madruwb|phasorangle)(?: +(?:longdiv|actuarial|radical|box|roundedbox|circle|left|right|top|bottom|updiagonalstrike|downdiagonalstrike|verticalstrike|horizontalstrike|madruwb|phasorangle))*$/).optional(),
  encoding: z.literal('application/x-tex').optional(),
});
export const safeMathNodeSchema = z.strictObject({
  id: webLocalIdSchema, tag: z.enum([...svgTags, ...mathTags]),
  attributes: mathAttributesSchema,
  children: z.array(webLocalIdSchema), text: z.string().max(defaultCaptureLimits.maxMathBytes).optional(),
});
export type SafeMathNode = z.infer<typeof safeMathNodeSchema>;
export const safeMathAstShapeSchema = z.strictObject({
  kind: z.enum(['svg', 'mathml']), roots: z.array(webLocalIdSchema).min(1), nodes: z.array(safeMathNodeSchema).min(1).max(defaultCaptureLimits.maxMathNodes),
});
/** Flat references keep the DTO nonrecursive; a renderer rewrites fragment IDs per
 * source/translation instance. No SDK protected kind is added. */
export const safeMathAstSchema = safeMathAstShapeSchema.superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > defaultCaptureLimits.maxMathBytes) fail('Math fragment exceeds byte budget');
  const nodes = new Map(value.nodes.map(node => [node.id, node]));
  if (nodes.size !== value.nodes.length) fail('Duplicate math node ID');
  const definitions = new Set(value.nodes.flatMap(node => node.attributes.id ? [node.attributes.id] : []));
  if (definitions.size !== value.nodes.filter(node => node.attributes.id).length) fail('Duplicate math fragment definition');
  for (const node of value.nodes) {
    if (!(value.kind === 'svg' ? (svgTags as readonly string[]) : (mathTags as readonly string[])).includes(node.tag)) fail('Math namespace and tag disagree');
    for (const [key, attribute] of Object.entries(node.attributes)) {
      if (!attribute) continue;
      if (key === 'href' || key === 'xlink:href') {
        if (node.tag !== 'use' || !attribute.startsWith('#') || !definitions.has(attribute.slice(1))) fail('Math href must reference a local definition');
      }
      if (key === 'encoding' && (node.tag !== 'annotation' || attribute !== 'application/x-tex')) fail('Only plain TeX annotations are supported');
    }
    if (node.tag === 'annotation' && (node.children.length || node.attributes.encoding !== 'application/x-tex')) fail('Invalid plain TeX annotation');
  }
  const visited = new Set<string>();
  const stack = value.roots.map(id => ({ id, depth: 1 }));
  while (stack.length) {
    const current = stack.pop()!;
    const node = nodes.get(current.id);
    if (!node || visited.has(current.id) || current.depth > defaultCaptureLimits.maxDepth) { fail('Invalid math tree reference or depth'); continue; }
    visited.add(current.id);
    for (const id of node.children) stack.push({ id, depth: current.depth + 1 });
  }
  if (visited.size !== nodes.size) fail('Unreachable math nodes');
  // SVG <use> expands a second reference graph, independent of tree children.
  const definitionNodes = new Map(value.nodes.flatMap(node => node.attributes.id ? [[node.attributes.id, node.id] as const] : []));
  const active = new Set<string>();
  const complete = new Set<string>();
  const references = value.roots.map(id => ({ id, exit: false, depth: 1 }));
  while (references.length) {
    const current = references.pop()!;
    if (current.exit) { active.delete(current.id); complete.add(current.id); continue; }
    if (active.has(current.id) || current.depth > defaultCaptureLimits.maxDepth) { fail('Recursive math fragment reference or depth'); continue; }
    if (complete.has(current.id)) continue;
    const node = nodes.get(current.id);
    if (!node) continue;
    active.add(node.id);
    references.push({ ...current, exit: true });
    const href = node.attributes.href ?? node.attributes['xlink:href'];
    const target = href && definitionNodes.get(href.slice(1));
    for (const id of [...node.children, ...(target ? [target] : [])]) references.push({ id, exit: false, depth: current.depth + 1 });
  }
});
export type SafeMathAst = z.infer<typeof safeMathAstSchema>;
export const webSourceRefSchema = z.strictObject({ nodeId: webLocalIdSchema, quote: z.string(), prefix: z.string(), suffix: z.string() });
export type WebSourceRef = z.infer<typeof webSourceRefSchema>;
export const webSourceIdentitySchema = z.strictObject({
  documentId: z.uuid(), sourceVersionId: z.uuid(), manifestAssetId: z.uuid(), sha256: sha256Schema,
  bytes: z.number().int().positive(), snapshotSha256: sha256Schema,
});
export type WebSourceIdentity = z.infer<typeof webSourceIdentitySchema>;
export const webReaderAssetSchema = z.strictObject({
  id: webLocalIdSchema, path: bundlePathSchema, sha256: sha256Schema, bytes: safeNonnegativeIntegerSchema.max(defaultCaptureLimits.maxResourceBytes),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  width: z.number().int().min(1).max(defaultCaptureLimits.maxImageDimension), height: z.number().int().min(1).max(defaultCaptureLimits.maxImageDimension),
  frames: z.number().int().min(1).max(defaultCaptureLimits.maxGifFrames),
}).refine(value => value.width * value.height <= defaultCaptureLimits.maxImagePixels && value.width * value.height * value.frames <= defaultCaptureLimits.maxGifFramePixels && (value.mediaType === 'image/gif' || value.frames === 1), 'Image pixel/frame budget exceeded');
export type WebReaderAsset = z.infer<typeof webReaderAssetSchema>;
const blockBase = { id: blockIdSchema, sourceRefs: z.array(webSourceRefSchema).min(1) };
export const webReaderBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...blockBase, type: z.literal('text'), headingLevel: z.number().int().min(1).max(6).optional(), value: translationBlockSchema, bindings: z.array(readerBindingSchema), language: webLanguageDecisionSchema,
    /** Metadata binds sanitized math through an existing protected asset/literal binding. */
    safeMath: z.array(z.strictObject({ bindingId: webLocalIdSchema, ast: safeMathAstSchema })),
  }).superRefine((value, ctx) => {
    const inlines = new Map<string, InlineContent>();
    const stack = [...value.value.content];
    while (stack.length) { const inline = stack.pop()!; if (inline.type === 'text') continue; inlines.set(inline.id, inline); if (inline.type === 'format') stack.push(...inline.children); }
    const seen = new Set<string>();
    for (const math of value.safeMath) {
      const binding = value.bindings.find(item => item.id === math.bindingId);
      const inline = inlines.get(math.bindingId);
      if (seen.has(math.bindingId) || binding?.kind !== 'protected' || !['asset', 'literal'].includes(binding.object.type) || inline?.type !== 'protected' || inline.kind !== 'literal') {
        ctx.addIssue({ code: 'custom', message: 'SafeMathAst requires a unique existing protected asset/literal binding and literal inline' });
      }
      seen.add(math.bindingId);
    }
  }),
  z.strictObject({ ...blockBase, type: z.literal('image'), assetId: webLocalIdSchema, alt: z.string(), role: z.enum(['figure', 'table', 'formula', 'original-region']) }),
  z.strictObject({ ...blockBase, type: z.literal('code'), code: z.string().max(defaultCaptureLimits.maxOversizedBlockBytes), language: z.string().min(1).optional() }),
  z.strictObject({ ...blockBase, type: z.literal('math'), latex: z.string().max(65536).nullable(), ast: safeMathAstSchema.nullable(), displayMode: z.boolean(), fallbackAssetId: webLocalIdSchema.optional() })
    .refine(value => (value.latex !== null) !== (value.ast !== null), 'Math requires exactly one LaTeX or AST source'),
  z.strictObject({ ...blockBase, type: z.literal('rule') }),
]);
export type WebReaderBlock = z.infer<typeof webReaderBlockSchema>;
const nodeBase = { id: nodeIdSchema, children: z.array(nodeIdSchema), presentation: z.strictObject({ align: z.enum(['left', 'center', 'right', 'justify']).optional() }).optional() };
export const webReaderNodeSchema = z.union([
  readerNodeSchema,
  z.strictObject({ ...nodeBase, kind: z.literal('table'), captionBlockId: blockIdSchema.nullable() }),
  z.strictObject({ ...nodeBase, kind: z.literal('table-row') }),
  z.strictObject({ ...nodeBase, kind: z.literal('table-cell'), header: z.boolean(), rowSpan: z.number().int().min(1).max(1000), colSpan: z.number().int().min(1).max(1000), scope: z.enum(['row', 'col', 'rowgroup', 'colgroup']).nullable(), headerNodeIds: z.array(nodeIdSchema) }),
]);
export type WebReaderNode = z.infer<typeof webReaderNodeSchema>;
export const webReaderIrShapeSchema = z.strictObject({
  schemaVersion: z.literal('web-reader-ir/1'), metadata: z.strictObject({ title: z.string().min(1), language: webLanguageDecisionSchema }),
  source: z.strictObject({ kind: z.literal('web'), manifestSha256: sha256Schema, snapshotSha256: sha256Schema, bytes: z.number().int().positive() }),
  parse: z.strictObject({ id: parseIdSchema, inputManifestSha256: sha256Schema, projectorVersion: z.string().min(1), configSha256: sha256Schema, coverage: parseCoverageSchema, status: z.enum(['complete', 'partial']) }),
  roots: z.array(nodeIdSchema), nodes: z.array(webReaderNodeSchema).max(defaultCaptureLimits.maxDomNodes),
  blocks: z.array(webReaderBlockSchema).max(defaultCaptureLimits.maxBlocks), assets: z.array(webReaderAssetSchema).max(defaultCaptureLimits.maxFiles), warnings: z.array(z.string().min(1)),
});
export const webReaderIrSchema = withJsonDepthLimit(webReaderIrShapeSchema.superRefine((value, ctx) => {
  for (const [label, items] of [['node', value.nodes], ['block', value.blocks], ['asset', value.assets]] as const) {
    if (new Set(items.map(item => item.id)).size !== items.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${label} ID` });
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > defaultCaptureLimits.maxIrBytes) ctx.addIssue({ code: 'custom', message: 'IR exceeds byte budget' });
}));
export type WebReaderIR = z.infer<typeof webReaderIrSchema>;
export const webReaderChunkBlockSchema = z.strictObject({
  source: webReaderBlockSchema, translation: translationBlockSchema.nullable(),
  sourceOnlyReason: z.enum(['language-not-required', 'manual-choice', 'pending', 'failed', 'cancelled']).nullable(),
});
export type WebReaderChunkBlock = z.infer<typeof webReaderChunkBlockSchema>;
export const webReaderChunkIdSchema = z.string().regex(/^c_(?!000000)[0-9]{6}$/);
export const webReaderChunkShapeSchema = z.strictObject({
  id: webReaderChunkIdSchema, parseId: parseIdSchema, sourceSha256: sha256Schema,
  contextBlockIds: z.array(blockIdSchema).max(defaultCaptureLimits.maxChunkBlocks),
  blocks: z.array(webReaderChunkBlockSchema).max(defaultCaptureLimits.maxChunkBlocks), nodes: z.array(webReaderNodeSchema).max(defaultCaptureLimits.maxDomNodes),
  roots: z.array(nodeIdSchema), assets: z.array(webReaderAssetSchema).max(defaultCaptureLimits.maxFiles),
});
export const webReaderChunkSchema = withJsonDepthLimit(webReaderChunkShapeSchema.refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= (value.blocks.length === 1 ? defaultCaptureLimits.maxOversizedBlockBytes : defaultCaptureLimits.maxChunkBytes), 'Chunk exceeds byte budget'));
export type WebReaderChunk = z.infer<typeof webReaderChunkSchema>;
export const webReaderIndexShapeSchema = z.strictObject({
  parseId: parseIdSchema, sourceSha256: sha256Schema,
  chunks: z.array(z.strictObject({ id: webReaderChunkIdSchema, blockIds: z.array(blockIdSchema).max(defaultCaptureLimits.maxChunkBlocks), bytes: safeNonnegativeIntegerSchema.max(defaultCaptureLimits.maxOversizedBlockBytes) })),
  toc: z.array(z.strictObject({ nodeId: nodeIdSchema, parentId: nodeIdSchema.nullable(), blockId: blockIdSchema, title: z.string(), depth: z.number().int().min(1).max(defaultCaptureLimits.maxDepth) })),
  blockLocations: z.record(blockIdSchema, z.strictObject({ chunkId: webReaderChunkIdSchema, nodeId: webLocalIdSchema, previewId: webLocalIdSchema.nullable() })),
  language: webLanguageDecisionSchema, translationStatus: readerTranslationStatusSchema, generationKind: webGenerationKindSchema,
  assetIds: z.array(webLocalIdSchema), warnings: z.array(z.string().min(1)),
});
export const webReaderIndexSchema = withJsonDepthLimit(webReaderIndexShapeSchema);
export type WebReaderIndex = z.infer<typeof webReaderIndexSchema>;
export const webReaderDescriptorShapeSchema = z.strictObject({
  documentId: z.uuid(), versionId: z.uuid(), source: webSourceIdentitySchema, parseId: parseIdSchema,
  index: webReaderIndexShapeSchema, assetMap: z.record(webLocalIdSchema, z.uuid()).refine(value => Object.keys(value).length <= defaultCaptureLimits.maxFiles, 'Asset map limit').meta({ maxProperties: defaultCaptureLimits.maxFiles }), snapshots: snapshotPreviewIndexSchema,
  translationStatus: readerTranslationStatusSchema, warnings: z.array(z.string().min(1)), progress: webReadingProgressSchema.nullable(), restoreHint: z.literal('version-updated-source-start').nullable(),
});
// Zod records intentionally drop __proto__. Local resource IDs are arbitrary data,
// so validate all own entries explicitly and restore a safe dictionary after shape parsing.
export const webReaderDescriptorSchema = withJsonDepthLimit(z.unknown().transform((input, context) => {
  const result = webReaderDescriptorShapeSchema.safeParse(input);
  if (!result.success) { context.issues.push({ code: 'custom', input, message: 'Invalid Web Reader descriptor' }); return z.NEVER; }
  const raw = (input as { assetMap: Record<string, unknown> }).assetMap;
  if (Object.keys(raw).length > defaultCaptureLimits.maxFiles) { context.issues.push({ code: 'custom', input, message: 'Web asset map limit' }); return z.NEVER; }
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(raw)) {
    const id = webLocalIdSchema.safeParse(key), asset = z.uuid().safeParse(value);
    if (!id.success || !asset.success) { context.issues.push({ code: 'custom', input, message: 'Invalid Web asset mapping' }); return z.NEVER; }
    entries.push([id.data, asset.data]);
  }
  result.data.assetMap = Object.fromEntries(entries);
  return result.data;
}));
export type WebReaderDescriptor = z.infer<typeof webReaderDescriptorSchema>;
