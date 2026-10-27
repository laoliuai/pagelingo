import { it, expect } from 'vitest';
import { buildReader, renderChunk } from '../src/index.js';
import { book, fixture, snapshot } from './fixtures.js';
it('escapes hostile text and preserves source presentation and image roles',()=>{
  const ir=book(1);ir.blocks[0]={id:ir.blocks[0].id,type:'code',code:'<script>alert(1)</script>',sourceRefs:ir.blocks[0].sourceRefs};
  const html=renderChunk(buildReader(ir,snapshot(ir)).chunks[0],{mode:'source',resolveAsset:id=>`/assets/${id}`}).html;
  expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');
});
it('rejects missing assets and invalid WHATWG links before build',()=>{
  const ir=fixture();ir.assets=[];expect(()=>buildReader(ir,snapshot(ir))).toThrow();
  const v=fixture();const text=v.blocks[1];
  if(text.type!=='text')throw Error('fixture text required');text.value.content=[{type:'format',id:'link',kind:'link',children:[{type:'text',text:'click'}]}];text.bindings=[{kind:'link',id:'link',href:'https://host:999999/'}];
  expect(()=>buildReader(v,snapshot(fixture()))).toThrow();
});
it.each(['\\href{javascript:alert(1)}{x}','\\includegraphics{https://evil.test/x}','\\def\\a{\\a}\\a'])('renders hostile TeX safely: %s',latex=>{
  const ir=book(1);ir.blocks[0]={type:'math',id:ir.blocks[0].id,sourceRefs:ir.blocks[0].sourceRefs,latex,displayMode:true};
  const out=renderChunk(buildReader(ir,snapshot(ir)).chunks[0],{mode:'source',resolveAsset:()=>''});
  expect(out.html).not.toMatch(/<(?:a|img|script)\b/);expect(out.html.length).toBeLessThan(4*1024*1024);
});
it('falls back readably when math would exceed element budget',()=>{
  const ir=book(1);ir.blocks[0]={type:'math',id:ir.blocks[0].id,sourceRefs:ir.blocks[0].sourceRefs,latex:'x+'.repeat(7000)+'x',displayMode:true};
  const out=renderChunk(buildReader(ir,snapshot(ir)).chunks[0],{mode:'source',resolveAsset:()=>''});
  expect(out.warnings.length).toBeGreaterThan(0);expect(out.html).toContain('math-fallback');expect((out.html.match(/<[a-z]/g)||[]).length).toBeLessThanOrEqual(16000);
});
it('bounds cumulative inline math output and falls back without failing the chunk',()=>{
  const ir=book(1);const content=Array.from({length:90},(_,i)=>({type:'protected' as const,id:`m${i}`,kind:'math' as const,source:'x+'.repeat(100)+'x'}));
  ir.blocks[0]={type:'text',id:ir.blocks[0].id,sourceRefs:ir.blocks[0].sourceRefs,value:{id:ir.blocks[0].id,kind:'paragraph',content},bindings:content.map(inline=>({kind:'protected',id:inline.id,object:{type:'math',latex:inline.source}})),language:{language:'und',reason:'no-language'}};
  const t=snapshot(ir);t.selectionBlockIds=[];t.units=[];t.blocks=[{blockId:ir.blocks[0].id,status:'source-only',reason:'language-not-required'}];t.status='not-required';
  const out=renderChunk(buildReader(ir,t).chunks[0],{mode:'source',resolveAsset:()=>''});
  expect(out.html).toContain('math-fallback');expect(out.warnings.length).toBeGreaterThan(0);expect((out.html.match(/<[a-z]/g)||[]).length).toBeLessThanOrEqual(16000);
});
it('rejects a tree deeper than 32 before rendering',()=>{
  const ir=book(1);for(let i=0;i<33;i++) { const parent='n_'+(1000+i).toString(16).padStart(32,'0');ir.nodes.push({kind:'group',id:parent,children:[ir.roots[0]]});ir.roots=[parent]; }
  expect(()=>buildReader(ir,snapshot(ir))).toThrow(/depth/);
});
it.each(['\\def\\a{x}\\a', '{'.repeat(40)+'x'+'}'.repeat(40), 'x'.repeat(3000)])('preflights formula complexity before rendering: %s',latex=>{
  const ir=book(1);ir.blocks[0]={type:'math',id:ir.blocks[0].id,sourceRefs:ir.blocks[0].sourceRefs,latex,displayMode:true};
  const out=renderChunk(buildReader(ir,snapshot(ir)).chunks[0],{mode:'source',resolveAsset:()=>''});
  expect(out.html.includes('math-fallback')).toBe(true);expect(out.warnings.length).toBe(1);
});
it('keeps callout semantics, source styles, code, captions and original-region role',()=>{
  const ir=fixture();const first=ir.blocks[0];if(first.type!=='text')throw Error('text fixture');
  first.bindings.push({kind:'style',id:'style',align:'center',monospace:true,color:'#abcdef',backgroundColor:'#012345'});
  first.value.content.push({type:'format',id:'style',kind:'style',children:[{type:'text',text:'styled'}]});
  const caption=ir.blocks[1];if(caption.type==='text')caption.value.kind='caption';
  const image=ir.blocks.find(b=>b.type==='image');if(image?.type==='image')image.role='original-region';
  const parent='n_'+'e'.repeat(32);ir.nodes.push({kind:'callout',id:parent,children:ir.roots,semantic:'prompt'});ir.roots=[parent];
  const build=buildReader(ir,snapshot(ir));
  const html=build.chunks.map(chunk=>renderChunk(chunk,{mode:'source',resolveAsset:id=>`/assets/${id}`}).html).join('');
  expect(html).toContain('data-callout="prompt"');expect(html).toContain('<strong>');expect(html).toContain('color:#abcdef');expect(html).toContain('<figcaption>');expect(html).toContain('data-image-role="original-region"');expect(html).toContain('return 1;');
});
