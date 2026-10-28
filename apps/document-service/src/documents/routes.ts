import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { documentListQuerySchema } from '@pagelingo/document-contracts';
import { requireSession, requireWriteRequest } from '../auth/guards.js';
import { ServiceError } from '../errors.js';
import type { ObjectStore } from '../storage/object-store.js';
import { createDocumentsService } from './service.js';
import { sendSource } from './source-response.js';

function invalid(): ServiceError { return new ServiceError(400, 'INVALID_REQUEST', 'Invalid document request'); }
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw invalid(); return result.data; }
function id(request: FastifyRequest): string { return parse(z.strictObject({ id: z.uuid() }), request.params).id; }
const sourceQuery = z.strictObject({ download: z.enum(['true', 'false']).optional() });

export function registerDocumentsRoutes(app: FastifyInstance, store: ObjectStore): void {
  const { db, config } = app.authContext;
  const service = createDocumentsService({ db, store, maxPdfBytes: config.maxPdfBytes });
  // Errors, denied reads, and HEAD responses are private too.
  app.addHook('onRequest', async (request, reply) => {
    if (/^\/api\/v1\/(documents|assets)(\/|\?|$)/.test(request.url)) reply.header('Cache-Control', 'no-store');
  });
  app.post('/api/v1/documents/pdf', async (request, reply) => {
    const actor = await requireSession(request); await requireWriteRequest(request, actor);
    parse(z.strictObject({}), request.query);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key)) throw invalid();
    if (!request.isMultipart()) throw new ServiceError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected multipart/form-data');
    const parts = request.parts({ limits: { fileSize: config.maxPdfBytes, files: 1, parts: 4, fields: 3, fieldSize: 2000 } });
    let title: string | undefined;
    function field(part: { type: string; fieldname: string; value?: unknown; valueTruncated?: boolean; fieldnameTruncated?: boolean }) {
      if (part.type !== 'field' || part.fieldname !== 'title' || title !== undefined || typeof part.value !== 'string' || part.valueTruncated || part.fieldnameTruncated) throw invalid();
      title = parse(z.string().trim().min(1).max(500), part.value);
    }
    try {
      for await (const part of parts) {
        if (part.type === 'field') { field(part); continue; }
        if (part.fieldname !== 'file') { part.file.resume(); throw invalid(); }
        const file = part.file;
        async function* body() {
          yield* file;
          if (file.truncated) throw new ServiceError(413, 'PDF_TOO_LARGE', 'PDF exceeds the upload limit');
        }
        const document = await service.savePdf(actor, { idempotencyKey: key, originalFilename: part.filename, body: body(),
          finalize: async () => {
            for await (const trailing of parts) {
              if (trailing.type === 'file') { trailing.file.resume(); throw invalid(); }
              field(trailing);
            }
            return title === undefined ? {} : { title };
          },
        });
        return reply.code(201).send(document);
      }
      throw invalid();
    } catch (error) {
      if (error instanceof Error && ['FST_FILES_LIMIT', 'FST_FIELDS_LIMIT', 'FST_PARTS_LIMIT'].includes((error as { code?: string }).code ?? '')) throw invalid();
      throw error;
    }
  });
  app.get('/api/v1/documents', async request => service.list(await requireSession(request), parse(documentListQuerySchema, request.query)));
  app.get('/api/v1/documents/:id', async request => {
    const document = await service.get(await requireSession(request), id(request));
    parse(z.strictObject({}), request.query);
    return document;
  });
  app.get('/api/v1/documents/:id/source', async (request, reply) => {
    const actor = await requireSession(request); const document = await service.getPdf(actor, id(request));
    const asset = await service.getAsset(actor, document.source.assetId);
    return sendSource(request, reply, store, asset, parse(sourceQuery, request.query).download === 'true', () => service.getAsset(actor, asset.asset_id));
  });
  app.get('/api/v1/assets/:id/content', async (request, reply) => {
    const actor = await requireSession(request); const asset = await service.getAsset(actor, id(request));
    return sendSource(request, reply, store, asset, parse(sourceQuery, request.query).download === 'true', () => service.getAsset(actor, asset.asset_id));
  });
}
