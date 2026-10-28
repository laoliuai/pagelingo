import type { SourceTransport } from '../../src/source-adapters/types.js';
export const pdf = Buffer.from('%PDF-1.7\npaper fixture\n%%EOF');
export function atom(baseId = '2401.12345', version = 1) {
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/${baseId}v${version}</id><title>Paper version ${version}</title><author><name>Alice &amp; Bob</name></author><summary>Fixed source summary</summary><published>2024-01-01T00:00:00Z</published><updated>2024-01-02T03:04:05Z</updated></entry></feed>`;
}
export function arxivTransport(options: { baseId?: string; version?: number; pdf?: Uint8Array; feed?: string; interrupt?: boolean; requests?: string[]; status?: number; retryAfter?: string; closed?: () => void } = {}): SourceTransport {
  return {
    async readSmall(url) { options.requests?.push(url); if (!url.startsWith('https://export.arxiv.org/api/query?id_list=')) throw new Error(`Unexpected metadata URL ${url}`); return new Response(options.feed ?? atom(options.baseId, options.version), { status: options.status ?? 200, headers: options.retryAfter ? { 'retry-after': options.retryAfter } : {} }); },
    async downloadPdf(url, _input, consume) {
      options.requests?.push(url);
      if (url !== `https://arxiv.org/pdf/${options.baseId ?? '2401.12345'}v${options.version ?? 1}`) throw new Error(`Unexpected PDF URL ${url}`);
      try { return await consume((async function* () { const bytes = options.pdf ?? pdf; yield bytes.subarray(0, 3); if (options.interrupt) throw new Error('Controlled interrupted PDF'); yield bytes.subarray(3); })(), { status: options.status ?? 200, url, headers: new Headers(options.retryAfter ? { 'retry-after': options.retryAfter } : {}) }); }
      finally { options.closed?.(); }
    },
    async downloadResource() { throw new Error('No arXiv resources'); },
  };
}
