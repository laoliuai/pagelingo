import { spawn } from 'node:child_process';
/** Disposable child can be killed after the isolated writer produced its durable key, before publication. */
export function exportProcess(schema: string,dataDir: string) {
  const code = `
    import { openDatabase } from './src/db/database.ts';
    import { readConfig } from './src/config.ts';
    import { createLocalObjectStore } from './src/storage/local-object-store.ts';
    import { claimWebJob } from './src/web-jobs/lease.ts';
    import { runWebJob } from './src/web-jobs/translation-runner.ts';
    const [schema,dataDir] = process.argv.slice(1);
    const db = openDatabase(process.env.PAGELINGO_TEST_DATABASE_URL,schema);
    const config = readConfig({ PAGELINGO_SITE_MODE:'test',PAGELINGO_SITE_ORIGIN:'http://127.0.0.1:5174',PAGELINGO_DATA_DIR:dataDir,DATABASE_URL:process.env.PAGELINGO_TEST_DATABASE_URL,
      PAGELINGO_MASTER_KEY_ID:'test',PAGELINGO_MASTER_KEYS_JSON:JSON.stringify({test:Buffer.alloc(32,9).toString('base64')}) });
    const local = createLocalObjectStore(dataDir);
    const store = { ...local,async *read(key,range) { process.send({type:'output-ready',key}); await new Promise(()=>{}); yield* local.read(key,range); } };
    try { const lease = await claimWebJob('crash-fixture',db); process.send({type:'lease',lease}); await runWebJob(lease,{db,store,config,signal:new AbortController().signal}); }
    finally { await db.close(); }
  `;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code,schema,dataDir],{cwd:new URL('../../',import.meta.url),env:{PATH:process.env.PATH,PAGELINGO_TEST_DATABASE_URL:process.env.PAGELINGO_TEST_DATABASE_URL},stdio:['ignore','pipe','pipe','ipc']});
  let stderr=''; child.stderr!.on('data',value=>{stderr+=value;});
  const ready=new Promise<string>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Export child timeout')),15_000);
    child.on('message',message=>{ if((message as {type?:string}).type==='output-ready'){clearTimeout(timer);resolve((message as {key:string}).key);} });
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Export child exit ${code}: ${stderr}`));});
  });
  return {child,ready};
}
