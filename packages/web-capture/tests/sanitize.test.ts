import { describe, expect, it } from 'vitest';
import { sanitizeNodeSnapshot } from '../src/node.js';
import { defaultCaptureLimits, sanitizedSnapshotSchema } from '@pagelingo/document-contracts';

export const input = (html: string) => ({ html, url: 'https://e.test/article', scope: { kind: 'article' as const, rootNodeId: 'root', completeWithinScope: true, warnings: [] } });

describe('snapshot sanitization', () => {
  it('removes_active_content_after_resource_rewrite', () => {
    const snapshot = sanitizeNodeSnapshot(input('<article><script>globalThis.executedScripts++</script><p onclick="x()">Read me<img src="/pic.png" onerror="x()"></p><iframe src="https://evil.test"></iframe><form><input value="secret"><textarea>secret</textarea></form><style>@import "https://evil.test";</style></article>'));
    expect(snapshot.html).not.toMatch(/script|onclick|onerror|iframe|<form|secret|@import|src=/i);
    expect(snapshot.resources).toEqual([{ id: 'r_1', url: 'https://e.test/pic.png', role: 'image' }]);
    expect(snapshot.html).toContain('data-pl-resource="r_1"');
    expect(snapshot.scope.completeWithinScope).toBe(false);
    expect(sanitizedSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
  it('preserves_tables_math_and_repeat_ids', () => {
    const math = '<svg viewBox="0 0 10 10"><defs><path id="x" d="M0 0L1 1"></path></defs><use href="#x"></use></svg>';
    const snapshot = sanitizeNodeSnapshot(input(`<article><table><tr><th id="__proto__">A</th><td><strong>B</strong></td></tr></table><p id="same">repeat ${math}</p><p id="same">repeat ${math}</p><math><mfrac><mi>x</mi><mn>2</mn></mfrac></math></article>`));
    expect(snapshot.html).toContain('<table');
    expect(snapshot.html).toContain('<mfrac');
    expect(snapshot.html.match(/<use /g)).toHaveLength(2);
    const definitions = [...snapshot.html.matchAll(/<path[^>]* id="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(definitions).size).toBe(2);
    for (const id of definitions) expect(snapshot.html).toContain(`href="#${id}"`);
    expect(new Set(snapshot.nodeIds).size).toBe(snapshot.nodeIds.length);
    expect(snapshot.nodeIds.length).toBeGreaterThan(5);
  });
  it('drops namespace mutation, untrusted state and dangerous CSS without dropping prose', () => {
    const snapshot = sanitizeNodeSnapshot(input('<article data-secret="secret"><p style="color:red;position:fixed;background:url(https://evil.test);font-weight:bold" id="constructor">Safe</p><div hidden>secret</div><div data-pl-owned>translation</div><span data-pl-source>original</span><svg><use href="https://evil.test/x.svg#x"/><foreignObject><iframe src="https://evil.test"/></foreignObject></svg><math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>"></table></mtext></math></article>'));
    expect(snapshot.html).not.toMatch(/secret|translation|position|url\(|foreignObject|https:\/\/evil|onerror/i);
    expect(snapshot.html).toContain('original');
    expect(snapshot.html).toContain('font-weight:bold');
    expect(snapshot.warnings.length).toBeGreaterThan(0);
  });
  it('rejects byte, node and depth budgets before DOM sanitization', () => {
    expect(() => sanitizeNodeSnapshot(input('<p>hello</p>'), { ...defaultCaptureLimits, maxHtmlBytes: 4 })).toThrow(/budget/i);
    expect(() => sanitizeNodeSnapshot(input('<i>x</i>'.repeat(40)), { ...defaultCaptureLimits, maxDomNodes: 20 })).toThrow(/budget/i);
    expect(() => sanitizeNodeSnapshot(input('<div>'.repeat(20) + 'x' + '</div>'.repeat(20)), { ...defaultCaptureLimits, maxDepth: 10 })).toThrow(/budget/i);
  });
});
it('wraps top-level prose and rejects resource, math-expansion and hidden CSS losses honestly', () => {
  const snapshot = sanitizeNodeSnapshot(input('Top-level text <strong>bold</strong><p style="display:none">hidden secret</p>'));
  expect(snapshot.html).toMatch(/<div[^>]*>Top-level text/);
  expect(snapshot.html).not.toContain('hidden secret');
  expect(snapshot.scope.completeWithinScope).toBe(false);
  const expanded = '<svg><defs><g id="a"><path d="M0 0"/></g><g id="b"><use href="#a"/><use href="#a"/></g><g id="c"><use href="#b"/><use href="#b"/></g></defs><use href="#c"/><use href="#c"/></svg>';
  expect(sanitizeNodeSnapshot(input(expanded), { ...defaultCaptureLimits, maxMathNodes: 15 }).warnings.join(' ')).toMatch(/expansion/);
});
it('replays sanitized snapshots without changing node IDs, resource bindings or formula references', () => {
  const first = sanitizeNodeSnapshot(input('<p>Text<img src="/x.png"><svg><defs><path id="glyph" d="M0 0L1 1"/></defs><use href="#glyph"/></svg></p>'));
  const second = sanitizeNodeSnapshot({ html: first.html, url: first.sourceUrl, scope: first.scope }, undefined, first.resources);
  expect(second).toEqual(first);
});
it('unwraps original wrappers before hiding rules in every extension display mode', () => {
  const expected = sanitizeNodeSnapshot(input('<p>Original <strong>evidence</strong></p>'));
  for (const mode of ['translation', 'source', 'bilingual']) {
    const html = `<p><span data-pl-source="b" style="display:${mode === 'translation' ? 'none' : 'contents'}">Original <strong>evidence</strong></span><span data-pl-owned="translation" style="display:${mode === 'source' ? 'none' : 'block'}">译文</span></p>`;
    const snapshot = sanitizeNodeSnapshot(input(html));
    expect(snapshot).toEqual(expected);
    expect(sanitizeNodeSnapshot({ html: snapshot.html, url: snapshot.sourceUrl, scope: snapshot.scope }, undefined, snapshot.resources)).toEqual(expected);
  }
});
it('keeps a source anchor when the captured scope is the hidden original wrapper itself', () => {
  const expected = sanitizeNodeSnapshot(input('Original evidence'));
  const snapshot = sanitizeNodeSnapshot(input('<span data-pl-source="b" style="display:none">Original evidence</span>'));
  expect(snapshot).toEqual(expected);
});
