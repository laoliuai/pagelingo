import { spawn } from 'node:child_process';
import type { MaintenanceResult } from '../../src/document-lifecycle/maintenance.js';
/** Fresh process, explicit owned schema and storage, with a controlled local-unlink failure. */
export async function documentMaintenanceProcess(schema: string, dataDir: string, failKey=''): Promise<MaintenanceResult> {
  const code=`
    import { openDatabase } from './src/db/database.ts';
    import { createLocalObjectStore } from './src/storage/local-object-store.ts';
    import { runDocumentMaintenance } from './src/document-lifecycle/maintenance.ts';
    const [schema,dataDir,failKey]=process.argv.slice(1);
    const db=openDatabase(process.env.PAGELINGO_TEST_DATABASE_URL,schema);
    const local=createLocalObjectStore(dataDir);
    const store={ ...local,async deleteUnreferenced(key) { if(key===failKey) throw new Error('Injected owned-file unlink failure'); return local.deleteUnreferenced(key); } };
    try { console.log(JSON.stringify(await runDocumentMaintenance({ db,store,dataDir,signal:new AbortController().signal },{ limit:100 }))); }
    finally { await db.close(); }
  `;
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code,schema,dataDir,failKey],{
      cwd:new URL('../../',import.meta.url),env:{ PATH:process.env.PATH,PAGELINGO_TEST_DATABASE_URL:process.env.PAGELINGO_TEST_DATABASE_URL },stdio:['ignore','pipe','pipe'],
    });
    let stdout='',stderr=''; child.stdout.on('data',value=>{stdout+=value;}); child.stderr.on('data',value=>{stderr+=value;});
    child.once('error',reject); child.once('exit',code=>{
      if(code!==0) reject(new Error(`Maintenance process failed (${code}): ${stderr}`));
      else { try { resolve(JSON.parse(stdout)); } catch(error) { reject(error); } }
    });
  });
}
