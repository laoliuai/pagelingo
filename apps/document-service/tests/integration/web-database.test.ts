import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { createTestDatabase } from '../helpers/database.js';
import { migrateDatabase, verifyDatabaseSchema } from '../../src/db/migrate.js';
import type { Database } from '../../src/db/database.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
async function database(migrate = true) {
  const test = await createTestDatabase(); cleanup.push(test.dispose);
  if (migrate) await migrateDatabase(test.db);
  return test.db;
}
const oldNames = ['001-accounts', '002-providers', '003-documents', '004-user-management', '005-reader-bundles'];
async function s2(db: Database) {
  await db.pool.query('CREATE TABLE schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const id of oldNames) {
    const sql = await readFile(new URL(`../../migrations/${id}.sql`, import.meta.url), 'utf8');
    await db.pool.query(sql);
    await db.pool.query('INSERT INTO schema_migrations (id,checksum) VALUES ($1,$2)', [id, createHash('sha256').update(sql).digest('hex')]);
  }
}
async function owner(db: Database) {
  const id = randomUUID();
  await db.pool.query('INSERT INTO users (id,username,password_hash) VALUES ($1,$2,\'hash\')', [id, `u${id.replaceAll('-', '').slice(0, 20)}`]);
  return id;
}
async function web(db: Database, ownerId = '') {
  const o = ownerId || await owner(db), d = randomUUID(), a = randomUUID(), s = randomUUID(), r = randomUUID();
  const p = `p_${createHash('sha256').update(d).digest('hex')}`;
  await db.pool.query("INSERT INTO documents (id,owner_id,kind,title) VALUES ($1,$2,'article','Web')", [d,o]);
  await db.pool.query("INSERT INTO assets (id,owner_id,document_id,object_key,sha256,bytes,media_type) VALUES ($1,$2,$3,$4,repeat('a',64),10,'application/json')", [a,o,d,a]);
  await db.pool.query("INSERT INTO source_versions (id,owner_id,document_id,asset_id,sha256,bytes) VALUES ($1,$2,$3,$4,repeat('a',64),10)", [s,o,d,a]);
  await db.pool.query("INSERT INTO web_sources (owner_id,document_id,source_version_id,url,scope,content_fingerprint,snapshot_sha256) VALUES ($1,$2,$3,'https://example.com/a','{}',repeat('b',64),repeat('c',64))", [o,d,s]);
  await db.pool.query("INSERT INTO web_parse_runs (id,owner_id,document_id,source_version_id,ir_asset_id,ir_sha256) VALUES ($1,$2,$3,$4,$5,repeat('a',64))", [p,o,d,s,a]);
  await db.pool.query("INSERT INTO web_reader_versions (id,owner_id,document_id,source_version_id,parse_id,index_asset_id,translation_status) VALUES ($1,$2,$3,$4,$5,$6,'pending')", [r,o,d,s,p,a]);
  return {o,d,a,s,p,r};
}
it('migrates_populated_s2_without_changing_pdf_rows and replays safely', async () => {
  const db = await database(false); await s2(db);
  const o = await owner(db), d = randomUUID(), a = randomUUID(), s = randomUUID(), t = randomUUID(), r = randomUUID();
  await db.pool.query("INSERT INTO documents (id,owner_id,title,original_filename) VALUES ($1,$2,'PDF','original.pdf')", [d,o]);
  await db.pool.query("INSERT INTO assets (id,owner_id,document_id,object_key,sha256,bytes,media_type) VALUES ($1,$2,$3,'pdf',repeat('a',64),5,'application/pdf')", [a,o,d]);
  await db.pool.query("INSERT INTO source_versions (id,owner_id,document_id,asset_id,sha256,bytes) VALUES ($1,$2,$3,$4,repeat('a',64),5)", [s,o,d,a]);
  const p = `p_${createHash('sha256').update(d).digest('hex')}`;
  await db.pool.query("INSERT INTO parse_runs (id,owner_id,document_id,source_version_id,ir_asset_id,ir_sha256,status,coverage,warnings) VALUES ($1,$2,$3,$4,$5,repeat('a',64),'complete','full','[]')", [p,o,d,s,a]);
  await db.pool.query("INSERT INTO translation_runs (id,owner_id,document_id,source_version_id,parse_id,translation_asset_id,sha256,status) VALUES ($1,$2,$3,$4,$5,$6,repeat('a',64),'completed')", [t,o,d,s,p,a]);
  await db.pool.query("INSERT INTO reader_versions (id,owner_id,document_id,source_version_id,parse_id,translation_id,package_id,manifest_sha256,archive_asset_id,index_asset_id) VALUES ($1,$2,$3,$4,$5,$6,$1,repeat('a',64),$7,$7)", [r,o,d,s,p,t,a]);
  await db.pool.query('UPDATE documents SET current_source_version_id=$1,current_reader_version_id=$2 WHERE id=$3', [s,r,d]);
  const before = (await db.pool.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
  const pdfBefore = (await db.pool.query('SELECT id,owner_id,kind,title,original_filename,current_source_version_id,current_reader_version_id,created_at,updated_at FROM documents')).rows;
  await migrateDatabase(db); await migrateDatabase(db); await verifyDatabaseSchema(db);
  expect((await db.pool.query("SELECT id,checksum FROM schema_migrations WHERE id < '006' ORDER BY id")).rows).toEqual(before);
  expect((await db.pool.query('SELECT id,owner_id,kind,title,original_filename,current_source_version_id,current_reader_version_id,created_at,updated_at FROM documents')).rows).toEqual(pdfBefore);
  expect((await db.pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n).toBe(7);
  expect((await db.pool.query('SELECT count(*)::int n FROM web_worker_slots')).rows[0].n).toBe(2);
  expect((await db.pool.query('SELECT count(*)::int n FROM site_metadata')).rows[0].n).toBe(1);
  const w = await web(db,o), pdf = await import('../../src/documents/repository.js');
  await db.pool.query('UPDATE documents SET current_source_version_id=$1,current_web_reader_version_id=$2 WHERE id=$3',[w.s,w.r,w.d]);
  await db.transaction(async c => {
    expect(await pdf.listDocuments(c,o,{page:1,pageSize:10})).toMatchObject({total:1,items:[{id:d,kind:'pdf',originalFilename:'original.pdf'}]});
    expect(await pdf.findDocument(c,o,d)).toMatchObject({source_version_id:s,reader_version_id:r});
    await expect(pdf.findDocument(c,o,w.d)).rejects.toThrow();
  });
});
it('rolls back failed 006 DDL and can replay after the obstruction is removed', async () => {
  const db = await database(false); await s2(db);
  await db.pool.query('CREATE TABLE web_parse_runs (obstruction integer)');
  await expect(migrateDatabase(db)).rejects.toThrow();
  expect((await db.pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n).toBe(5);
  expect((await db.pool.query("SELECT to_regclass('site_metadata') AS name")).rows[0].name).toBeNull();
  await db.pool.query('DROP TABLE web_parse_runs'); await migrateDatabase(db);
  await verifyDatabaseSchema(db);
});
it('rejects_cross_owner_web_refs and mismatched source/parse identities', async () => {
  const db = await database(), f = await web(db), other = await owner(db);
  await expect(db.pool.query('INSERT INTO web_reader_assets (owner_id,document_id,reader_version_id,local_id,asset_id) VALUES ($1,$2,$3,\'image\',$4)', [other,f.d,f.r,f.a])).rejects.toMatchObject({ code:'23503' });
  const s2 = randomUUID();
  await db.pool.query("INSERT INTO source_versions (id,owner_id,document_id,asset_id,sha256,bytes) VALUES ($1,$2,$3,$4,repeat('a',64),10)", [s2,f.o,f.d,f.a]);
  await db.pool.query("INSERT INTO web_sources (owner_id,document_id,source_version_id,url,scope,content_fingerprint,snapshot_sha256) VALUES ($1,$2,$3,'https://example.com/b','{}',repeat('d',64),repeat('c',64))", [f.o,f.d,s2]);
  await expect(db.pool.query("INSERT INTO web_reader_versions (id,owner_id,document_id,source_version_id,parse_id,index_asset_id,translation_status) VALUES ($1,$2,$3,$4,$5,$6,'pending')", [randomUUID(),f.o,f.d,s2,f.p,f.a])).rejects.toMatchObject({code:'23503'});
});
it('rejects_immutable_updates including source bytes and source-only reader versions', async () => {
  const db = await database(), f = await web(db);
  for (const table of ['assets','source_versions','web_sources','web_parse_runs','web_reader_versions']) {
    await expect(db.pool.query(`UPDATE ${table} SET owner_id=owner_id`)).rejects.toThrow(/immutable/i);
  }
  expect((await db.pool.query('SELECT translation_id FROM web_reader_versions WHERE id=$1',[f.r])).rows[0].translation_id).toBeNull();
});
it('keeps_pdf_and_web_current_separate and link-only records without source/readers', async () => {
  const db = await database(), f = await web(db);
  await db.pool.query('UPDATE documents SET current_source_version_id=$1,current_web_reader_version_id=$2,latest_web_source_version_id=$1 WHERE id=$3',[f.s,f.r,f.d]);
  await expect(db.pool.query('UPDATE documents SET current_reader_version_id=$1 WHERE id=$2',[f.r,f.d])).rejects.toThrow();
  await expect(db.pool.query("UPDATE documents SET kind='pdf',original_filename='x.pdf' WHERE id=$1",[f.d])).rejects.toThrow();
  await expect(db.pool.query('UPDATE documents SET current_source_version_id=NULL WHERE id=$1',[f.d])).rejects.toThrow();
  await expect(db.pool.query("INSERT INTO documents (owner_id,title,kind) VALUES ($1,'PDF','pdf')",[f.o])).rejects.toThrow();
  await db.pool.query("INSERT INTO documents (owner_id,title,kind,source_url) VALUES ($1,'Link','repository','https://example.com/repo')",[f.o]);
  await expect(db.pool.query("UPDATE documents SET current_source_version_id=$1 WHERE kind='repository'",[f.s])).rejects.toThrow();
});

it('persists pairing/device hashes, retains session identity after natural cleanup, and scopes revocation', async () => {
  const repo = await import('../../src/devices/repository.js');
  const db = await database(), o = await owner(db), other = await owner(db), session = randomUUID(), device = randomUUID();
  await db.pool.query("INSERT INTO sessions (id,user_id,token_hash,auth_version,csrf_token,expires_at) VALUES ($1,$2,repeat('a',64),1,'csrf',clock_timestamp()+interval '1 hour')",[session,o]);
  await db.transaction(async c => {
    const site = await repo.readSiteId(c); expect(site).toMatch(/^[a-f0-9-]{36}$/);
    await repo.insertPairing(c,{id:randomUUID(),ownerId:o,authVersion:1,sessionId:session,codeHash:'b'.repeat(64),expiresAt:new Date(Date.now()+60000)});
    expect(await repo.consumePairing(c,'b'.repeat(64))).toMatchObject({ owner_id:o,session_id:session });
    expect(await repo.consumePairing(c,'b'.repeat(64))).toBeUndefined();
    await repo.insertDevice(c,{id:device,ownerId:o,authVersion:1,pairingSessionId:session,tokenHash:'c'.repeat(64),name:'Browser',extensionId:'ext',extensionVersion:'1',scopes:['captures:write'],expiresAt:new Date(Date.now()+60000)});
  });
  await db.pool.query('DELETE FROM sessions WHERE id=$1',[session]);
  await db.transaction(async c => {
    expect((await repo.listDevices(c,o))[0]).toMatchObject({ id:device,pairing_session_id:session });
    expect(await repo.listDevices(c,other)).toEqual([]);
    expect(await repo.findDeviceByTokenHash(c,'c'.repeat(64))).toMatchObject({id:device});
    expect(await repo.revokeDevice(c,other,device)).toBe(false);
    expect(await repo.revokeSessionDevices(c,o,session)).toBe(1);
    expect((await repo.listDevices(c,o))[0].revoked_at).toBeInstanceOf(Date);
  });
});
it('persists preferences CAS and immutable glossary/profile revisions without serializing credentials', async () => {
  const repo = await import('../../src/glossary/repository.js');
  const db = await database(), o = await owner(db);
  await db.transaction(async c => {
    expect(await repo.readSavePreferences(c,o)).toEqual({revision:0,autoTranslate:false});
    expect(await repo.savePreferences(c,o,0,true)).toEqual({revision:1,autoTranslate:true});
    expect(await repo.savePreferences(c,o,0,false)).toBeNull();
    expect(await repo.readGlossaryRevision(c,o)).toEqual({revision:0,entries:[]});
    expect(await repo.saveGlossaryRevision(c,o,0,[])).toEqual({revision:1,entries:[]});
    expect(await repo.saveGlossaryRevision(c,o,0,[])).toBeNull();
    expect(await repo.readGlossaryRevision(c,o,0)).toEqual({revision:0,entries:[]});
  });
  await expect(db.pool.query('UPDATE glossary_revisions SET entries=\'[]\'')).rejects.toThrow(/immutable/i);
  const jobs = await import('../../src/web-jobs/repository.js');
  const { defaultProviderProfile } = await import('@pagelingo/document-contracts');
  const { revision: _revision, hasApiKey: _hasApiKey, ...defaultProviderSettings } = defaultProviderProfile;
  await db.transaction(c => jobs.insertProviderRevision(c,o,0,defaultProviderSettings));
  await expect(db.transaction(c => jobs.insertProviderRevision(c,o,1,{...defaultProviderSettings,apiKey:'forbidden'} as typeof defaultProviderSettings))).rejects.toThrow();
  expect(JSON.stringify((await db.pool.query('SELECT settings FROM web_provider_revisions')).rows)).not.toContain('forbidden');
});
async function jobFixture(db: Database, existingOwner?: string) {
  const f = await web(db,existingOwner), jobs = await import('../../src/web-jobs/repository.js');
  const { defaultProviderProfile } = await import('@pagelingo/document-contracts');
  const { revision: _revision, hasApiKey: _hasApiKey, ...defaultProviderSettings } = defaultProviderProfile;
  const id = randomUUID();
  await db.transaction(async c => {
    await c.query('INSERT INTO provider_profiles (owner_id) VALUES ($1) ON CONFLICT DO NOTHING',[f.o]);
    await c.query("INSERT INTO glossary_revisions (owner_id,revision,entries) VALUES ($1,0,'[]') ON CONFLICT DO NOTHING",[f.o]);
    await jobs.insertProviderRevision(c,f.o,0,defaultProviderSettings);
    await jobs.insertWebJob(c,{id,ownerId:f.o,authVersion:1,kind:'translate',documentId:f.d,sourceVersionId:f.s,parseId:f.p,profileRevision:0,glossaryRevision:0,sourceLanguage:'fr',selectionBlockIds:['b_11111111111111111111111111111111'],inputSha256:'f'.repeat(64)});
  });
  return {...f,id,jobs};
}
it('persists immutable manual job inputs and rejects stale auth, profile, job epoch, slot epoch and lease time', async () => {
  const db = await database(), f = await jobFixture(db);
  const lease = await db.transaction(c => f.jobs.startWebJobLease(c,{ownerId:f.o,jobId:f.id,slotId:1,leaseOwner:'worker-a'}));
  expect(lease).toMatchObject({kind:'translate',authVersion:1,epoch:1,slotEpoch:1,sourceVersionId:f.s});
  expect((await db.pool.query('SELECT source_language,selection_block_ids FROM web_jobs WHERE id=$1',[f.id])).rows[0]).toEqual({source_language:'fr',selection_block_ids:['b_11111111111111111111111111111111']});
  await expect(db.pool.query("UPDATE web_jobs SET source_language='de' WHERE id=$1",[f.id])).rejects.toThrow(/immutable/i);
  await expect(db.pool.query("UPDATE web_jobs SET selection_block_ids=ARRAY['b_other'] WHERE id=$1",[f.id])).rejects.toThrow(/immutable/i);
  await db.transaction(c => f.jobs.assertJobLeaseCurrent(c,lease!));
  for (const mutation of [{epoch:0},{slotEpoch:0},{authVersion:0},{leaseOwner:'other'},{sourceVersionId:randomUUID()}]) {
    await expect(db.transaction(c => f.jobs.assertJobLeaseCurrent(c,{...lease!,...mutation}))).rejects.toThrow(/lease/i);
  }
  await db.pool.query('UPDATE provider_profiles SET revision=1 WHERE owner_id=$1',[f.o]);
  await expect(db.transaction(c => f.jobs.assertJobLeaseCurrent(c,lease!))).rejects.toThrow(/lease/i);
  await db.pool.query('UPDATE provider_profiles SET revision=0 WHERE owner_id=$1',[f.o]);
  await db.pool.query('UPDATE users SET auth_version=2 WHERE id=$1',[f.o]);
  await expect(db.transaction(c => f.jobs.assertJobLeaseCurrent(c,lease!))).rejects.toThrow(/lease/i);
  await db.pool.query('UPDATE users SET auth_version=1,active=false WHERE id=$1',[f.o]);
  await expect(db.transaction(c => f.jobs.assertJobLeaseCurrent(c,lease!))).rejects.toThrow(/lease/i);
  await db.pool.query('UPDATE users SET active=true WHERE id=$1',[f.o]);
  await db.pool.query("UPDATE web_worker_slots SET lease_until=clock_timestamp()-interval '1 second' WHERE id=1");
  await expect(db.transaction(c => f.jobs.assertJobLeaseCurrent(c,lease!))).rejects.toThrow(/lease/i);
});
it('saves checkpoint/cache atomically, isolates owners and fences late writes after slot reassignment', async () => {
  const db = await database(), f = await jobFixture(db), g = await jobFixture(db);
  const lease = (await db.transaction(c => f.jobs.startWebJobLease(c,{ownerId:f.o,jobId:f.id,slotId:1,leaseOwner:'a'})))!;
  const checkpoint = {version:1 as const,fingerprint:'input',units:[],blocks:{},metrics:{networkCalls:0}};
  const entry = {key:'key',text:'saved',schemaVersion:1 as const,createdAt:0,lastAccessedAt:0,bytes:5};
  await db.transaction(c => f.jobs.saveJobCheckpoint(c,lease,checkpoint as never,[entry]));
  await db.transaction(async c => {
    expect(await f.jobs.loadJobCheckpoint(c,lease)).toEqual(checkpoint);
    expect(await f.jobs.readOwnerCache(c,f.o,'key')).toEqual(entry);
    expect(await f.jobs.readOwnerCache(c,g.o,'key')).toBeUndefined();
  });
  await db.pool.query("UPDATE web_worker_slots SET lease_until=clock_timestamp()-interval '1 second' WHERE id=1");
  const next = (await db.transaction(c => f.jobs.startWebJobLease(c,{ownerId:g.o,jobId:g.id,slotId:1,leaseOwner:'b'})))!;
  expect(next.slotEpoch).toBe(2);
  await expect(db.transaction(c => f.jobs.saveJobCheckpoint(c,lease,checkpoint as never,[{...entry,text:'late'}]))).rejects.toMatchObject({name:'CheckpointConflictError'});
  await db.transaction(async c => {
    expect(await f.jobs.releaseWebJobSlot(c,lease)).toBe(false);
    await f.jobs.assertJobLeaseCurrent(c,next);
    expect(await f.jobs.readOwnerCache(c,f.o,'key')).toEqual(entry);
  });
  expect((await db.pool.query('SELECT epoch FROM web_job_checkpoints WHERE owner_id=$1',[f.o])).rows[0].epoch).toBe('1');
});
it('holds the slot row across guarded writes so another owner cannot reassign after an unlocked precheck', async () => {
  const db = await database(), f = await jobFixture(db), g = await jobFixture(db);
  const lease = (await db.transaction(c => f.jobs.startWebJobLease(c,{ownerId:f.o,jobId:f.id,slotId:1,leaseOwner:'a'})))!;
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN'); await f.jobs.assertJobLeaseCurrent(c,lease);
    await expect(db.transaction(async other => {
      await other.query("SET LOCAL lock_timeout='100ms'");
      await other.query("UPDATE web_worker_slots SET owner_id=$1,job_id=$2,epoch=epoch+1 WHERE id=1",[g.o,g.id]);
    })).rejects.toMatchObject({code:'55P03'});
  } finally { await c.query('ROLLBACK'); c.release(); }
});

it('stores captures/files with identity, epoch and byte checks and owner-scoped results', async () => {
  const repo = await import('../../src/web-captures/repository.js');
  const db = await database(), f = await web(db), other = await owner(db), id = randomUUID(), captureId = randomUUID();
  const file = {id:'html',path:'original.html',role:'html' as const,bytes:10,sha256:'a'.repeat(64),mediaType:'text/html'};
  const manifest = {schemaVersion:'web-capture/1' as const,captureId,source:{url:'https://example.com/a',canonicalUrl:null,kind:'article' as const,method:'extension' as const},metadata:{title:'Original',author:null,publishedAt:null,capturedAt:new Date().toISOString()},scope:{kind:'article' as const,rootNodeId:'root',completeWithinScope:true,warnings:[]},htmlFileId:'html',files:[file],resources:[],stylesheetFileIds:[],snapshots:{previews:[],nodeLocations:{}},existingTranslation:null};
  await db.transaction(async c => {
    await repo.insertWebCapture(c,{id,ownerId:f.o,authVersion:1,deviceId:null,sessionId:randomUUID(),manifest,requestHash:'d'.repeat(64),targetDocumentId:f.d,translationIntent:'none',stagingKey:randomUUID()});
    expect(await repo.findWebCapture(c,other,id)).toBeUndefined();
    expect(await repo.findWebCapture(c,f.o,id)).toMatchObject({ capture_id:captureId,status:'created',auth_version:1 });
    expect(await repo.recordCaptureFile(c,f.o,id,0,'html','a'.repeat(64),9)).toBe(false);
    expect(await repo.recordCaptureFile(c,f.o,id,99,'html','a'.repeat(64),10)).toBe(false);
    expect(await repo.recordCaptureFile(c,f.o,id,0,'html','a'.repeat(64),10)).toBe(true);
    expect((await repo.listCaptureFiles(c,f.o,id))[0]).toMatchObject({received_sha256:'a'.repeat(64),received_bytes:'10'});
    expect(await repo.transitionWebCapture(c,f.o,id,0,'created','validating')).toBe(true);
    expect(await repo.completeWebCapture(c,f.o,id,0,{documentId:f.d,sourceVersionId:f.s,readerVersionId:f.r,jobId:null,saveStatus:'original-saved',warnings:[]})).toBe(true);
    expect(await repo.transitionWebCapture(c,f.o,id,0,'created','cancelled')).toBe(false);
    expect(await repo.findWebCapture(c,f.o,id)).toMatchObject({status:'completed',reader_version_id:f.r});
  });
  await expect(db.pool.query("UPDATE web_captures SET manifest='{}' WHERE id=$1",[id])).rejects.toThrow(/immutable/i);
});
it('registers durable source/reader artifacts and progress history with document CAS', async () => {
  const repo = await import('../../src/web-readers/repository.js');
  const db = await database(), o = await owner(db), other = await owner(db), d = randomUUID(), a = randomUUID(), s = randomUUID(), r = randomUUID(), r2 = randomUUID(), p = `p_${'b'.repeat(64)}`;
  await db.transaction(async c => {
    await repo.insertWebDocument(c,{id:d,ownerId:o,kind:'article',title:'Reading',url:'https://example.com/reading'});
    await repo.insertWebAsset(c,{id:a,ownerId:o,documentId:d,objectKey:'web/manifest',sha256:'b'.repeat(64),bytes:20,mediaType:'application/json'});
    await repo.insertWebSource(c,{ownerId:o,documentId:d,sourceVersionId:s,manifestAssetId:a,sha256:'b'.repeat(64),bytes:20,snapshotSha256:'a'.repeat(64),url:'https://example.com/reading',scope:{kind:'article',rootNodeId:'root',completeWithinScope:true,warnings:[]},contentFingerprint:'c'.repeat(64),metadata:{}});
    await repo.registerWebSourceFile(c,{ownerId:o,documentId:d,sourceVersionId:s,id:'html',path:'original.html',role:'html',assetId:a});
    await repo.insertWebParse(c,{ownerId:o,documentId:d,sourceVersionId:s,parseId:p,irAssetId:a,irSha256:'b'.repeat(64)});
    for (const id of [r,r2]) await repo.insertWebReaderVersion(c,{id,ownerId:o,documentId:d,sourceVersionId:s,parseId:p,translationId:null,indexAssetId:a,translationStatus:'pending',warnings:[]});
    await repo.insertWebReaderChunk(c,{ownerId:o,documentId:d,readerVersionId:r,id:'c_000001',dataAssetId:a});
    await repo.registerWebReaderAsset(c,{ownerId:o,documentId:d,readerVersionId:r,localId:'image',assetId:a});
    await repo.setLatestWebSource(c,o,d,s); await repo.setCurrentWebReader(c,o,d,s,r);
    expect(await repo.findWebReaderVersion(c,o,d)).toMatchObject({id:r,translation_id:null});
    expect(await repo.findWebReaderVersion(c,other,d,r)).toBeUndefined();
    expect(await repo.listWebReaderVersions(c,o,d)).toHaveLength(2);
    expect(await repo.findWebReaderAsset(c,o,d,r,'image')).toMatchObject({object_key:'web/manifest'});
    expect(await repo.findWebReaderAsset(c,other,d,r,'image')).toBeUndefined();
    expect(await repo.findWebReaderChunk(c,o,d,r,'c_000001')).toMatchObject({sha256:'b'.repeat(64)});
    expect(await repo.findWebSourceFile(c,o,d,s,'html')).toMatchObject({id:a});
    const position = {readerVersionId:r,sourceVersionId:s,parseId:p,blockId:null,blockOffset:0,view:'content' as const,contentMode:'source' as const};
    expect(await repo.saveWebProgress(c,o,d,0,position)).toMatchObject({revision:1,position});
    expect(await repo.saveWebProgress(c,o,d,0,{...position,readerVersionId:r2})).toBeNull();
    expect(await repo.saveWebProgress(c,o,d,1,{...position,readerVersionId:r2})).toMatchObject({revision:2});
    expect(await repo.readWebProgress(c,o,d,r)).toMatchObject({revision:2,position});
    expect(await repo.readWebProgress(c,other,d,r)).toBeNull();
  });
  const pdf = await import('../../src/documents/repository.js');
  await db.transaction(async c => {
    expect(await pdf.listDocuments(c,o,{page:1,pageSize:10})).toMatchObject({items:[],total:0});
    await expect(pdf.findDocument(c,o,d)).rejects.toThrow();
    expect(await pdf.findSamePdf(c,o,'b'.repeat(64))).toBeUndefined();
  });
  await expect(db.pool.query('DELETE FROM assets WHERE id=$1',[a])).rejects.toMatchObject({code:'23503'});
});

it('rejects cross-kind historical sources, PDF parses on Web sources, and unpaired Web current source pointers', async () => {
  const db = await database(), f = await web(db), link = randomUUID(), a = randomUUID();
  await db.pool.query("INSERT INTO documents (id,owner_id,kind,title) VALUES ($1,$2,'paper','Link')",[link,f.o]);
  await db.pool.query("INSERT INTO assets (id,owner_id,document_id,object_key,sha256,bytes,media_type) VALUES ($1,$2,$3,'link-asset',repeat('a',64),1,'text/plain')",[a,f.o,link]);
  await expect(db.pool.query("INSERT INTO source_versions (owner_id,document_id,asset_id,sha256,bytes) VALUES ($1,$2,$3,repeat('a',64),1)",[f.o,link,a])).rejects.toThrow();
  await expect(db.pool.query("INSERT INTO parse_runs (id,owner_id,document_id,source_version_id,ir_asset_id,ir_sha256,status,coverage,warnings) VALUES ($1,$2,$3,$4,$5,repeat('a',64),'complete','full','[]')",[f.p,f.o,f.d,f.s,f.a])).rejects.toThrow();
  await expect(db.pool.query('UPDATE documents SET current_source_version_id=$1 WHERE id=$2',[f.s,f.d])).rejects.toThrow();
});
it('persists immutable translation artifacts and job/reader linkage, fetch inputs, and rejects duplicate selections in SQL', async () => {
  const db = await database(), f = await jobFixture(db), readers = await import('../../src/web-readers/repository.js');
  const t = randomUUID(), r = randomUUID(), fetch = randomUUID();
  await db.transaction(async c => {
    await readers.insertWebTranslation(c,{id:t,ownerId:f.o,documentId:f.d,sourceVersionId:f.s,parseId:f.p,jobId:f.id,translationAssetId:f.a,sha256:'a'.repeat(64)});
    await readers.insertWebReaderVersion(c,{id:r,ownerId:f.o,documentId:f.d,sourceVersionId:f.s,parseId:f.p,translationId:t,indexAssetId:f.a,translationStatus:'completed',warnings:[]});
    expect(await readers.findWebReaderVersion(c,f.o,f.d,r)).toMatchObject({translation_id:t,translation_status:'completed'});
    await f.jobs.insertWebJob(c,{id:fetch,ownerId:f.o,authVersion:1,documentId:f.d,inputSha256:'e'.repeat(64),kind:'fetch-link',url:'https://example.com/fetch'});
    expect(await f.jobs.findWebJob(c,f.o,fetch)).toMatchObject({kind:'fetch-link',source_version_id:null,source_language:null,selection_block_ids:null});
    const lease = await f.jobs.startWebJobLease(c,{ownerId:f.o,jobId:fetch,slotId:2,leaseOwner:'fetcher'});
    expect(lease).toMatchObject({kind:'fetch-link',url:'https://example.com/fetch'});
    await f.jobs.assertJobLeaseCurrent(c,lease!);
  });
  await expect(db.pool.query('UPDATE web_translation_runs SET sha256=sha256 WHERE id=$1',[t])).rejects.toThrow(/immutable/i);
  await expect(db.pool.query("INSERT INTO web_jobs (id,owner_id,document_id,auth_version,kind,input_sha256,source_version_id,parse_id,profile_revision,glossary_revision,selection_block_ids) VALUES ($1,$2,$3,1,'translate',repeat('d',64),$4,$5,0,0,ARRAY[$6,$6])",[randomUUID(),f.o,f.d,f.s,f.p,`b_${'1'.repeat(32)}`])).rejects.toThrow();
});
it('makes checkpoint/cache writes roll back together on cache failure', async () => {
  const db = await database(), f = await jobFixture(db);
  const lease = (await db.transaction(c => f.jobs.startWebJobLease(c,{ownerId:f.o,jobId:f.id,slotId:1,leaseOwner:'worker'})))!;
  const checkpoint = {version:1,fingerprint:'x',units:[],blocks:{},metrics:{}};
  await db.pool.query("ALTER TABLE web_owner_cache ADD CHECK (cache_key<>'fail')");
  await expect(db.transaction(c => f.jobs.saveJobCheckpoint(c,lease,checkpoint as never,[{key:'fail',text:'x',schemaVersion:1,createdAt:0,lastAccessedAt:0,bytes:1}]))).rejects.toThrow();
  expect((await db.pool.query('SELECT count(*)::int n FROM web_job_checkpoints')).rows[0].n).toBe(0);
  expect((await db.pool.query('SELECT count(*)::int n FROM web_owner_cache')).rows[0].n).toBe(0);
});
it('coordinates two independent lease processes with global slots and one running job per owner', async () => {
  const { spawn } = await import('node:child_process');
  const db = await database(), f = await jobFixture(db), g = await jobFixture(db,f.o), h = await jobFixture(db);
  const schema = (await db.pool.query('SELECT current_schema() AS name')).rows[0].name as string;
  const run = (ownerId: string, jobId: string, slotId: number) => new Promise<unknown>((resolve,reject) => {
    const child = spawn(process.execPath,['--import','tsx','tests/helpers/web-lease-process.ts',schema,ownerId,jobId,String(slotId)],{stdio:['ignore','pipe','pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data',data => { stdout += data; }); child.stderr.on('data',data => { stderr += data; });
    child.on('error',reject); child.on('close',code => { if (code) reject(new Error(stderr)); else resolve(JSON.parse(stdout)); });
  });
  const leases = await Promise.all([run(f.o,f.id,1),run(g.o,g.id,2)]);
  expect(leases.filter(Boolean)).toHaveLength(1);
  const used = (leases.find(Boolean) as {slotId:number}).slotId;
  expect(await run(h.o,h.id,used)).toBeNull();
  expect(await run(h.o,h.id,used===1 ? 2 : 1)).toBeTruthy();
  expect((await db.pool.query("SELECT count(*)::int n FROM web_jobs WHERE status='running'")).rows[0].n).toBe(2);
});

it('reads immutable source/parse identities and restores zero glossary revision for first jobs', async () => {
  const db = await database(), f = await jobFixture(db), readers = await import('../../src/web-readers/repository.js'), glossary = await import('../../src/glossary/repository.js');
  const other = await owner(db);
  await db.transaction(async c => {
    expect(await glossary.ensureGlossaryRevision(c,other)).toEqual({revision:0,entries:[]});
    expect((await c.query('SELECT revision FROM glossary_revisions WHERE owner_id=$1',[other])).rows).toEqual([{revision:0}]);
    expect(await readers.findWebDocument(c,f.o,f.d)).toMatchObject({kind:'article',original_filename:null});
    expect(await readers.findWebDocument(c,other,f.d)).toBeUndefined();
    expect(await readers.findWebSource(c,f.o,f.d,f.s)).toMatchObject({asset_id:f.a,sha256:'a'.repeat(64),snapshot_sha256:'c'.repeat(64)});
    expect(await readers.findWebSource(c,other,f.d,f.s)).toBeUndefined();
    expect(await readers.findWebParse(c,f.o,f.d,f.s,f.p)).toMatchObject({ir_asset_id:f.a});
    await readers.setRequestedWebJob(c,f.o,f.d,f.id);
    expect(await readers.findWebDocument(c,f.o,f.d)).toMatchObject({requested_web_job_id:f.id});
    expect(await f.jobs.findWebJobByInput(c,f.o,f.d,1,'f'.repeat(64))).toMatchObject({id:f.id});
  });
});
it('reassigns an expired slot without acquiring its former owner lock', async () => {
  const db = await database(), f = await jobFixture(db), g = await jobFixture(db);
  await db.transaction(c => f.jobs.startWebJobLease(c,{ownerId:f.o,jobId:f.id,slotId:1,leaseOwner:'old'}));
  await db.pool.query("UPDATE web_worker_slots SET lease_until=clock_timestamp()-interval '1 second' WHERE id=1");
  const old = await db.pool.connect();
  try {
    await old.query('BEGIN'); await old.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[f.o]);
    const next = await db.transaction(async c => {
      await c.query("SET LOCAL lock_timeout='100ms'");
      return f.jobs.startWebJobLease(c,{ownerId:g.o,jobId:g.id,slotId:1,leaseOwner:'new'});
    });
    expect(next).toMatchObject({ownerId:g.o,slotEpoch:2});
  } finally { await old.query('ROLLBACK'); old.release(); }
});
it('checks fresh lease time after row-lock waits, not transaction start time', async () => {
  const db = await database(), f = await jobFixture(db);
  const lease = (await db.transaction(c => f.jobs.startWebJobLease(c,{ownerId:f.o,jobId:f.id,slotId:1,leaseOwner:'worker'})))!;
  const blocker = await db.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query("UPDATE web_worker_slots SET lease_until=clock_timestamp()+interval '100 milliseconds' WHERE id=1");
    const pending = db.transaction(c => f.jobs.assertJobLeaseCurrent(c,lease));
    const assertion = expect(pending).rejects.toMatchObject({name:'CheckpointConflictError'});
    await new Promise(resolve => setTimeout(resolve,180));
    await blocker.query('COMMIT'); await assertion;
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
});

it('fences fetch job reader results by owner/document even with nullable source/parse inputs', async () => {
  const db = await database(), f = await jobFixture(db), g = await web(db), id = randomUUID();
  await db.transaction(c => f.jobs.insertWebJob(c,{id,ownerId:f.o,authVersion:1,documentId:f.d,inputSha256:'e'.repeat(64),kind:'fetch-link',url:'https://example.com/fetch'}));
  await expect(db.pool.query('UPDATE web_jobs SET reader_version_id=$1 WHERE id=$2',[g.r,id])).rejects.toMatchObject({code:'23503'});
  await db.pool.query('UPDATE web_jobs SET reader_version_id=$1 WHERE id=$2',[f.r,id]);
});

async function captureJobIdentityFixture(db: Database, differentSource: boolean) {
  const f = await jobFixture(db);
  const sourceId = differentSource ? randomUUID() : f.s;
  const parseId = `p_${'d'.repeat(64)}`, readerId = randomUUID();
  if (differentSource) {
    await db.pool.query("INSERT INTO source_versions (id,owner_id,document_id,asset_id,sha256,bytes) VALUES ($1,$2,$3,$4,repeat('a',64),10)", [sourceId,f.o,f.d,f.a]);
    await db.pool.query("INSERT INTO web_sources (owner_id,document_id,source_version_id,url,scope,content_fingerprint,snapshot_sha256) VALUES ($1,$2,$3,'https://example.com/new','{}',repeat('d',64),repeat('c',64))", [f.o,f.d,sourceId]);
  }
  const readers = await import('../../src/web-readers/repository.js');
  await db.transaction(async c => {
    await readers.insertWebParse(c, { ownerId:f.o,documentId:f.d,sourceVersionId:sourceId,parseId,irAssetId:f.a,irSha256:'a'.repeat(64) });
    await readers.insertWebReaderVersion(c, { id:readerId,ownerId:f.o,documentId:f.d,sourceVersionId:sourceId,parseId,translationId:null,indexAssetId:f.a,translationStatus:'pending',warnings:[] });
  });
  const captureId = randomUUID(), id = randomUUID();
  await db.pool.query(`INSERT INTO web_captures
    (id,capture_id,owner_id,auth_version,session_id,idempotency_key,request_hash,manifest,translation_intent,staging_key,status)
    VALUES ($1,$2,$3,1,$4,$5,repeat('d',64),'{}','none',$6,'validating')`, [id,captureId,f.o,randomUUID(),captureId,randomUUID()]);
  return { ...f,captureId:id,sourceId,readerId };
}
it.each(['source','parse'])('rejects capture completion with a translation job for a different %s', async identity => {
  const differentSource = identity === 'source';
  const db = await database(), f = await captureJobIdentityFixture(db,differentSource);
  const captures = await import('../../src/web-captures/repository.js');
  await expect(db.transaction(c => captures.completeWebCapture(c,f.o,f.captureId,0,{
    documentId:f.d,sourceVersionId:f.sourceId,readerVersionId:f.readerId,jobId:f.id,saveStatus:'original-saved',warnings:[],
  }))).rejects.toMatchObject({ code:'23503' });
  expect((await db.pool.query('SELECT status,job_id FROM web_captures WHERE id=$1', [f.captureId])).rows[0]).toEqual({ status:'validating',job_id:null });
});
it.each([
  ['source','INSERT'], ['source','UPDATE'], ['parse','INSERT'], ['parse','UPDATE'],
])('rejects a different %s in direct SQL capture %s', async (identity,operation) => {
  const db = await database(), f = await captureJobIdentityFixture(db,identity === 'source');
  if (operation === 'UPDATE') {
    await expect(db.pool.query(`UPDATE web_captures SET status='completed',document_id=$2,source_version_id=$3,
      reader_version_id=$4,job_id=$5,save_status='original-saved' WHERE id=$1`, [f.captureId,f.d,f.sourceId,f.readerId,f.id])).rejects.toMatchObject({ code:'23503' });
  } else {
    const id = randomUUID(), captureId = randomUUID();
    await expect(db.pool.query(`INSERT INTO web_captures
      (id,capture_id,owner_id,auth_version,session_id,idempotency_key,request_hash,manifest,translation_intent,staging_key,status,document_id,source_version_id,reader_version_id,job_id,save_status)
      VALUES ($1,$2,$3,1,$4,$5,repeat('d',64),'{}','none',$6,'completed',$7,$8,$9,$10,'original-saved')`,
    [id,captureId,f.o,randomUUID(),captureId,randomUUID(),f.d,f.sourceId,f.readerId,f.id])).rejects.toMatchObject({ code:'23503' });
  }
});
it.each(['source','parse'])('retains matching and null-job capture completion beside another %s', async identity => {
  const differentSource = identity === 'source';
  const db = await database(), f = await captureJobIdentityFixture(db,differentSource);
  const captures = await import('../../src/web-captures/repository.js');
  await db.transaction(async c => {
    expect(await captures.completeWebCapture(c,f.o,f.captureId,0,{
      documentId:f.d,sourceVersionId:f.sourceId,readerVersionId:f.readerId,jobId:null,saveStatus:'original-saved',warnings:[],
    })).toBe(true);
    expect(await captures.findWebCapture(c,f.o,f.captureId)).toMatchObject({ status:'completed',source_version_id:f.sourceId,reader_version_id:f.readerId,job_id:null });
  });
  const matching = randomUUID(), captureId = randomUUID();
  await db.pool.query(`INSERT INTO web_captures
    (id,capture_id,owner_id,auth_version,session_id,idempotency_key,request_hash,manifest,translation_intent,staging_key,status)
    VALUES ($1,$2,$3,1,$4,$5,repeat('d',64),'{}','translate',$6,'validating')`, [matching,captureId,f.o,randomUUID(),captureId,randomUUID()]);
  await db.transaction(async c => {
    expect(await captures.completeWebCapture(c,f.o,matching,0,{
      documentId:f.d,sourceVersionId:f.s,readerVersionId:f.r,jobId:f.id,saveStatus:'original-saved',warnings:[],
    })).toBe(true);
    expect(await captures.findWebCapture(c,f.o,matching)).toMatchObject({ status:'completed',source_version_id:f.s,reader_version_id:f.r,job_id:f.id });
  });
});
