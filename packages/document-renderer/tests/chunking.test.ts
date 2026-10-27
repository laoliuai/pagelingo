import { it, expect } from 'vitest';
import { buildReader } from '../src/index.js';
import { book, snapshot } from './fixtures.js';
it('bounds 20,000 blocks and preserves exact reading order',()=>{
  const ir=book(20000), build=buildReader(ir,snapshot(ir));
  expect(build.chunks.every(c=>c.blockIds.length<=128)).toBe(true);
  expect(build.chunks.flatMap(c=>c.blockIds)).toEqual(ir.blocks.map(b=>b.id));
  expect(build.index.chunks.every(c=>c.bytes<=256*1024)).toBe(true);
});
it('isolates a huge block and splits at source pages without repeating cross-page blocks',()=>{
  const ir=book(3); if(ir.blocks[1].type==='code')ir.blocks[1].code='x'.repeat(300000);
  ir.blocks[1].sourceRefs.push({pageIndex:1,precision:'page'});ir.blocks[2].sourceRefs=[{pageIndex:1,precision:'page'}];
  const build=buildReader(ir,snapshot(ir));expect(build.chunks.map(c=>c.blockIds.length)).toEqual([1,1,1]);
  expect(build.index.blockLocations[ir.blocks[1].id].pageIndices).toEqual([0,1]);
});
it('reopens numbered lists with the continued number',()=>{
  const ir=book(130);const leaves=[...ir.nodes];ir.roots=['n_'+ 'f'.repeat(32)];
  ir.nodes=[{id:ir.roots[0],kind:'list',ordered:true,start:5,children:leaves.map((_,i)=>'n_'+(1000+i).toString(16).padStart(32,'0'))},...leaves.flatMap((n,i)=>[{id:'n_'+(1000+i).toString(16).padStart(32,'0'),kind:'list-item' as const,children:[n.id]},n])];
  const b=buildReader(ir,snapshot(ir));expect(b.chunks[1].nodes.find(n=>n.kind==='list')).toMatchObject({start:133});
});
it('rejects UTF-8 oversized source code instead of hiding it in an oversized singleton',()=>{
  const ir=book(1);if(ir.blocks[0].type==='code')ir.blocks[0].code='汉'.repeat(180000);
  expect(()=>buildReader(ir,snapshot(ir))).toThrow(/byte limit/);
});
