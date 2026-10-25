import { createServer } from 'node:http';
import { fixtureNames, renderFixture } from './fixtures.ts';

const names = new Set(fixtureNames);
const emptyMetrics = () => ({ requests: 0, aborted: 0, active: 0, peak: 0, attempts: {},chatRequests:0,chatBodies:[] });
let metrics = emptyMetrics();
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:4317');
  if (url.pathname === '/llm/metrics') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(metrics));
    return;
  }
  if (url.pathname === '/llm/reset' && request.method === 'POST') {
    metrics = emptyMetrics();
    response.writeHead(204); response.end(); return;
  }
  if (url.pathname === '/llm/chat/completions' && request.method === 'POST') {
    metrics.requests++;
    const current = metrics;
    current.active++; current.peak = Math.max(current.peak, current.active);
    response.on('close', () => { current.active--; if (!response.writableEnded) current.aborted++; });
    if (request.headers.authorization !== 'Bearer local-test-secret') {
      response.writeHead(401); response.end('Unauthorized'); return;
    }
    try {
      let input = '';
      for await (const chunk of request) input += chunk;
      const body = JSON.parse(input);
      if(body.model.startsWith('assistant-')){
        current.chatRequests++;current.chatBodies.push(body);
        if(body.model==='assistant-error-model'){response.writeHead(503);response.end('local-test-secret private provider data');return;}
        const content=body.messages[0].content.startsWith('Summarize')?'较早对话的摘要：用户正在了解 NumPy。':'这是 **np.reshape** 的解释。\n\n```python\nresult = np.reshape(x, (2, 3))\n    print(result)\n```\n\n[unsafe](javascript:alert(1)) <script>globalThis.assistantUnsafe = true</script>\n\n![remote diagram](http://127.0.0.1:4317/assistant-tracking)';
        const usage={prompt_tokens:100,completion_tokens:40,total_tokens:140};
        if(!body.stream){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}],usage}));return;}
        response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
        const frame=value=>response.write(`data: ${JSON.stringify(value)}\n\n`);
        frame({choices:[{index:0,delta:{content:content.slice(0,18)}}]});
        await new Promise(r=>setTimeout(r,body.model==='assistant-long-model'?5000:body.model==='assistant-slow-model'?1200:30));if(response.destroyed)return;
        frame({choices:[{index:0,delta:{content:content.slice(18)},finish_reason:'stop'}]});frame({choices:[],usage});response.end('data: [DONE]\n\n');return;
      }
      const data = JSON.parse(body.messages[1].content);
      for (const block of data.blocks) current.attempts[block.id] = (current.attempts[block.id] ?? 0) + 1;
      if (body.model === 'http-error-model') { response.writeHead(503); response.end('local-test-secret private error body'); return; }
      const translations = data.blocks.map((block) => ({
        id: block.id, text: body.model === 'broken-model' ? '损坏的结构。' : `${block.continuation?.prefix ?? ''}测试译文：${block.protectedText.slice(block.continuation?.prefix.length ?? 0)}`,
      }));
      const delay = body.model === 'cancellation-model' && data.blocks[0].id !== 'u0:0' ? 5000 : body.model === 'slow-model' ? 300 : 40;
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (response.destroyed) return;
      if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const content = JSON.stringify({ translations });
        const frame = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
        frame({ choices: [{ index: 0, delta: { content: content.slice(0, 20) } }] });
        if (body.model === 'slow-stream-model') {
          await new Promise((r) => setTimeout(r, 16000));
          if (response.destroyed) return;
          response.write(': heartbeat\n\n');
          await new Promise((r) => setTimeout(r, 16000));
          if (response.destroyed) return;
        }
        frame({ choices: [{ index: 0, delta: { content: content.slice(20) }, finish_reason: 'stop' }] });
        frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
        response.end('data: [DONE]\n\n'); return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations }) } }] }));
    } catch { response.writeHead(400); response.end('Invalid test request'); }
    return;
  }
  const name = url.pathname.slice(1).replace(/\.html$/, '') || 'arxiv';
  if (!names.has(name)) { response.writeHead(404); response.end('Not found'); return; }
  try {
    const content = renderFixture(name);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(content);
  } catch { response.writeHead(500); response.end('Fixture unavailable'); }
});
server.listen(4317, '127.0.0.1');
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
