import { randomUUID, createHash } from 'node:crypto';
import { webRendererVersion, webRendererSha256 } from '@pagelingo/document-renderer';
import type { CreateWebExportRequest } from '@pagelingo/document-contracts';
import { assertActorCurrent, type Actor } from '../auth/guards.js';
import { assertDocumentActive, assertDocumentWritable, lockDocument } from '../document-lifecycle/guards.js';
import { assertOperationNotRetired } from '../document-lifecycle/retired-identities.js';
import type { Database } from '../db/database.js';
import { ServiceError } from '../errors.js';
import { findWebReaderVersion } from '../web-readers/repository.js';
import { webNotFound } from '../web-readers/assets.js';
import { findExport, exportView } from './repository.js';
export function createWebExportsService({ db }: { db: Database }) {
  async function authorized(client: import('pg').PoolClient, actor: Actor, document: string) {
    await assertActorCurrent(client, actor); await lockDocument(client, actor.userId, document);
    return assertDocumentActive(client, actor.userId, document);
  }
  return {
    async create(actor: Actor, document: string, key: string, input: CreateWebExportRequest) {
      return db.transaction(async client => {
        await assertActorCurrent(client, actor);
        await assertOperationNotRetired(client, actor.userId, 'web-export', key, { documentId: document, authVersion: actor.authVersion });
        await lockDocument(client,actor.userId,document);
        const { epoch } = await assertDocumentActive(client,actor.userId,document);
        const old = (await client.query<{ id: string; reader_version_id: string }>('SELECT id,reader_version_id FROM web_exports WHERE owner_id=$1 AND document_id=$2 AND auth_version=$3 AND idempotency_key=$4', [actor.userId,document,actor.authVersion,key])).rows[0];
        if (old) {
          if (old.reader_version_id !== input.readerVersionId.toLowerCase()) throw new ServiceError(409,'IDEMPOTENCY_CONFLICT','Export action already has different input');
          return exportView((await findExport(client,actor.userId,document,old.id))!);
        }
        await assertDocumentWritable(client, actor.userId, document);
        const selected = await findWebReaderVersion(client, actor.userId, document, input.readerVersionId);
        if (!selected) throw webNotFound();
        const title = (await client.query<{ title: string }>('SELECT title FROM documents WHERE owner_id=$1 AND id=$2', [actor.userId,document])).rows[0]!.title;
        const id = randomUUID(), job = randomUUID(), packageId = randomUUID();
        const hash = createHash('sha256').update(JSON.stringify(['export-web',id,selected.id,selected.source_version_id,selected.parse_id,webRendererVersion,webRendererSha256,epoch])).digest('hex');
        await client.query(`INSERT INTO web_jobs(id,owner_id,document_id,auth_version,kind,input_sha256,source_version_id,parse_id)
          VALUES($1,$2,$3,$4,'export-web',$5,$6,$7)`, [job,actor.userId,document,actor.authVersion,hash,selected.source_version_id,selected.parse_id]);
        await client.query(`INSERT INTO web_exports(id,owner_id,document_id,auth_version,document_epoch,idempotency_key,job_id,reader_version_id,source_version_id,parse_id,package_id,title,renderer_version,renderer_sha256)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [id,actor.userId,document,actor.authVersion,epoch,key,job,selected.id,selected.source_version_id,selected.parse_id,packageId,title,webRendererVersion,webRendererSha256]);
        return exportView((await findExport(client,actor.userId,document,id))!);
      });
    },
    async get(actor: Actor, document: string, id: string) {
      return db.transaction(async client => {
        await authorized(client,actor,document);
        const row = await findExport(client,actor.userId,document,id);
        if (!row) throw webNotFound();
        return exportView(row);
      });
    },
    async file(actor: Actor, document: string, id: string) {
      return db.transaction(async client => {
        await authorized(client,actor,document);
        const row = await findExport(client,actor.userId,document,id);
        if (!row || row.status !== 'completed' || !row.object_key || !row.bytes || !row.sha256) throw webNotFound();
        return { object_key: row.object_key, bytes: row.bytes, sha256: row.sha256, title: row.title };
      });
    },
  };
}
