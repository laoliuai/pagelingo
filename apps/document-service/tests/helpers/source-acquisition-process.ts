import { openDatabase } from '../../src/db/database.js';
import { createLocalObjectStore } from '../../src/storage/local-object-store.js';
import { startWebJobLease } from '../../src/web-jobs/repository.js';
import { resolveSourceIdentity } from '../../src/source-adapters/identity.js';
import { acquireSourceMaterial } from '../../src/source-adapters/repository.js';
const [schema,ownerId,jobId,directory,mode] = process.argv.slice(2);
const db=openDatabase(process.env.PAGELINGO_TEST_DATABASE_URL!,schema!);
try {
  const lease=await db.transaction(c=>startWebJobLease(c,{ownerId:ownerId!,jobId:jobId!,slotId:1,leaseOwner:`acquisition-${process.pid}`}));
  if(!lease) throw new Error('Missing process lease');
  await resolveSourceIdentity(db,lease,{provider:'github',id:'12345'});
  const acquisition=await acquireSourceMaterial(lease,{db,store:createLocalObjectStore(directory!),signal:new AbortController().signal},{role:'metadata',filename:'repository.json',mediaType:'application/json',url:'https://api.github.com/repos/Org/Repo',maxBytes:1024,body:(async function*(){if(mode==='restart') throw new Error('Restart must not read different bytes'); yield Buffer.from('first');})()});
  process.stdout.write(JSON.stringify({pid:process.pid,acquisition}));
} finally {await db.close();}
