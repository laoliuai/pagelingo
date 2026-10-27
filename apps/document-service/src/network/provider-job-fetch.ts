import { fetch as undiciFetch, type Agent } from 'undici';
import { abortable, createPinnedAgent, validateLimits, type PinnedOptions } from './pinned-transport.js';
/** Provider-only HTTPS transport. The response owns its Agent until EOF, cancellation or deadline. */
export function createProviderJobFetch(options: PinnedOptions): typeof fetch {
  validateLimits(options);
  return async (input, init) => {
    let request: Request;
    try { request = new Request(input, init); } catch { throw new Error('Provider transport failed'); }
    const controller = new AbortController();
    let agent: Agent | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    let closed = false;
    const error = () => new Error('Provider transport failed');
    const close = async () => {
      if (closed) return; closed = true;
      clearTimeout(timer); request.signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', fail);
      controller.abort(); void reader?.cancel().catch(() => {}); await agent?.destroy();
    };
    const fail = () => { output?.error(error()); void close(); };
    const abort = () => controller.abort(error());
    const timer = setTimeout(abort, options.timeoutMs);
    request.signal.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener('abort', fail, { once: true });
    if (request.signal.aborted) abort();
    try {
      controller.signal.throwIfAborted();
      const url = new URL(request.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw error();
      agent = await createPinnedAgent(url, controller.signal, options);
      const headers = new Headers(request.headers); headers.delete('host');
      const response = await abortable(undiciFetch(url, { method: request.method, headers: [...headers.entries()],
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await abortable(request.arrayBuffer(), controller.signal),
        dispatcher: agent, redirect: 'manual', signal: controller.signal }), controller.signal);
      if (response.status >= 300 && response.status < 400 || Number(response.headers.get('content-length')) > options.maxResponseBytes) throw error();
      reader = response.body?.getReader();
      if (!reader || request.method === 'HEAD' || [204, 205, 304].includes(response.status)) {
        await close(); return new Response(null, { status: response.status, headers: [...response.headers.entries()] });
      }
      let bytes = 0;
      const body = new ReadableStream<Uint8Array>({
        start(value) { output = value; },
        async pull(value) {
          try {
            const chunk = await abortable(reader!.read(), controller.signal);
            if (chunk.done) { await close(); value.close(); return; }
            bytes += chunk.value.byteLength;
            if (bytes > options.maxResponseBytes) throw error();
            value.enqueue(chunk.value);
          } catch { if (!closed) { value.error(error()); await close(); } }
        },
        async cancel() { await close(); },
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, headers: [...response.headers.entries()] });
    } catch { await close(); throw error(); }
  };
}
