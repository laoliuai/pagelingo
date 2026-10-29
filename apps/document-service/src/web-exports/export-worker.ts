import { constants } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { mkdir, link, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { assembleWebExport } from './assembly.js';
const { material,dataDir,workspace,objectKey } = workerData;
try {
  await mkdir(workspace,{ mode: 0o700 });
  await mkdir(join(dataDir,'objects'),{ recursive: true,mode: 0o700 });
  const output = join(workspace,'output.zip');
  await assembleWebExport(material,dataDir,output,AbortSignal.timeout(120_000));
  const objects = join(dataDir,'objects');
  if (await realpath(objects) !== objects) throw Error('Unsafe object directory');
  await link(output,join(objects,objectKey));
  const directory = await open(objects,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
  parentPort!.postMessage({ ok: true });
} catch (error) {
  const code = (error as { code?: string }).code === 'BUNDLE_UNSUPPORTED_SOURCE' ? 'BUNDLE_UNSUPPORTED_SOURCE' : 'EXPORT_FAILED';
  parentPort!.postMessage({ ok: false,code });
}
