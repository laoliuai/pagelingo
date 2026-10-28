import { openDatabase } from '../../src/db/database.js';
import { startWebJobLease } from '../../src/web-jobs/repository.js';
import { finishWebJob } from '../../src/web-jobs/lease.js';
import { withArxivRequest } from '../../src/source-adapters/rate-limit.js';
import { createSourceTransport } from '../../src/source-adapters/network.js';
import { wire, lookup } from './pinned-wire.js';
const [schema,ownerId,jobId,slot] = process.argv.slice(2);
const db = openDatabase(process.env.PAGELINGO_TEST_DATABASE_URL!,schema!);
let finish: (() => void) | undefined;
const send = (value: object) => process.send?.({ ...value, pid: process.pid, at: Date.now() });
process.on('message', async message => {
  if (message === 'finish') { finish?.(); return; }
  if (message === 'close') { await db.close(); process.disconnect?.(); return; }
  if (message !== 'run') return;
  try {
    const lease = await db.transaction(c => startWebJobLease(c,{ownerId:ownerId!,jobId:jobId!,slotId:Number(slot),leaseOwner:`source-process-${process.pid}`}));
    if (!lease) { send({ type: 'unclaimed' }); return; }
    const result = await withArxivRequest(db,lease,async () => {
      const socket = wire('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n%PDF-');
      const transport = createSourceTransport({ lookup,connector:async () => socket.stream });
      return transport.downloadPdf('https://arxiv.org/pdf/2401.12345v1',{maxBytes:100,signal:new AbortController().signal},async body => {
        for await (const _ of body) {} send({ type:'started' }); await new Promise<void>(resolve => { finish=resolve; });
        return socket;
      }).then(result => { send({type:'http-closed',closed:result.stream.destroyed}); return 'ok'; });
    });
    if (result.executed) await finishWebJob(lease,db,'completed');
    send({type:'result',executed:result.executed});
  } catch (error) { send({ type:'error',error:String(error) }); }
});
send({type:'ready'});
