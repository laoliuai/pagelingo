import type { SourceReference } from './types.js';
/** Only public repository roots and explicit abs/pdf identities are provider sources. */
export function classifySourceUrl(value: string): SourceReference | null {
  let url: URL; try { url = new URL(value); } catch { return null; }
  if (/\/(?:\.|\.\.)(?:\/|$)/.test(value)) return null;
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.search || /%|\\/.test(value)) return null;
  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    const match = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})\/?$/.exec(url.pathname);
    if (!match) return null;
    const owner = match[1]!, repo = match[2]!.replace(/\.git$/, '');
    if (!repo || repo === '.' || repo === '..') return null;
    return { provider: 'github', owner, repo, url: `https://github.com/${owner}/${repo}` };
  }
  if (!['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname)) return null;
  const match = /^\/(abs|pdf)\/((?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z.-]*\/\d{2}(?:0[1-9]|1[0-2])\d{3}))(?:v([1-9]\d*))?(\.pdf)?\/?$/.exec(url.pathname);
  if (!match || (match[4] && match[1] !== 'pdf')) return null;
  const version = match[3] ? Number(match[3]) : null;
  if (version !== null && !Number.isSafeInteger(version)) return null;
  return { provider: 'arxiv', baseId: match[2]!, version, url: `https://arxiv.org/abs/${match[2]}${version === null ? '' : `v${version}`}` };
}
