import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { createSourceTransport } from '../../apps/document-service/src/source-adapters/network.ts';
/** Explicit live-public declarations re-fetch only their bounded URLs before any service exists. */
export async function verifyLiveSamples(plan) {
  const transport=createSourceTransport(), records=[];
  for(const sample of plan.samples.filter(value=>value.kind==='live-public')) {
    const entries=[{url:sample.responseUrl??sample.url,accept:sample.accept??'text/html',input:sample.input},...sample.resources];
    for(const [index,entry] of entries.entries()) {
      const record={sampleId:sample.id,url:entry.url,startedAt:new Date().toISOString(),expectedSha256:entry.input.sha256}; records.push(record);
      const consume=async(body,response)=>{
        const hash=createHash('sha256');let bytes=0;
        const measured=(async function*(){for await(const chunk of body){bytes+=chunk.length;hash.update(chunk);yield chunk;}})();
        const file=`live-${sample.id}-${index}.body`; await pipeline(Readable.from(measured),createWriteStream(join(plan.output,file),{flags:'wx'}));
        Object.assign(record,{status:response.status,finalUrl:response.url,headers:Object.fromEntries(response.headers),bytes,sha256:hash.digest('hex'),finishedAt:new Date().toISOString(),file});
        assert.equal(response.status,200,'Live response status');assert.equal(bytes,entry.input.bytes,'Live input size changed');assert.equal(record.sha256,entry.input.sha256,'Live input hash changed');
      };
      try {
        const options={maxBytes:entry.input.bytes,signal:AbortSignal.timeout(120000)};
        if(entry.input.role==='pdf')await transport.downloadPdf(entry.url,options,consume);
        else await transport.downloadResource(entry.url,{...options,accept:entry.accept??'*/*'},consume);
      } catch(error){record.error=error.message;throw error;}
      finally{await writeFile(join(plan.output,'live-responses.json'),JSON.stringify(records,null,2));}
    }
  }
}
