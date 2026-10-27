import { openDatabase } from '../../src/db/database.js';
import { startWebJobLease } from '../../src/web-jobs/repository.js';
const [schema,ownerId,jobId,slot] = process.argv.slice(2);
const db = openDatabase(process.env.PAGELINGO_TEST_DATABASE_URL!,schema!);
try {
  const lease = await db.transaction(client => startWebJobLease(client,{ownerId:ownerId!,jobId:jobId!,slotId:Number(slot),leaseOwner:`process-${process.pid}`}));
  process.stdout.write(JSON.stringify(lease));
} finally { await db.close(); }
