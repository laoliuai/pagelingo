import { z } from 'zod';
import { captureUrlSchema } from './web-capture.js';
import { safeNonnegativeIntegerSchema, safePositiveIntegerSchema, sha256Schema } from './reader-common.js';
import { webJobStatusSchema } from './web-jobs.js';

const sourceRefSchema = z.string().min(1).max(200);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const arxivBaseIdSchema = z.string().regex(/^(?:[0-9]{4}\.[0-9]{4,5}|[a-zA-Z][a-zA-Z0-9.-]*\/[0-9]{7})$/);
export const sourceAssetInfoSchema = z.strictObject({
  assetId: z.uuid(), sha256: sha256Schema, bytes: safeNonnegativeIntegerSchema,
  mediaType: z.string().min(1), filename: z.string().min(1),
});
export type SourceAssetInfo = z.infer<typeof sourceAssetInfoSchema>;
export const githubSourceRevisionSchema = z.strictObject({
  kind: z.literal('github'), id: z.uuid(), sourceVersionId: z.uuid().nullable(),
  repository: z.strictObject({ id: z.string().regex(/^[1-9][0-9]*$/), owner: z.string().min(1), name: z.string().min(1), description: z.string().nullable(), url: captureUrlSchema }),
  commitSha: gitShaSchema.nullable(),
  readme: z.strictObject({ path: z.string().min(1), blobSha: gitShaSchema, raw: sourceAssetInfoSchema, renderedHtml: sourceAssetInfoSchema.nullable() }).nullable(),
  capturedAt: z.iso.datetime(),
});
export type GithubSourceRevision = z.infer<typeof githubSourceRevisionSchema>;
export const arxivSourceRevisionSchema = z.strictObject({
  kind: z.literal('arxiv'), id: z.uuid(), baseId: arxivBaseIdSchema, version: safePositiveIntegerSchema,
  title: z.string().min(1), authors: z.array(z.string().min(1)).max(1000), summary: z.string().max(20000),
  publishedAt: z.iso.datetime(), updatedAt: z.iso.datetime(), capturedAt: z.iso.datetime(),
  sourceVersionId: z.uuid().nullable(), pdf: sourceAssetInfoSchema.nullable(),
});
export type ArxivSourceRevision = z.infer<typeof arxivSourceRevisionSchema>;
export const sourceRevisionSchema = z.discriminatedUnion('kind', [githubSourceRevisionSchema, arxivSourceRevisionSchema]);
export type SourceRevision = z.infer<typeof sourceRevisionSchema>;
export const sourceLatestAttemptSchema = z.strictObject({
  jobId: z.uuid(), status: webJobStatusSchema, requestedRef: sourceRefSchema.nullable(),
  resolvedRevision: z.string().min(1).nullable(), errorCode: z.string().min(1).nullable(),
});
export type SourceLatestAttempt = z.infer<typeof sourceLatestAttemptSchema>;
const sourceDetailsShape = {
  documentId: z.uuid(), url: captureUrlSchema, resolution: z.enum(['self', 'alias', 'conflict']),
  canonicalDocumentId: z.uuid().nullable(), fetchJobId: z.uuid().nullable(),
  status: z.enum(['link-only', 'metadata-saved', 'source-saved', 'partial-resources', 'fetch-failed']),
  errorCode: z.string().min(1).nullable(), warnings: z.array(z.string().min(1)), latestAttempt: sourceLatestAttemptSchema.nullable(),
};
export const sourceDetailsSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...sourceDetailsShape, kind: z.literal('link') }),
  z.strictObject({ ...sourceDetailsShape, kind: z.literal('github'), current: githubSourceRevisionSchema.nullable() }),
  z.strictObject({ ...sourceDetailsShape, kind: z.literal('arxiv'), current: arxivSourceRevisionSchema.nullable() }),
]);
export type SourceDetails = z.infer<typeof sourceDetailsSchema>;
export const sourceRefreshRequestSchema = z.strictObject({ ref: sourceRefSchema.optional(), translationIntent: z.enum(['auto', 'none']) });
export type SourceRefreshRequest = z.infer<typeof sourceRefreshRequestSchema>;
export const sourceReferenceSchema = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('github'), owner: z.string().min(1), repo: z.string().min(1), requestedRef: sourceRefSchema.optional(), url: captureUrlSchema }),
  z.strictObject({ provider: z.literal('arxiv'), baseId: arxivBaseIdSchema, version: safePositiveIntegerSchema.nullable(), url: captureUrlSchema }),
]);
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
const queryNumberSchema = z.union([z.number(), z.string().regex(/^[0-9]+$/)]).pipe(z.coerce.number());
export const sourceVersionsQuerySchema = z.strictObject({ cursor: z.uuid().optional(), limit: queryNumberSchema.pipe(z.number().int().min(1).max(50)).default(20) });
export type SourceVersionsQuery = z.infer<typeof sourceVersionsQuerySchema>;
export const sourceVersionsSchema = z.strictObject({ items: z.array(sourceRevisionSchema).max(50), nextCursor: z.uuid().nullable() });
export type SourceVersions = z.infer<typeof sourceVersionsSchema>;
