import { fetch as undiciFetch } from 'undici';
import { abortable, createPinnedAgent, type PinnedOptions } from '../network/pinned-transport.js';
import type { SourceTransport } from './types.js';
type Options = Pick<PinnedOptions, 'lookup' | 'connector' | 'httpConnector'> & { timeoutMs?: number; firstByteMs?: number; idleMs?: number };
/** No caller-supplied credential or arbitrary header capability. Each hop owns one pinned agent. */
export function createSourceTransport(options: Options = {}): SourceTransport {
  const timeoutMs = options.timeoutMs ?? 120_000, firstByteMs = options.firstByteMs ?? 20_000, idleMs = options.idleMs ?? 20_000;
  if (![timeoutMs, firstByteMs, idleMs].every(n => Number.isSafeInteger(n) && n > 0) || timeoutMs > 120_000 || firstByteMs > 20_000 || idleMs > 20_000) throw new Error('Invalid source transport limits');
  async function consumeResponse<T>(value: string, input: { maxBytes: number; signal: AbortSignal }, accept: string, consume: (body: AsyncIterable<Uint8Array>, response: { status: number; url: string; headers: Headers }) => Promise<T>, totalMs = timeoutMs): Promise<T> {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) throw new Error('Invalid source byte limit');
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('Source transport aborted'));
    input.signal.addEventListener('abort', abort, { once: true }); if (input.signal.aborted) abort();
    const total = setTimeout(abort, totalMs);
    let first: ReturnType<typeof setTimeout> | undefined;
    try {
      let url = new URL(value);
      for (let hop = 0; hop <= 5; hop++) {
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid source URL');
        url.hash = ''; first = setTimeout(abort, firstByteMs);
        const agent = await createPinnedAgent(url, controller.signal, options);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const headers = new Headers({ accept });
          if (url.hostname === 'api.github.com') headers.set('X-GitHub-Api-Version', '2026-03-10');
          const response = await abortable(undiciFetch(url, { headers: [...headers.entries()], dispatcher: agent, redirect: 'manual', signal: controller.signal }), controller.signal);
          clearTimeout(first); reader = response.body?.getReader();
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location'); if (!location || hop === 5) throw new Error('Invalid source redirect');
            const next = new URL(location, url); if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('HTTPS downgrade');
            url = next; continue;
          }
          if (Number(response.headers.get('content-length')) > input.maxBytes) throw new Error('Source response too large');
          const body = (async function* () {
            let bytes = 0;
            while (reader) {
              controller.signal.throwIfAborted();
              const idle = setTimeout(abort, idleMs);
              let chunk: ReadableStreamReadResult<Uint8Array>;
              try { chunk = await abortable(reader.read(), controller.signal); } finally { clearTimeout(idle); }
              if (chunk.done) break;
              bytes += chunk.value.byteLength; if (bytes > input.maxBytes) throw new Error('Source response too large');
              yield chunk.value;
            }
          })();
          return await abortable(consume(body, { status: response.status, url: url.href, headers: new Headers([...response.headers.entries()]) }), controller.signal);
        } finally { clearTimeout(first); void reader?.cancel().catch(() => {}); await agent.destroy(); }
      }
      throw new Error('Too many source redirects');
    } finally { clearTimeout(first); clearTimeout(total); input.signal.removeEventListener('abort', abort); controller.abort(); }
  }
  return {
    async readSmall(url, input) {
      if (input.maxBytes > 8 * 1024 * 1024) throw new Error('Small response limit exceeded');
      return consumeResponse(url, input, input.accept, async (body, response) => {
        const chunks: Uint8Array[] = []; for await (const chunk of body) chunks.push(chunk);
        const result = new Response([204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks), { status: response.status, headers: response.headers });
        Object.defineProperty(result, 'url', { value: response.url }); return result;
      });
    },
    downloadPdf: (url, input, consume) => consumeResponse(url, input, 'application/pdf', consume),
    downloadResource: (url, input, consume) => {
      if (input.maxBytes > 16 * 1024 * 1024) throw new Error('Resource response limit exceeded');
      return consumeResponse(url, input, input.accept, consume, Math.min(timeoutMs, 20_000));
    },
  };
}
