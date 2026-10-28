/** A handoff decision only. The site independently validates and resolves public source identity. */
export function sourceLinkKind(value: string): 'github' | 'arxiv' | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.search || /%|\\/.test(value) || /\/(?:\.|\.\.)(?:\/|$)/.test(value)) return null;
  if (['github.com', 'www.github.com'].includes(url.hostname)) {
    const match = /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\/?$/.exec(url.pathname);
    const repo = match?.[2]?.replace(/\.git$/, '');
    return repo && repo !== '.' && repo !== '..' ? 'github' : null;
  }
  if (!['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname)) return null;
  const match = /^\/(abs|pdf|html)\/((?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z.-]*\/\d{2}(?:0[1-9]|1[0-2])\d{3}))(?:v([1-9]\d*))?(\.pdf)?\/?$/.exec(url.pathname);
  return match && (!match[4] || match[1] === 'pdf') && (!match[3] || Number.isSafeInteger(Number(match[3]))) ? 'arxiv' : null;
}
