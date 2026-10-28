import type { SaveOrganization } from '@pagelingo/document-contracts';
import { useState } from 'react';
import { Field } from '../../shared/ui/field';
import { Input } from '../../shared/ui/input';
import { Button } from '../../shared/ui/button';
import { useTaxonomy, useSelectedTaxonomy } from './use-taxonomy';
export function OrganizationChoices({ value, onChange }: { value: SaveOrganization; onChange: (value: SaveOrganization) => void }) {
  const [collectionSearch, setCollectionSearch] = useState(''); const [tagSearch, setTagSearch] = useState('');
  const collections = useTaxonomy('collections', collectionSearch), tags = useTaxonomy('tags', tagSearch);
  const selectedCollections=useSelectedTaxonomy('collections',value.collectionId?[value.collectionId]:[]),selectedTags=useSelectedTaxonomy('tags',value.tagIds);
  const merge = (items: {id:string;name:string}[]) => [...new Map(items.map(item=>[item.id,item])).values()];
  const collectionItems = merge([...selectedCollections,...collections.data?.pages.flatMap(p => p.items) ?? []]), tagItems = merge([...selectedTags,...tags.data?.pages.flatMap(p => p.items) ?? []]);
  return <div className="organization-choices"><Field label="查找可选集合"><Input maxLength={80} value={collectionSearch} onChange={e => setCollectionSearch(e.target.value)} /></Field><Field label="所属集合"><select value={value.collectionId ?? ''} onChange={e => onChange({ ...value, collectionId: e.target.value || null })}><option value="">未分类</option>{value.collectionId && !collectionItems.some(c => c.id === value.collectionId) && <option value={value.collectionId}>当前集合（可查找名称）</option>}{collectionItems.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>{collections.hasNextPage && <Button type="button" onClick={() => void collections.fetchNextPage()}>更多可选集合</Button>}<Field label="查找可选标签"><Input maxLength={80} value={tagSearch} onChange={e => setTagSearch(e.target.value)} /></Field><fieldset><legend>标签（最多 32 个）</legend>{tagItems.map(tag => <label key={tag.id} className="checkbox"><input type="checkbox" checked={value.tagIds.includes(tag.id)} disabled={!value.tagIds.includes(tag.id) && value.tagIds.length >= 32} onChange={e => onChange({ ...value, tagIds: e.target.checked ? [...value.tagIds, tag.id] : value.tagIds.filter(id => id !== tag.id) })} />{tag.name}</label>)}</fieldset>{tags.hasNextPage && <Button type="button" onClick={() => void tags.fetchNextPage()}>更多可选标签</Button>}{(collections.isError || tags.isError) && <p role="alert">分类暂时无法读取，请重试。<Button type="button" onClick={() => { void collections.refetch(); void tags.refetch(); }}>重试分类</Button></p>}</div>;
}
