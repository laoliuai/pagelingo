// Acceptance-only S3 seeding. Every stored asset contains validated actual bytes.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { defaultBundleLimits } from '@pagelingo/document-contracts';
import { createArchiveFileSource, validateBundle } from '@pagelingo/document-bundle';
import { sanitizeNodeSnapshot, canonicalManifestBytes, projectWebReader, captureContentFingerprint } from '@pagelingo/web-capture/node';
import { buildWebReader } from '@pagelingo/document-renderer';
import { capture } from '../../apps/document-service/tests/helpers/web-capture.ts';
import { hashPassword } from '../../apps/document-service/src/auth/passwords.ts';
import * as web from '../../apps/document-service/src/web-readers/repository.ts';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function seedS3(db, store, password, archivePath) {
  const directory = new URL('../../apps/document-service/migrations/', import.meta.url);
  await db.pool.query('CREATE TABLE schema_migrations(id text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await readdir(directory)).filter(n => /^00[1-6]-.*\.sql$/.test(n)).sort()) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    await db.transaction(async c => { await c.query(sql); await c.query('INSERT INTO schema_migrations(id,checksum) VALUES($1,$2)', [name.slice(0,-4), hash(sql)]); });
  }
  const owner = randomUUID();
  await db.pool.query("INSERT INTO users(id,username,password_hash,role) VALUES($1,'acceptance',$2,'admin')", [owner, await hashPassword(password)]);
  const stored = [];
  async function asset(documentId, bytes, mediaType, stream) {
    const id = randomUUID(), key = randomUUID();
    const value = await store.putImmutable(key, stream ?? (async function* () { yield bytes; })(), 256 * 1024 * 1024);
    await db.pool.query('INSERT INTO assets(id,owner_id,document_id,object_key,sha256,bytes,media_type) VALUES($1,$2,$3,$4,$5,$6,$7)', [id,owner,documentId,key,value.sha256,value.bytes,mediaType]);
    const row = { id, key, ...value }; stored.push(row); return row;
  }
  const pdfId = randomUUID(), pdfSource = randomUUID(), pdfReader = randomUUID();
  const source = createArchiveFileSource(archivePath, defaultBundleLimits), validated = await validateBundle(source, { limits: defaultBundleLimits });
  await db.pool.query("INSERT INTO documents(id,owner_id,title,original_filename) VALUES($1,$2,'S3 retained PDF','retained.pdf')", [pdfId,owner]);
  const files = new Map();
  for (const file of validated.files) files.set(file.path, await asset(pdfId, null, file.mediaType, source.read(file.path)));
  const pdf = files.get('source.pdf'), ir = files.get('source-ir.json'), translation = files.get('translation.json');
  const archive = await asset(pdfId, null, 'application/zip', createReadStream(archivePath));
  const index = await asset(pdfId, Buffer.from(JSON.stringify(validated.readerBuild.index)), 'application/json');
  const manifest = validated.manifest;
  await db.pool.query('INSERT INTO source_versions(id,owner_id,document_id,asset_id,sha256,bytes) VALUES($1,$2,$3,$4,$5,$6)', [pdfSource,owner,pdfId,pdf.id,pdf.sha256,pdf.bytes]);
  await db.pool.query('INSERT INTO parse_runs(id,owner_id,document_id,source_version_id,ir_asset_id,ir_sha256,status,coverage,warnings) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [manifest.parse.id,owner,pdfId,pdfSource,ir.id,ir.sha256,validated.ir.parse.status,validated.ir.parse.coverage,JSON.stringify(validated.readerBuild.index.warnings)]);
  await db.pool.query('INSERT INTO translation_runs(id,owner_id,document_id,source_version_id,parse_id,translation_asset_id,sha256,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [manifest.translation.id,owner,pdfId,pdfSource,manifest.parse.id,translation.id,translation.sha256,manifest.translation.status]);
  await db.pool.query('INSERT INTO reader_versions(id,owner_id,document_id,source_version_id,parse_id,translation_id,package_id,manifest_sha256,archive_asset_id,index_asset_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [pdfReader,owner,pdfId,pdfSource,manifest.parse.id,manifest.translation.id,manifest.packageId,validated.manifestSha256,archive.id,index.id]);
  for (const [path, file] of files) await db.pool.query('INSERT INTO bundle_files(owner_id,document_id,reader_version_id,path,asset_id) VALUES($1,$2,$3,$4,$5)', [owner,pdfId,pdfReader,path,file.id]);
  for (const chunk of validated.readerBuild.chunks) {
    const data = await asset(pdfId, Buffer.from(JSON.stringify(chunk)), 'application/json');
    await db.pool.query('INSERT INTO reader_chunks(owner_id,document_id,reader_version_id,id,data_asset_id) VALUES($1,$2,$3,$4,$5)', [owner,pdfId,pdfReader,chunk.id,data.id]);
  }
  await db.pool.query('UPDATE documents SET current_source_version_id=$2,current_reader_version_id=$3 WHERE id=$1', [pdfId,pdfSource,pdfReader]);
  const pdfPosition = { readerVersionId: pdfReader, sourceVersionId: pdfSource, parseId: manifest.parse.id, blockId: null, blockOffset: 0.25, pdfPageIndex: 0, view: 'split', contentMode: 'source' };
  await db.pool.query('INSERT INTO reading_positions(owner_id,document_id,source_version_id,parse_id,reader_version_id,position) VALUES($1,$2,$3,$4,$5,$6)', [owner,pdfId,pdfSource,manifest.parse.id,pdfReader,JSON.stringify(pdfPosition)]);
  await db.pool.query('INSERT INTO reading_state(owner_id,document_id,revision,source_version_id,parse_id,reader_version_id,position) VALUES($1,$2,7,$3,$4,$5,$6)', [owner,pdfId,pdfSource,manifest.parse.id,pdfReader,JSON.stringify(pdfPosition)]);
  const raw = capture('<article><h1>S3 retained Web</h1><p>This original article and its reading progress survive the additive management upgrade.</p></article>');
  const snapshot = sanitizeNodeSnapshot({ html: raw.body.toString(), url: raw.manifest.source.url, scope: raw.manifest.scope });
  const html = Buffer.from(snapshot.html); raw.manifest.source.url = snapshot.sourceUrl; raw.manifest.scope = snapshot.scope;
  Object.assign(raw.manifest.files[0], { bytes: html.length, sha256: hash(html) });
  const manifestBytes = canonicalManifestBytes(raw.manifest);
  const webIr = await projectWebReader(snapshot, raw.manifest, { manifestBytes, assets: [] }), build = buildWebReader(webIr, null);
  const webId = randomUUID(), webSource = randomUUID(), webReader = randomUUID();
  await db.pool.query("INSERT INTO documents(id,owner_id,kind,title,source_url) VALUES($1,$2,'article','S3 retained Web',$3)", [webId,owner,snapshot.sourceUrl]);
  const webManifest = await asset(webId, manifestBytes, 'application/json'), webHtml = await asset(webId, html, 'text/html'), webIrAsset = await asset(webId, Buffer.from(JSON.stringify(webIr)), 'application/json'), webIndex = await asset(webId, Buffer.from(JSON.stringify(build.index)), 'application/json');
  await db.transaction(async c => {
    await web.insertWebSource(c, { ownerId: owner, documentId: webId, sourceVersionId: webSource, manifestAssetId: webManifest.id, sha256: webManifest.sha256, bytes: webManifest.bytes, snapshotSha256: hash(html), url: snapshot.sourceUrl, scope: snapshot.scope, contentFingerprint: await captureContentFingerprint(snapshot, [], raw.manifest.files), metadata: raw.manifest.metadata });
    await web.registerWebSourceFile(c, { ownerId: owner, documentId: webId, sourceVersionId: webSource, id: 'html', path: 'source.html', role: 'html', assetId: webHtml.id });
    await web.insertWebParse(c, { ownerId: owner, documentId: webId, sourceVersionId: webSource, parseId: webIr.parse.id, irAssetId: webIrAsset.id, irSha256: webIrAsset.sha256 });
    await web.insertWebReaderVersion(c, { id: webReader, ownerId: owner, documentId: webId, sourceVersionId: webSource, parseId: webIr.parse.id, translationId: null, indexAssetId: webIndex.id, translationStatus: build.index.translationStatus, warnings: [] });
  });
  for (const chunk of build.chunks) {
    const data = await asset(webId, Buffer.from(JSON.stringify(chunk)), 'application/json');
    await db.pool.query('INSERT INTO web_reader_chunks(owner_id,document_id,reader_version_id,id,data_asset_id) VALUES($1,$2,$3,$4,$5)', [owner,webId,webReader,chunk.id,data.id]);
  }
  await db.pool.query('UPDATE documents SET current_source_version_id=$2,latest_web_source_version_id=$2,current_web_reader_version_id=$3 WHERE id=$1', [webId,webSource,webReader]);
  const webPosition = { readerVersionId: webReader, sourceVersionId: webSource, parseId: webIr.parse.id, blockId: webIr.blocks[0].id, blockOffset: 0.4, view: 'content', contentMode: 'source' };
  await db.pool.query('INSERT INTO web_reading_positions(owner_id,document_id,source_version_id,parse_id,reader_version_id,position) VALUES($1,$2,$3,$4,$5,$6)', [owner,webId,webSource,webIr.parse.id,webReader,JSON.stringify(webPosition)]);
  await db.pool.query('INSERT INTO web_reading_state(owner_id,document_id,revision,reader_version_id) VALUES($1,$2,3,$3)', [owner,webId,webReader]);
  return { owner, pdfId, pdfSource, pdfReader, pdfPosition, pdfSha256: pdf.sha256, archiveSha256: archive.sha256, webId, webSource, webReader, webPosition, webManifest: raw.manifest, stored };
}
export async function baselineSnapshot(db) {
  const result = {};
  for (const table of ['assets','source_versions','reader_versions','reading_state','reading_positions','web_sources','web_reader_versions','web_reading_positions','web_reading_state']) result[table] = (await db.pool.query(`SELECT row_to_json(t) AS value FROM ${table} t ORDER BY row_to_json(t)::text`)).rows;
  result.documents = (await db.pool.query('SELECT id,owner_id,kind,title,original_filename,current_source_version_id,current_reader_version_id,current_web_reader_version_id,created_at,updated_at FROM documents ORDER BY id')).rows;
  return result;
}
