import { readFileSync } from 'node:fs';
import type { ReaderIR, ReaderTranslation } from '@pagelingo/document-contracts';
import { planUnits, PROMPT_VERSION, PROTECTION_VERSION, stripContinuation } from '@pagelingo/translation-core';
import { toTranslationDocument } from '../src/index.js';
export function fixture(): ReaderIR {
  return JSON.parse(readFileSync(new URL('../../document-contracts/fixtures/reader-v1/source-ir.json', import.meta.url), 'utf8'));
}
export function snapshot(ir: ReaderIR, completed = false): ReaderTranslation {
  const value: ReaderTranslation = JSON.parse(readFileSync(new URL('../../document-contracts/fixtures/reader-v1/translation.json', import.meta.url), 'utf8'));
  Object.assign(value, { sourceSha256: ir.source.sha256, parseId: ir.parse.id, promptVersion: PROMPT_VERSION, protectionVersion: PROTECTION_VERSION });
  value.selectionBlockIds = ir.blocks.filter(b => b.type === 'text').map(b => b.id);
  const plan = planUnits(toTranslationDocument(ir, value.selectionBlockIds), value.targetLanguage, value.profile, value.budget, value);
  value.units = plan.units.map(u => ({id:u.id, blockId:plan.inputs[u.blockIndex].id, part:u.part, status:completed ? 'completed' : 'pending', ...(completed ? {rawText:u.input.protectedText} : {})} as ReaderTranslation['units'][number]));
  value.blocks = plan.inputs.map(input => completed ? {blockId:input.id, status:'translated', rawText: plan.units.filter(u=>plan.inputs[u.blockIndex].id===input.id).map(u=>stripContinuation(u.input,u.input.protectedText)).join('')} : {blockId:input.id,status:'source-only',reason:'pending'});
  value.status = plan.inputs.length ? (completed ? 'completed' : 'pending') : 'not-required'; value.generationKind = completed ? 'mock' : 'none';
  return value;
}
export const id = (kind:'b'|'n', n:number): string => `${kind}_${n.toString(16).padStart(32,'0')}`;
export function book(count:number): ReaderIR {
  const ir=fixture(); ir.assets=[]; ir.roots=[]; ir.nodes=[]; ir.blocks=[];
  for(let i=1;i<=count;i++) {
    ir.roots.push(id('n',i)); ir.nodes.push({id:id('n',i),kind:'block',blockId:id('b',i),children:[]});
    ir.blocks.push({id:id('b',i),type:'code',code:`line ${i}`,sourceRefs:[{pageIndex:0,precision:'page'}]});
  }
  return ir;
}
