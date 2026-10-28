import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { test } from './extension-fixture';

// The gateway injects transport faults; all authorization, admission, publication and
// organization reads are handled by the real service and disposable PostgreSQL schema.
test('native classification choices survive offline and lost ACK after owned taxonomy deletion', async ({ control, context, page, extensionId, request }) => {
  test.skip(!process.env.PAGELINGO_TEST_DATABASE_URL, 'Requires an explicitly owned temporary PostgreSQL run');
  test.setTimeout(90000);
  const child=spawn(process.execPath,['tests/start-service.mjs'],{cwd:resolve('../web'),env:{...process.env},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
  const base='http://127.0.0.1:4338';
  let gateway:ReturnType<typeof createServer>|undefined;
  try {
    await expect.poll(async()=>{try{return (await request.get(`${base}/health/ready`)).status();}catch{return 0;}},{timeout:20000,message:'Owned real API must start'}).toBe(200);
    expect(child.exitCode,output).toBeNull();
    const auth=await request.post(`${base}/api/v1/auth/login`,{headers:{Origin:base},data:{username:'admin',password:'test-admin-password'}});expect(auth.status()).toBe(200);
    const session=await auth.json();const headers={Origin:base,'X-CSRF-Token':session.csrfToken};
    const collection=await (await request.post(`${base}/api/v1/collections`,{headers,data:{name:'插件研究'}})).json();
    const tag=await (await request.post(`${base}/api/v1/tags`,{headers,data:{name:'插件方法'}})).json();
    const code=await (await request.post(`${base}/api/v1/devices/pairing-codes`,{headers,data:{}})).json();
    let attempt=0;const requests:{key:string|undefined;body:unknown}[]=[];
    gateway=createServer(async(req,res)=>{
      try {
        const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks);
        const capture=req.url==='/api/v1/captures'&&req.method==='POST';
        if(capture){attempt++;requests.push({key:req.headers['idempotency-key'] as string|undefined,body:JSON.parse(body.toString())});if(attempt===1){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'OFFLINE'}}));return;}}
        const response=await fetch(`${base}${req.url}`,{method:req.method,headers:{...(req.headers.authorization?{Authorization:req.headers.authorization}:{}),...(req.headers['content-type']?{'Content-Type':req.headers['content-type']}:{}),...(req.headers['idempotency-key']?{'Idempotency-Key':String(req.headers['idempotency-key'])}:{})},...(body.length?{body}:{} )});
        const bytes=Buffer.from(await response.arrayBuffer());
        if(capture&&attempt===2&&response.status===201){expect((await request.delete(`${base}/api/v1/collections/${collection.id}`,{headers})).status()).toBe(204);expect((await request.delete(`${base}/api/v1/tags/${tag.id}`,{headers})).status()).toBe(204);res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'ACK_LOST'}}));return;}
        res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')??'application/json'});res.end(bytes);
      }catch(e){res.writeHead(500);res.end(String(e));}
    });
    await new Promise<void>(resolve=>gateway!.listen(0,'127.0.0.1',resolve));
    const site=`http://127.0.0.1:${(gateway.address() as {port:number}).port}`;
    const paired=await control.evaluate(async value=>chrome.runtime.sendMessage({type:'archive:pair',...value}),{origin:site,code:code.code});expect(paired.ok,JSON.stringify(paired)).toBe(true);
    await page.goto('http://127.0.0.1:4317/archive-source.html');
    const popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);await page.bringToFront();await popup.reload();
    await popup.getByText('保存到集合与标签',{exact:true}).click();
    await popup.getByLabel('所属集合').selectOption({label:'插件研究'});await popup.getByLabel('插件方法',{exact:true}).check();
    await popup.screenshot({path:'../../.superpowers/sdd/2026-10-28-learning-site-s4/task-6-evidence/extension-classification.png'});
    await popup.getByRole('button',{name:'保存当前页面原文',exact:true}).click();
    await expect.poll(async()=>requests.length,{timeout:15000}).toBeGreaterThanOrEqual(1);
    const status=()=>control.evaluate(async()=>chrome.runtime.sendMessage({type:'archive:status'}));
    await expect.poll(async()=>(await status()).value.items[0]?.state).toBe('retry');
    await control.evaluate(async()=>chrome.runtime.sendMessage({type:'archive:retry'}));
    await expect.poll(async()=>requests.length).toBeGreaterThanOrEqual(2);
    await expect.poll(async()=>(await status()).value.items[0]?.state).toBe('retry');
    await control.evaluate(async()=>chrome.runtime.sendMessage({type:'archive:retry'}));
    await expect.poll(async()=>(await status()).value.items[0]?.state,{timeout:15000}).toBe('completed');
    expect(requests.length).toBeGreaterThanOrEqual(3);for(const item of requests)expect(item).toEqual(requests[0]);
    expect(requests[0].body).toMatchObject({organization:{collectionId:collection.id,tagIds:[tag.id]}});
    const saved=(await status()).value.items[0];expect(saved.warnings).toContain('部分收藏分类已删除，原文已保留。');
    const library=await (await request.get(`${base}/api/v1/library`)).json();expect(library.total).toBe(1);expect(library.items[0].organization).toMatchObject({collectionId:null,tagIds:[]});expect(library.items[0].document.saveStatus).toBe('original-saved');
    expect((await (await request.get(`${base}/__test/metrics`)).json()).modelCalls).toBe(0);
  } finally {
    if(gateway)await new Promise<void>(resolve=>gateway!.close(()=>resolve()));
    if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}
  }
});
