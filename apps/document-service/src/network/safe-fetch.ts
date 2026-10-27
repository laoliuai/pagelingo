import { Agent, fetch as undiciFetch } from 'undici';
import { abortable, createPinnedAgent, defaultLookup, tlsConnector, type Connector } from './pinned-transport.js';
import type { Lookup } from './address-policy.js';
export type { Connector } from './pinned-transport.js';

/** Per-request direct Agent: no ambient proxy, global dispatcher, redirects, or DNS re-resolution. */
export function createOutboundFetch({ lookup = defaultLookup, connector = tlsConnector, timeoutMs, maxResponseBytes }: {
  lookup?: Lookup; connector?: Connector; timeoutMs: number; maxResponseBytes: number;
}): typeof fetch {
  if (![timeoutMs, maxResponseBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid outbound limits');
  return async (input, init) => {
    const controller = new AbortController();
    let request: Request;
    try { request = new Request(input, init); }
    catch { throw new Error('Provider transport failed'); }
    const onAbort = () => controller.abort(new Error('Outbound request cancelled'));
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new Error('Outbound request timed out')), timeoutMs);
    let agent: Agent | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      controller.signal.throwIfAborted();
      const url = new URL(request.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid outbound URL');
      agent = await createPinnedAgent(url, controller.signal, { lookup, connector });
      const headers = new Headers(request.headers);
      headers.delete('host');
      const response = await abortable(undiciFetch(url, { method: request.method, headers: [...headers.entries()],
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await abortable(request.arrayBuffer(), controller.signal),
        dispatcher: agent, redirect: 'manual', signal: controller.signal,
      }), controller.signal);
      if (response.status >= 300 && response.status < 400) throw new Error('Outbound redirects are forbidden');
      if (Number(response.headers.get('content-length')) > maxResponseBytes) throw new Error('Outbound response is too large');
      const chunks: Uint8Array[] = []; let bytes = 0;
      reader = response.body?.getReader();
      if (reader) while (true) {
        const chunk = await abortable(reader.read(), controller.signal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxResponseBytes) throw new Error('Outbound response is too large');
        chunks.push(chunk.value);
      }
      return new Response(['HEAD'].includes(request.method) || [204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks), {
        status: response.status, headers: [...response.headers.entries()],
      });
    } catch {
      // Never propagate DNS, socket, URL, or upstream diagnostics with secrets.
      throw new Error('Provider transport failed');
    } finally {
      clearTimeout(timer); request.signal.removeEventListener('abort', onAbort);
      controller.abort();
      void reader?.cancel().catch(() => {});
      await agent?.destroy();
    }
  };
}
