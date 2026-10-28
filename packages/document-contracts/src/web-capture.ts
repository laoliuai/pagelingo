import { z } from 'zod';
import { translationBlockSchema } from '@pagelingo/translation-core';
import { sourceLanguageSchema } from './language.js';
import { bundlePathSchema, safeNonnegativeIntegerSchema, sha256Schema, withJsonDepthLimit } from './reader-common.js';

const MiB = 1024 * 1024;
export const captureLimitsSchema = z.strictObject({
  maxHtmlBytes: z.number().int().positive().max(8 * MiB), maxResourceBytes: z.number().int().positive().max(16 * MiB),
  maxTotalBytes: z.number().int().positive().max(64 * MiB), maxFiles: z.number().int().positive().max(256),
  maxResourceOrigins: z.number().int().positive().max(16), maxDomNodes: z.number().int().positive().max(50000),
  maxDepth: z.number().int().positive().max(64), maxBlocks: z.number().int().positive().max(20000),
  maxIrBytes: z.number().int().positive().max(16 * MiB), maxImageDimension: z.number().int().positive().max(16384),
  maxImagePixels: z.number().int().positive().max(32000000), maxGifFrames: z.number().int().positive().max(128),
  maxGifFramePixels: z.number().int().positive().max(64000000), maxMathNodes: z.number().int().positive().max(4096),
  maxMathBytes: z.number().int().positive().max(64 * 1024), maxChunkBlocks: z.number().int().positive().max(128),
  maxChunkBytes: z.number().int().positive().max(256 * 1024), maxOversizedBlockBytes: z.number().int().positive().max(512 * 1024),
  maxPreviewBlocks: z.number().int().positive().max(128), maxPreviewHtmlBytes: z.number().int().positive().max(512 * 1024),
  maxPreviewResourceBytes: z.number().int().positive().max(32 * MiB), requestTimeoutMs: z.number().int().positive().max(20000),
  maxRedirects: z.number().int().nonnegative().max(5), outboxInitialBackoffMs: z.number().int().positive(),
  outboxMaxBackoffMs: z.number().int().positive().max(300000), outboxMaxAttempts: z.number().int().positive().max(5),
});
export type CaptureLimits = z.infer<typeof captureLimitsSchema>;
export const defaultCaptureLimits: Readonly<CaptureLimits> = Object.freeze({
  maxHtmlBytes: 8 * MiB, maxResourceBytes: 16 * MiB, maxTotalBytes: 64 * MiB, maxFiles: 256,
  maxResourceOrigins: 16, maxDomNodes: 50000, maxDepth: 64, maxBlocks: 20000, maxIrBytes: 16 * MiB,
  maxImageDimension: 16384, maxImagePixels: 32000000, maxGifFrames: 128, maxGifFramePixels: 64000000,
  maxMathNodes: 4096, maxMathBytes: 64 * 1024, maxChunkBlocks: 128, maxChunkBytes: 256 * 1024,
  maxOversizedBlockBytes: 512 * 1024, maxPreviewBlocks: 128, maxPreviewHtmlBytes: 512 * 1024,
  maxPreviewResourceBytes: 32 * MiB, requestTimeoutMs: 20000, maxRedirects: 5,
  outboxInitialBackoffMs: 2000, outboxMaxBackoffMs: 300000, outboxMaxAttempts: 5,
});
export const webLocalIdSchema = z.string().min(1).max(240);
/** Validate only: tracking parameter removal belongs to the capture adapter. */
export const captureUrlSchema = z.string().max(8192).regex(/^https?:\/\/(?![^/?#]*@)[^/?#\s\x00-\x1f\x7f]+[^\s\x00-\x1f\x7f]*$/)
  .refine(value => { try { const url = new URL(value); return !!url.hostname && !url.username && !url.password; } catch { return false; } }, 'Invalid HTTP/HTTPS URL');
/** Resource locators are evidence, never navigation or generic outbound-fetch targets. */
// A locator must itself fit the existing 16 MiB JSON transport budget. This
// also bounds decoded data below maxResourceBytes. Explicit character groups
// avoid V8's recursive counted-group path for multi-megabyte base64 strings.
const dataImageUrlSchema = z.string().max(defaultCaptureLimits.maxIrBytes)
  .regex(/^data:image\/(?:png|jpeg|webp|gif);base64,(?=[A-Za-z0-9+/])(?:[A-Za-z0-9+/][A-Za-z0-9+/][A-Za-z0-9+/][A-Za-z0-9+/])*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/][A-Za-z0-9+/][AEIMQUYcgkosw048]=)?$/);
const blobImageUrlSchema = z.string().max(8192)
  .regex(/^blob:https?:\/\/(?![^/?#]*@)[^/?#\s\x00-\x1f\x7f]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .refine(value => captureUrlSchema.safeParse(value.slice(5)).success, 'Invalid blob origin');
export const captureResourceUrlSchema = z.union([captureUrlSchema, dataImageUrlSchema, blobImageUrlSchema]);
export const captureScopeSchema = z.strictObject({
  kind: z.enum(['article', 'x-post', 'answer']), rootNodeId: webLocalIdSchema,
  completeWithinScope: z.boolean(), warnings: z.array(z.string().min(1)),
}).refine(value => value.completeWithinScope || value.warnings.length > 0, 'Incomplete scope requires an explanation');
export type CaptureScope = z.infer<typeof captureScopeSchema>;
export const captureFileSchema = z.strictObject({
  id: webLocalIdSchema, path: bundlePathSchema, bytes: safeNonnegativeIntegerSchema.max(defaultCaptureLimits.maxResourceBytes), sha256: sha256Schema,
  mediaType: z.string().min(1).max(120), role: z.enum(['html', 'image', 'css', 'translation', 'preview']),
}).refine(value => value.role === 'image' ? ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.mediaType)
  : value.role === 'html' || value.role === 'preview' ? value.mediaType === 'text/html'
  : value.role === 'css' ? value.mediaType === 'text/css' : value.mediaType === 'application/json', 'File media type does not match its role');
export type CaptureFile = z.infer<typeof captureFileSchema>;
const resourceIdentity = { id: webLocalIdSchema };
const missingResourceReason = z.enum(['unavailable', 'unsupported', 'blocked', 'too-large', 'timeout', 'not-loaded', 'invalid']);
const missingResource = { status: z.literal('missing'), reason: missingResourceReason };
const availableResource = { status: z.literal('available'), fileId: webLocalIdSchema };
const inlineStylesheetIdentity = {
  ...resourceIdentity, role: z.literal('css'), url: z.null(),
  provenance: z.strictObject({
    kind: z.literal('inline-style'),
    documentUrl: captureUrlSchema.refine(value => {
      try {
        const url = new URL(value);
        return url.href === value && ![...url.searchParams.keys()].some(key => /^(?:utm_.*|fbclid|gclid|msclkid)$/i.test(key));
      } catch { return false; }
    }, 'Inline stylesheet requires the normalized captured source URL'),
    index: safeNonnegativeIntegerSchema,
  }),
};
export const captureResourceSchema = z.union([
  z.strictObject({ ...resourceIdentity, url: captureResourceUrlSchema, role: z.literal('image'), ...availableResource }),
  z.strictObject({ ...resourceIdentity, url: captureResourceUrlSchema, role: z.literal('image'), ...missingResource }),
  z.strictObject({ ...resourceIdentity, url: captureUrlSchema, role: z.literal('css'), ...availableResource }),
  z.strictObject({ ...resourceIdentity, url: captureUrlSchema, role: z.literal('css'), ...missingResource }),
  z.strictObject({ ...inlineStylesheetIdentity, ...availableResource }),
  z.strictObject({ ...inlineStylesheetIdentity, ...missingResource }),
]);
export type CaptureResource = z.infer<typeof captureResourceSchema>;
export const snapshotPreviewSchema = z.strictObject({
  id: webLocalIdSchema, fileId: webLocalIdSchema, nodeIds: z.array(webLocalIdSchema).max(defaultCaptureLimits.maxDomNodes),
  blockIds: z.array(z.string().min(1)).max(defaultCaptureLimits.maxPreviewBlocks),
  resourceFileIds: z.array(webLocalIdSchema).max(defaultCaptureLimits.maxFiles),
  htmlBytes: safeNonnegativeIntegerSchema.max(defaultCaptureLimits.maxPreviewHtmlBytes),
  resourceBytes: safeNonnegativeIntegerSchema.max(defaultCaptureLimits.maxPreviewResourceBytes),
});
export type SnapshotPreview = z.infer<typeof snapshotPreviewSchema>;
export const snapshotPreviewIndexSchema = z.strictObject({
  previews: z.array(snapshotPreviewSchema),
  nodeLocations: z.record(webLocalIdSchema, z.strictObject({ previewId: webLocalIdSchema, anchorId: webLocalIdSchema })),
});
export type SnapshotPreviewIndex = z.infer<typeof snapshotPreviewIndexSchema>;
/** Candidate file payload, independent of server-generated parse/IR identities.
 * Exporters supply the original source block and the complete SDK result after
 * glossary restoration: rawText must validate against encodeBlock(source), never
 * translated DOM HTML or a model-provided format tree. Consumers compare the
 * server-projected source/protected input, verify hashes and replay public SDK
 * validateStructure/decodeTranslation. Unknown versions/mismatches skip only the
 * candidate with a warning, preserving the archived source. */
export const captureTranslationCandidateBlockSchema = z.strictObject({
  nodeId: webLocalIdSchema,
  sourceTextSha256: sha256Schema.describe('SHA-256 of UTF-8 naturalText(source.content), without whitespace normalization.'),
  source: translationBlockSchema,
  rawText: z.string().min(1).max(defaultCaptureLimits.maxOversizedBlockBytes)
    .refine(value => new TextEncoder().encode(value).byteLength <= defaultCaptureLimits.maxOversizedBlockBytes, 'Candidate result exceeds UTF-8 byte budget'),
});
export type CaptureTranslationCandidateBlock = z.infer<typeof captureTranslationCandidateBlockSchema>;
export const webCaptureTranslationCandidateShapeSchema = z.strictObject({
  schemaVersion: z.literal('web-capture-translation-candidate/1'),
  sourceSnapshotSha256: sha256Schema, sourceContentFingerprint: sha256Schema,
  sourceLanguage: sourceLanguageSchema.nullable(), targetLanguage: sourceLanguageSchema,
  sdkVersion: z.string().min(1).max(100), promptVersion: z.string().min(1).max(100), protectionVersion: z.string().min(1).max(100),
  blocks: z.array(captureTranslationCandidateBlockSchema).min(1).max(defaultCaptureLimits.maxBlocks),
});
function validateCandidateBounds(value: { blocks: ReadonlyArray<{ nodeId: string; source: { id: string } }> }, ctx: z.RefinementCtx): void {
  if (new Set(value.blocks.map(block => block.nodeId)).size !== value.blocks.length || new Set(value.blocks.map(block => block.source.id)).size !== value.blocks.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate candidate source node or block ID' });
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > defaultCaptureLimits.maxResourceBytes) {
    ctx.addIssue({ code: 'custom', message: 'Candidate file exceeds byte budget' });
  }
}
export const webCaptureTranslationCandidateSchema = withJsonDepthLimit(webCaptureTranslationCandidateShapeSchema.superRefine(validateCandidateBounds));
export type WebCaptureTranslationCandidate = z.infer<typeof webCaptureTranslationCandidateSchema>;

export const captureExistingTranslationSchema = z.strictObject({
  fileId: webLocalIdSchema, sourceSnapshotSha256: sha256Schema, sourceContentFingerprint: sha256Schema,
  targetLanguage: z.string().min(1).max(40),
});
export const webCaptureManifestShapeSchema = z.strictObject({
  schemaVersion: z.literal('web-capture/1'), captureId: z.uuid(),
  source: z.strictObject({ url: captureUrlSchema, canonicalUrl: captureUrlSchema.nullable(), kind: z.enum(['article', 'x-post', 'answer']), method: z.enum(['extension', 'public-fetch']) }),
  metadata: z.strictObject({ title: z.string().min(1).max(2000), author: z.string().max(2000).nullable(), publishedAt: z.iso.datetime().nullable(), capturedAt: z.iso.datetime() }),
  scope: captureScopeSchema, htmlFileId: webLocalIdSchema,
  files: z.array(captureFileSchema).min(1).max(defaultCaptureLimits.maxFiles),
  resources: z.array(captureResourceSchema).max(defaultCaptureLimits.maxDomNodes), stylesheetFileIds: z.array(webLocalIdSchema),
  snapshots: snapshotPreviewIndexSchema, existingTranslation: captureExistingTranslationSchema.nullable(),
});
/** Cross-file closure is checked in addition to the generated portable shape. Actual
 * bytes, hashes, DOM IDs and image decoding remain adapter validation responsibilities. */
export const webCaptureManifestSchema = withJsonDepthLimit(webCaptureManifestShapeSchema.superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const files = new Map(value.files.map(file => [file.id, file]));
  if (files.size !== value.files.length || new Set(value.files.map(file => file.path)).size !== value.files.length) fail('Duplicate file ID or path');
  if (new Set(value.resources.map(resource => resource.id)).size !== value.resources.length) fail('Duplicate resource ID');
  if (value.source.kind !== value.scope.kind) fail('Source and scope kinds must agree');
  if (value.files.reduce((sum, file) => sum + file.bytes, 0) > defaultCaptureLimits.maxTotalBytes) fail('Capture exceeds total byte budget');
  const origins = new Set<string>();
  for (const resource of value.resources) {
    try {
      if (resource.url === null) {
        if (resource.provenance.documentUrl !== value.source.url) fail('Inline stylesheet belongs to another captured source');
        continue;
      }
      if (resource.role === 'css' && !captureUrlSchema.safeParse(resource.url).success) fail('CSS requires HTTP/HTTPS');
      if (resource.url.startsWith('blob:') && new URL(resource.url).origin !== new URL(value.source.url).origin) fail('Blob resource belongs to another source origin');
      if (!resource.url.startsWith('data:')) origins.add(new URL(resource.url).origin);
    } catch { fail('Invalid resource URL'); }
  }
  if (origins.size > defaultCaptureLimits.maxResourceOrigins) fail('Too many resource origins');
  const declared = new Set<string>();
  const use = (id: string, role?: CaptureFile['role']) => { const file = files.get(id); if (!file || (role && file.role !== role)) fail(`Missing or mismatched file: ${id}`); declared.add(id); return file; };
  const html = use(value.htmlFileId, 'html');
  if (html && (html.bytes > defaultCaptureLimits.maxHtmlBytes || html.mediaType !== 'text/html')) fail('Invalid HTML file');
  for (const resource of value.resources) if (resource.status === 'available') {
    const file = use(resource.fileId);
    if (file && file.role !== resource.role) fail('Resource role must match its image or archived CSS file');
  }
  for (const id of value.stylesheetFileIds) use(id, 'css');
  if (value.existingTranslation) use(value.existingTranslation.fileId, 'translation');
  const previews = new Map(value.snapshots.previews.map(preview => [preview.id, preview]));
  if (previews.size !== value.snapshots.previews.length) fail('Duplicate preview ID');
  for (const preview of previews.values()) {
    const file = use(preview.fileId, 'preview');
    if (file && (file.bytes !== preview.htmlBytes || file.mediaType !== 'text/html')) fail('Preview HTML bytes or media type mismatch');
    let bytes = 0;
    for (const id of preview.resourceFileIds) bytes += use(id, 'image')?.bytes ?? 0;
    if (bytes !== preview.resourceBytes) fail('Preview resource bytes mismatch');
    if (new Set(preview.nodeIds).size !== preview.nodeIds.length || new Set(preview.blockIds).size !== preview.blockIds.length || new Set(preview.resourceFileIds).size !== preview.resourceFileIds.length) fail('Duplicate preview reference');
  }
  for (const [nodeId, location] of Object.entries(value.snapshots.nodeLocations)) {
    if (!previews.get(location.previewId)?.nodeIds.includes(nodeId)) fail('Snapshot node references missing preview');
  }
  if (declared.size !== files.size) fail('Undeclared file');
}));
export type WebCaptureManifest = z.infer<typeof webCaptureManifestSchema>;

/** Serializable collector output; adapters fetch pending resources and finalize file hashes. */
export const pendingCaptureResourceSchema = z.union([
  z.strictObject({ id: webLocalIdSchema, url: captureResourceUrlSchema, role: z.literal('image') }),
  z.strictObject({ id: webLocalIdSchema, url: captureUrlSchema, role: z.literal('css'), missingReason: missingResourceReason.optional() }),
  z.strictObject({ ...inlineStylesheetIdentity, text: z.string().max(defaultCaptureLimits.maxResourceBytes)
    .refine(value => new TextEncoder().encode(value).byteLength <= defaultCaptureLimits.maxResourceBytes, 'Stylesheet exceeds UTF-8 byte budget') }),
  z.strictObject({ ...inlineStylesheetIdentity, missingReason: missingResourceReason }),
]);
export type PendingCaptureResource = z.infer<typeof pendingCaptureResourceSchema>;
const snapshotHtmlSchema = z.string().max(defaultCaptureLimits.maxHtmlBytes).refine(value => new TextEncoder().encode(value).byteLength <= defaultCaptureLimits.maxHtmlBytes, 'HTML exceeds UTF-8 byte budget');
export const snapshotInputSchema = z.strictObject({ html: snapshotHtmlSchema, url: captureUrlSchema, scope: captureScopeSchema });
export type SnapshotInput = z.infer<typeof snapshotInputSchema>;
export const sanitizedSnapshotSchema = z.strictObject({
  html: snapshotHtmlSchema, sourceUrl: captureUrlSchema, scope: captureScopeSchema,
  nodeIds: z.array(webLocalIdSchema).max(defaultCaptureLimits.maxDomNodes), resources: z.array(pendingCaptureResourceSchema), warnings: z.array(z.string().min(1)),
});
export type SanitizedSnapshot = z.infer<typeof sanitizedSnapshotSchema>;
/** Drafts precede resource acquisition; only final upload candidates have a fingerprint. */
export const captureDraftTranslationCandidateSchema = withJsonDepthLimit(webCaptureTranslationCandidateShapeSchema.extend({ sourceContentFingerprint: sha256Schema.nullable() }).superRefine(validateCandidateBounds));
export type CaptureDraftTranslationCandidate = z.infer<typeof captureDraftTranslationCandidateSchema>;
export const captureDraftSchema = z.strictObject({
  captureId: z.uuid(), snapshot: sanitizedSnapshotSchema,
  metadata: webCaptureManifestShapeSchema.shape.metadata, canonicalUrl: captureUrlSchema.nullable(),
  kind: z.enum(['article', 'x-post', 'answer']), pendingResources: z.array(pendingCaptureResourceSchema),
  existingTranslation: captureDraftTranslationCandidateSchema.nullable(),
}).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= defaultCaptureLimits.maxIrBytes, 'Capture draft exceeds JSON transport budget')
  .refine(value => [...value.snapshot.resources, ...value.pendingResources].every(resource => resource.url !== null || resource.provenance.documentUrl === value.snapshot.sourceUrl), 'Inline stylesheet belongs to another captured source');
export type CaptureDraft = z.infer<typeof captureDraftSchema>;
