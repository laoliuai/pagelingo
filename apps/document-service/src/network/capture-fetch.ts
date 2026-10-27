import { fetch as undiciFetch } from 'undici';
import { abortable, createPinnedAgent, validateLimits, type PinnedOptions } from './pinned-transport.js';
/** Public, credential-free GET/HEAD, bounded across at most five independently pinned redirects. */
export function createCaptureFetch(options: PinnedOptions): typeof fetch {
  validateLimits(options);
  return async (input, init) => {
    let request: Request;
    try { request = new Request(input, init); } catch { throw new Error('Capture transport failed'); }
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('Capture transport failed'));
    request.signal.addEventListener('abort', abort, { once: true }); if (request.signal.aborted) abort();
    const timer = setTimeout(abort, options.timeoutMs);
    try {
      if (!['GET', 'HEAD'].includes(request.method)) throw new Error('Invalid capture method');
      let url = new URL(request.url);
      const headers = new Headers();
      for (const name of ['accept', 'accept-language', 'user-agent']) {
        const value = request.headers.get(name); if (value) headers.set(name, value);
      }
      for (let hop = 0; hop <= 5; hop++) {
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid capture URL');
        url.hash = '';
        const agent = await createPinnedAgent(url, controller.signal, options);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const response = await abortable(undiciFetch(url, { method: request.method, headers: [...headers.entries()], dispatcher: agent, redirect: 'manual', signal: controller.signal }), controller.signal);
          reader = response.body?.getReader();
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location'); if (!location || hop === 5) throw new Error('Invalid redirect');
            const next = new URL(location, url);
            if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('HTTPS downgrade');
            url = next; continue;
          }
          if (Number(response.headers.get('content-length')) > options.maxResponseBytes) throw new Error('Response too large');
          const chunks: Uint8Array[] = []; let bytes = 0;
          if (reader) while (true) {
            const chunk = await abortable(reader.read(), controller.signal); if (chunk.done) break;
            bytes += chunk.value.byteLength; if (bytes > options.maxResponseBytes) throw new Error('Response too large'); chunks.push(chunk.value);
          }
          const result = new Response(request.method === 'HEAD' || [204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks), { status: response.status, headers: [...response.headers.entries()] });
          Object.defineProperty(result, 'url', { value: url.href }); return result;
        } finally { void reader?.cancel().catch(() => {}); await agent.destroy(); }
      }
      throw new Error('Too many redirects');
    } catch { throw new Error('Capture transport failed'); }
    finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); controller.abort(); }
  };
}
