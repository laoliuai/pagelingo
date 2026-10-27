import { describe, it, expect } from 'vitest';
import { planUnits } from '@pagelingo/translation-core';
import { toTranslationDocument, validateReaderTranslation } from '../src/index.js';
import { fixture, snapshot } from './fixtures.js';
describe('SDK replay',()=>{
  it('restores nested formatting, protected objects and glossary from SDK slots',()=>{
    const ir=fixture(); const t=snapshot(ir,true);
    t.glossary=[{source:'Reader',target:'阅读器',policy:'translate',domain:'all'}];
    const plan=planUnits(toTranslationDocument(ir,t.selectionBlockIds),t.targetLanguage,t.profile,t.budget,t);
    t.blocks=t.blocks.map((b,i)=>({blockId:b.blockId,status:'translated',rawText:plan.inputs[i].protectedText}));
    t.units=plan.units.map(u=>({id:u.id,part:u.part,blockId:plan.inputs[u.blockIndex].id,status:'covered-by-block'}));
    const valid=validateReaderTranslation(ir,t);
    expect(valid.blocks.get(t.blocks[0].blockId)?.content).toEqual(ir.blocks[0].type==='text'?ir.blocks[0].value.content:[]);
    expect(JSON.stringify([...valid.blocks.values()])).not.toContain('⟦');
  });
  it.each(['promptVersion','protectionVersion','sdkVersion'] as const)('rejects incompatible %s',key=>{
    const ir=fixture(),t=snapshot(ir,true);t[key]='forged';expect(()=>validateReaderTranslation(ir,t)).toThrow();
  });
  it.each(['missing','unknown','duplicate','marker','completed'] as const)('rejects %s unit forgery',kind=>{
    const ir=fixture(),t=snapshot(ir,true);
    if(kind==='missing') t.units.pop();
    if(kind==='unknown') t.units[0].id='u999:0';
    if(kind==='duplicate') t.units.push(t.units[0]);
    if(kind==='marker') {const b=t.blocks.find(b=>b.status==='translated'&&b.rawText.includes('⟦'));if(b?.status==='translated') b.rawText=b.rawText.replace(/⟦[^⟧]+⟧/,'');}
    if(kind==='completed') {t.blocks[0]={blockId:t.blocks[0].blockId,status:'source-only',reason:'pending'};}
    expect(()=>validateReaderTranslation(ir,t)).toThrow();
  });
  it('accepts real SDK zero-unit failure and a validated full-block cache despite planning failure',()=>{
    const ir=fixture(),t=snapshot(ir);t.budget={maxInputTokens:1,maxOutputTokens:1,contextWindowTokens:1};
    const plan=planUnits(toTranslationDocument(ir,t.selectionBlockIds),t.targetLanguage,t.profile,t.budget,t);
    expect(plan.units).toHaveLength(0);t.units=[];t.status='failed';t.blocks=t.blocks.map(b=>({blockId:b.blockId,status:'source-only',reason:'failed'}));
    expect(validateReaderTranslation(ir,t).blocks.size).toBe(0);
    t.blocks=plan.inputs.map(i=>({blockId:i.id,status:'translated',rawText:i.protectedText}));t.status='completed';t.generationKind='mock';
    expect(validateReaderTranslation(ir,t).blocks.size).toBe(plan.inputs.length);
  });
  it('replays source language override and rejects reordered selection',()=>{
    const ir=fixture(),t=snapshot(ir);expect(toTranslationDocument(ir,t.selectionBlockIds,'fr').sourceLanguage).toBe('fr');
    expect(()=>toTranslationDocument(ir,[...t.selectionBlockIds].reverse())).toThrow();
  });
});

it('restores translated terminology, nested link/emphasis and protected code/math exactly',()=>{
  const ir=fixture();const block=ir.blocks[1];if(block.type!=='text')throw Error('text fixture');
  block.value.content=[{type:'format',id:'link',kind:'link',children:[{type:'format',id:'em',kind:'emphasis',children:[{type:'text',text:'transformer '},{type:'protected',id:'code',kind:'code',source:'<script>'},{type:'protected',id:'math',kind:'math',source:'x^2'}]}]}];
  block.bindings=[{kind:'link',id:'link',href:'https://example.test/'},{kind:'style',id:'em',emphasis:'emphasis'},{kind:'protected',id:'code',object:{type:'code',text:'<script>'}},{kind:'protected',id:'math',object:{type:'math',latex:'x^2'}}];
  const t=snapshot(ir,true);t.glossary=[{source:'transformer',target:'变换器',policy:'translate',domain:'all'}];
  const plan=planUnits(toTranslationDocument(ir,t.selectionBlockIds),t.targetLanguage,t.profile,t.budget,t);
  t.blocks=plan.inputs.map(input=>({blockId:input.id,status:'translated',rawText:input.protectedText}));
  t.units=plan.units.map(u=>({id:u.id,part:u.part,blockId:plan.inputs[u.blockIndex].id,status:'covered-by-block'}));
  const content=validateReaderTranslation(ir,t).blocks.get(block.id)?.content;
  expect(content).toEqual([{type:'format',id:'link',kind:'link',children:[{type:'format',id:'em',kind:'emphasis',children:[{type:'text',text:'变换器 '},{type:'protected',id:'code',kind:'code',source:'<script>'},{type:'protected',id:'math',kind:'math',source:'x^2'}]}]}]);
  const swapped=structuredClone(ir);const b=swapped.blocks[1];if(b.type==='text')b.bindings[2]={kind:'protected',id:'code',object:{type:'code',text:'swapped'}};
  expect(()=>validateReaderTranslation(swapped,t)).toThrow();
});
