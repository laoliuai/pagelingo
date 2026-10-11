/** URL is one application identity, not a requirement of the document engine. */
export function webDocumentKey(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('不支持的文章地址。');
  for (const key of [...url.searchParams.keys()])
    if (/^utm_/i.test(key) || /^(fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  if (!/^#(?:!\/|\/)/.test(url.hash)) url.hash = '';
  return `web:${url.href}`;
}

export function historyEvictions(
  records: readonly { key: string; updatedAt: number; bytes: number }[],
  limits: { count: number; bytes: number },
  protectedKeys: ReadonlySet<string> = new Set(),
): string[] {
  let count = records.length;
  let bytes = records.reduce((sum, r) => sum + r.bytes, 0);
  const remove: string[] = [];
  for (const record of [...records].sort((a, b) => a.updatedAt - b.updatedAt)) {
    if (count <= limits.count && bytes <= limits.bytes) break;
    if (protectedKeys.has(record.key)) continue;
    remove.push(record.key);
    count--;
    bytes -= record.bytes;
  }
  return remove;
}
