import { z } from 'zod';
import { documentSummarySchema } from './documents.js';
import { safeNonnegativeIntegerSchema, safePositiveIntegerSchema } from './reader-common.js';

export const documentKindSchema = z.enum(['pdf', 'article', 'x-post', 'repository', 'paper']);
export type DocumentKind = z.infer<typeof documentKindSchema>;
export const documentOriginSchema = z.enum(['upload', 'web', 'x', 'zhihu', 'wechat', 'github', 'arxiv']);
export type DocumentOrigin = z.infer<typeof documentOriginSchema>;
export const readingStatusSchema = z.enum(['unread', 'reading', 'read']);
export type ReadingStatus = z.infer<typeof readingStatusSchema>;

/** JSON Schema uniqueItems checks exact strings; runtime additionally compares UUID identity
 * case-insensitively while retaining the caller's spelling. */
const uniqueIds = (maximum: number) => z.array(z.uuid()).max(maximum)
  .refine(value => new Set(value.map(id => id.toLowerCase())).size === value.length, 'IDs must be unique')
  .meta({ uniqueItems: true });
export const documentTagIdsSchema = uniqueIds(32);
export const saveOrganizationSchema = z.strictObject({
  collectionId: z.uuid().nullable(), tagIds: documentTagIdsSchema,
});
export type SaveOrganization = z.infer<typeof saveOrganizationSchema>;
/** Optional hints deliberately have no defaults: omitted hints retain legacy request identities. */
export const documentSaveHintsShape = {
  organization: saveOrganizationSchema.optional(), discoveredFromDocumentId: z.uuid().optional(),
};

export const documentOrganizationSchema = z.strictObject({
  documentId: z.uuid(), revision: safeNonnegativeIntegerSchema,
  /** Independent lifecycle fence, initially 1; never supplied in a metadata PATCH. */
  lifecycleEpoch: safePositiveIntegerSchema,
  title: z.string().min(1), collectionId: z.uuid().nullable(), tagIds: documentTagIdsSchema,
  note: z.string().max(10000), readingStatus: readingStatusSchema, updatedAt: z.iso.datetime(),
});
export type DocumentOrganization = z.infer<typeof documentOrganizationSchema>;
export const patchDocumentOrganizationSchema = z.strictObject({
  expectedRevision: safeNonnegativeIntegerSchema,
  title: z.string().min(1).max(500).optional(), collectionId: z.uuid().nullable().optional(),
  tagIds: documentTagIdsSchema.optional(), note: z.string().max(10000).optional(), readingStatus: readingStatusSchema.optional(),
}).refine(value => Object.entries(value).some(([key, value]) => key !== 'expectedRevision' && value !== undefined), 'At least one changed field is required')
  .meta({ minProperties: 2 });
export type PatchDocumentOrganization = z.infer<typeof patchDocumentOrganizationSchema>;

const pageSchema = z.number().int().min(1).max(1000000);
const pageSizeSchema = z.number().int().min(1).max(100);
const queryTagsSchema = uniqueIds(16);
/** Wire strings are bounded before conversion so portable validation matches normalization. */
export const libraryQueryShapeSchema = z.strictObject({
  page: z.union([pageSchema, z.string().regex(/^0*(?:[1-9][0-9]{0,5}|1000000)$/)]).default(1),
  pageSize: z.union([pageSizeSchema, z.string().regex(/^0*(?:[1-9][0-9]?|100)$/)]).default(20),
  q: z.string().max(200).optional(), kind: documentKindSchema.optional(), origin: documentOriginSchema.optional(),
  readingStatus: readingStatusSchema.optional(), collectionId: z.union([z.uuid(), z.literal('none')]).optional(),
  tagIds: z.union([z.uuid(), queryTagsSchema]).optional(),
});
export const libraryQuerySchema = libraryQueryShapeSchema.transform(({ page, pageSize, tagIds, ...rest }) => ({
  ...rest, page: Number(page), pageSize: Number(pageSize),
  ...(tagIds === undefined ? {} : { tagIds: typeof tagIds === 'string' ? [tagIds] : tagIds }),
}));
export type LibraryQuery = z.infer<typeof libraryQuerySchema>;
export const libraryPageSchema = z.strictObject({
  items: z.array(z.strictObject({ document: documentSummarySchema, organization: documentOrganizationSchema, origin: documentOriginSchema })).max(100),
  total: safeNonnegativeIntegerSchema, page: pageSchema, pageSize: pageSizeSchema,
});
export type LibraryPage = z.infer<typeof libraryPageSchema>;
