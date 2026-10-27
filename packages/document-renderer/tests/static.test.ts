import { it, expect } from 'vitest';
import { buildReader, createStaticFilePlan } from '../src/index.js';
import { book, snapshot } from './fixtures.js';
it('generates deterministic local-script files lazily and escapes registration JSON',()=>{
  const ir=book(300);const build=buildReader(ir,snapshot(ir));const metadata={title:'</script>&\u2028',originalFilename:'book.pdf'};
  const first=createStaticFilePlan(build,metadata);expect(first.trustedAssets.some(a=>a.path.endsWith('.woff2'))).toBe(true);
  const iterator=first.generatedFiles[Symbol.iterator]();expect(iterator.next().value.path).toBe('render/index.html');
  Object.defineProperty(build.chunks[0],'blocks',{get(){throw Error('lazy chunk touched');}});
  expect(iterator.next().value.path).toBe('render/data/index.js');expect(()=>iterator.next()).toThrow('lazy chunk touched');
  const b=buildReader(ir,snapshot(ir));const a=[...createStaticFilePlan(b,metadata).generatedFiles];expect(a).toEqual([...createStaticFilePlan(b,metadata).generatedFiles]);
  expect(a[0].content).not.toContain('type="module"');expect(a[1].content).not.toContain('</script>');
  expect(a.some(f=>f.path==='render/data/c_000001.js')).toBe(true);
});

it('ships a closed trusted asset catalog whose hashes match pinned package bytes',async()=>{
  const {readFile}=await import('node:fs/promises');
  const {createHash}=await import('node:crypto');
  const {createRequire}=await import('node:module');
  const {dirname,join}=await import('node:path');
  const {fileURLToPath}=await import('node:url');
  const require=createRequire(import.meta.url);
  const build=buildReader(book(1),snapshot(book(1)));
  const plan=createStaticFilePlan(build,{title:'Book',originalFilename:'book.pdf'});
  for(const asset of plan.trustedAssets) {
    expect(asset.source.path).not.toMatch(/^(?:\/|[A-Z]:)/i);
    const base=asset.source.package==='katex'?dirname(require.resolve('katex/package.json')):fileURLToPath(new URL('../',import.meta.url));
    const bytes=await readFile(join(base,asset.source.path));
    expect(bytes.length).toBe(asset.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
  }
  const katexCss=await readFile(join(dirname(require.resolve('katex/package.json')),'dist/katex.min.css'),'utf8');
  for(const match of katexCss.matchAll(/url\(([^)]+)\)/g)) expect(plan.trustedAssets.some(a=>a.path===`assets/katex/${match[1]}`)).toBe(true);
});

it('encodes offline asset path segments without changing external URL queries or fragments', async () => {
  const { fixture } = await import('./fixtures.js');
  const ir = fixture();
  const assetPath = 'assets/read#1/a&b[2]+,.png';
  ir.assets[0].path = assetPath;
  const text = ir.blocks[1];
  if (text.type !== 'text') throw Error('Expected text fixture');
  text.value.content = [{type:'format',id:'external',kind:'link',children:[{type:'text',text:'Open the source'}]}];
  text.bindings = [{kind:'link',id:'external',href:'https://example.test/guide?format=pdf&view=1#chapter'}];
  const plan = createStaticFilePlan(buildReader(ir, snapshot(ir)), {title:'Book',originalFilename:'book.pdf'});
  const html = [...plan.generatedFiles].filter(file => file.path.startsWith('render/data/c_')).map(file => {
    const payload = JSON.parse(file.content.slice('PageLingoReader.registerChunk('.length, -3));
    return payload.source.html as string;
  }).join('');
  const sources = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  expect(sources.length).toBeGreaterThan(0);
  for (const source of sources) {
    const url = new URL(source, 'file:///bundle/render/index.html');
    expect(decodeURIComponent(url.pathname)).toBe(`/bundle/${assetPath}`);
    expect(url.hash).toBe('');
    expect(url.search).toBe('');
  }
  expect(html).toContain('href="https://example.test/guide?format=pdf&amp;view=1#chapter"');
});
