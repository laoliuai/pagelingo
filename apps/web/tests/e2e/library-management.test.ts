import { test, expect } from '@playwright/test';
import { login, newReader, origin, upload } from './library-helpers';

test('organizes documents across devices and preserves filters', async ({ page, browser }) => {
  const username = await newReader(page, 'manage');
  const patches: Record<string,unknown>[]=[]; page.on('request',request=>{if(request.method()==='PATCH'&&request.url().endsWith('/organization'))patches.push(request.postDataJSON());});
  await upload(page, '管理原文');
  await page.getByRole('button', { name: '管理集合与标签' }).click();
  await page.getByLabel('新集合名称').fill('研究');
  await page.getByRole('button', { name: '创建集合', exact: true }).click();
  await page.getByLabel('新标签名称').fill('方法');
  await page.getByRole('button', { name: '创建标签', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '标签名称 方法', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: '管理原文', exact: true }).click();
  await page.getByText('管理资料', { exact: true }).click();
  await page.getByLabel('资料标题', { exact: true }).fill('新的标题');
  await page.getByLabel('收藏备注').fill('私有阅读笔记');
  await page.getByLabel('所属集合').selectOption({ label: '研究' });
  await page.getByLabel('方法', { exact: true }).check();
  await page.getByRole('combobox', { name: '阅读状态', exact: true }).selectOption({ label: '在读' });
  await page.getByRole('button', { name: '保存资料信息' }).click();
  await expect(page.getByRole('status').filter({ hasText: '资料信息已保存' })).toBeVisible();
  const other = await browser.newPage();
  await login(other, username, 'reader-password-1');
  await other.getByLabel('集合筛选').selectOption({ label: '研究' });
  await other.getByLabel('状态筛选').selectOption('reading');
  await other.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(other.getByRole('link', { name: '新的标题', exact: true })).toBeVisible();
  await other.reload();
  await expect(other.getByLabel('集合筛选')).not.toHaveValue('');
  await other.getByRole('link', { name: '新的标题', exact: true }).click();
  await other.getByText('管理资料', { exact: true }).click();
  await expect(other.getByLabel('收藏备注')).toHaveValue('私有阅读笔记');
  await page.getByLabel('收藏备注').fill('过期编辑');
  await other.getByLabel('收藏备注').fill('另一设备的笔记');
  await other.getByRole('button', { name: '保存资料信息' }).click();
  await expect(other.getByText('资料信息已保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存资料信息' }).click();
  await expect(page.getByRole('alert')).toContainText('已重新加载');
  await expect(page.getByLabel('收藏备注')).toHaveValue('另一设备的笔记');
  expect(patches[0].expectedRevision).toBe(0); expect(patches[0]).not.toHaveProperty('lifecycleEpoch'); expect(Object.keys(patches.at(-1)!).sort()).toEqual(['expectedRevision','note']);
  for (const width of [1440, 375]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.screenshot({ path: `../../.superpowers/sdd/2026-10-28-learning-site-s4/task-6-evidence/organization-${width}-${theme}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await other.close();
});

test('does not apply late metadata to another account', async ({ page }) => {
  await newReader(page, 'late-metadata'); await upload(page, '私有标题');
  await page.getByRole('link', { name: '私有标题', exact: true }).click();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const held = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/organization', async route => { const response = await route.fetch(); started(); await gate; await route.fulfill({ response }).catch(() => {}); });
  await page.getByText('管理资料', { exact: true }).click(); await held;
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await login(page); release();
  await expect(page.getByText('私有标题', { exact: true })).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });
});

test('renames and deletes owned taxonomy and removes relations while preserving documents',async({page})=>{
  await newReader(page,'taxonomy-relations');const session=await(await page.request.get('/api/v1/auth/session')).json();const headers={Origin:origin,'X-CSRF-Token':session.csrfToken};
  async function save(title:string,url:string){const r=await page.request.post('/api/v1/documents/links',{headers:{...headers,'Idempotency-Key':crypto.randomUUID()},data:{title,url,translationIntent:'none'}});expect(r.status()).toBe(201);return(await r.json()).documentId;}
  const target=await save('关联目标','https://x.com/owned/status/target'),source=await save('关联起点','https://x.com/owned/status/source');
  await page.reload();await page.getByRole('button',{name:'管理集合与标签'}).click();await page.getByLabel('新集合名称').fill('待读');await page.getByRole('button',{name:'创建集合',exact:true}).click();await page.getByLabel('集合名称 待读',{exact:true}).fill('改名集合');await page.getByRole('button',{name:'重命名',exact:true}).click();await expect(page.getByLabel('集合名称 改名集合',{exact:true})).toBeVisible();await page.keyboard.press('Escape');
  await page.getByRole('link',{name:'关联起点',exact:true}).click();await page.getByText('管理资料',{exact:true}).click();await page.getByLabel('所属集合').selectOption({label:'改名集合'});await page.getByRole('button',{name:'保存资料信息'}).click();await expect(page.getByText('资料信息已保存',{exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'关联目标',exact:true}).selectOption(target);await page.getByRole('button',{name:'添加关联',exact:true}).click();await expect(page.locator('.relation-row').getByRole('link',{name:'关联目标',exact:true})).toBeVisible();await page.getByRole('button',{name:'解除关联',exact:true}).click();await expect(page.locator('.relation-row')).toHaveCount(0);expect((await page.request.get(`/api/v1/documents/${target}`)).status()).toBe(200);
  await page.getByRole('link',{name:'← 返回资料库',exact:true}).click();await page.getByRole('button',{name:'管理集合与标签'}).click();await page.getByRole('button',{name:'删除集合',exact:true}).click();await expect(page.getByLabel('集合名称 改名集合',{exact:true})).toHaveCount(0);await page.keyboard.press('Escape');await expect(page.getByRole('link',{name:'关联起点',exact:true})).toBeVisible();expect((await(await page.request.get(`/api/v1/documents/${source}/organization`)).json()).collectionId).toBeNull();
});

test('preserves combined library filters when paging and refreshing',async({page})=>{
  await newReader(page,'combined-pages');const session=await(await page.request.get('/api/v1/auth/session')).json();const headers={Origin:origin,'X-CSRF-Token':session.csrfToken};const collection=await(await page.request.post('/api/v1/collections',{headers,data:{name:'分页研究'}})).json();const tag=await(await page.request.post('/api/v1/tags',{headers,data:{name:'分页方法'}})).json();
  for(let n=0;n<21;n++)expect((await page.request.post('/api/v1/documents/links',{headers:{...headers,'Idempotency-Key':crypto.randomUUID()},data:{url:`https://x.com/pages/status/${n}`,title:`分页资料 ${n}`,translationIntent:'none',organization:{collectionId:collection.id,tagIds:[tag.id]}}})).status()).toBe(201);
  await page.reload();await page.getByLabel('集合筛选').selectOption(collection.id);await page.getByLabel('分页方法',{exact:true}).check();await page.getByLabel('类型筛选').selectOption('x-post');await page.getByLabel('来源筛选').selectOption('x');await page.getByLabel('状态筛选').selectOption('unread');await page.getByRole('button',{name:'搜索',exact:true}).click();await expect(page.locator('.document-row')).toHaveCount(20);await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.locator('.document-row')).toHaveCount(1);await page.reload();await expect(page.getByLabel('集合筛选')).toHaveValue(collection.id);await expect(page.getByLabel('分页方法',{exact:true})).toBeChecked();await expect(page.getByText('第 2 页',{exact:true})).toBeVisible();
});

test('initializes new link and imported-package classification from the actual save dialogs',async({page})=>{
  const {readingBundle,selectBundle}=await import('./bundle-helpers');await newReader(page,'save-choices');const session=await(await page.request.get('/api/v1/auth/session')).json();const headers={Origin:origin,'X-CSRF-Token':session.csrfToken};const collection=await(await page.request.post('/api/v1/collections',{headers,data:{name:'保存研究'}})).json();const tag=await(await page.request.post('/api/v1/tags',{headers,data:{name:'保存方法'}})).json();
  await page.getByRole('button',{name:'添加链接',exact:true}).click();await page.getByLabel('网页地址').fill('https://x.com/save/status/100');await page.getByLabel('链接标题').fill('已分类链接');await page.getByLabel('所属集合').selectOption(collection.id);await page.getByRole('dialog').getByRole('checkbox',{name:'保存方法',exact:true}).check();await page.getByRole('button',{name:'保存链接',exact:true}).click();await expect(page.getByRole('dialog')).toBeHidden();
  const bundle=await readingBundle('chinese');await selectBundle(page,bundle);await page.getByLabel('所属集合').selectOption(collection.id);await page.getByRole('dialog').getByRole('checkbox',{name:'保存方法',exact:true}).check();await page.getByRole('button',{name:'开始导入',exact:true}).click();await expect(page.getByText('阅读包导入完成',{exact:true})).toBeVisible();await page.getByRole('button',{name:'关闭',exact:true}).click();
  const library=await(await page.request.get('/api/v1/library')).json();expect(library.total).toBe(2);for(const item of library.items)expect(item.organization).toMatchObject({collectionId:collection.id,tagIds:[tag.id]});
});

test('keeps reading space and keyboard focus with management collapsed on narrow screens',async({page})=>{
  const {archive}=await import('./web-helpers');await newReader(page,'reader-management');const saved=await archive(page);await page.reload();
  for(const width of [1440,375])for(const theme of ['light','dark']){await page.setViewportSize({width,height:900});await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);await page.screenshot({path:`../../.superpowers/sdd/2026-10-28-learning-site-s4/task-6-evidence/library-${width}-${theme}.png`,fullPage:true});}
  const writes:string[]=[];page.on('request',request=>{if(['PUT','PATCH','POST','DELETE'].includes(request.method())&&request.url().includes('/api/v1/'))writes.push(request.method());});
  await page.goto(`/library/${saved.documentId}`);await expect(page.locator('.management-panel')).not.toHaveAttribute('open','');await expect(page.getByText('这是已经归档的中文原文，可以直接阅读。',{exact:true})).toBeVisible();
  const control=await page.locator('.management-panel > summary').boundingBox(),back=await page.locator('.back-link').boundingBox();expect(control!.height).toBeGreaterThanOrEqual(44);expect(Math.abs(control!.y-back!.y)).toBeLessThanOrEqual(4);
  await page.locator('.management-panel > summary').focus();await page.keyboard.press('Enter');await expect(page.getByLabel('收藏备注')).toBeVisible();
  const expanded=await page.locator('.management-panel').boundingBox(),reading=await page.getByRole('region',{name:'网页阅读器',exact:true}).boundingBox();expect(expanded!.width).toBeGreaterThan(300);expect(reading!.y).toBeGreaterThanOrEqual(expanded!.y+expanded!.height);
  await page.locator('.management-panel > summary').click();await expect(page.locator('.management-panel')).not.toHaveAttribute('open','');
  for(const theme of ['light','dark']){await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);await page.screenshot({path:`../../.superpowers/sdd/2026-10-28-learning-site-s4/task-6-evidence/reader-collapsed-375-${theme}.png`,fullPage:true});}expect(writes).toEqual([]);expect((await(await page.request.get('/__test/metrics')).json()).modelCalls).toBe(0);
});

test('keeps unconfirmed import classification immutable when the create acknowledgement is lost',async({page})=>{
  const {readingBundle,selectBundle}=await import('./bundle-helpers');await newReader(page,'classification-ack');const session=await(await page.request.get('/api/v1/auth/session')).json();const headers={Origin:origin,'X-CSRF-Token':session.csrfToken};const collection=await(await page.request.post('/api/v1/collections',{headers,data:{name:'不可变分类'}})).json();await selectBundle(page,await readingBundle('chinese'));await page.getByRole('dialog').getByRole('combobox',{name:'所属集合',exact:true}).selectOption(collection.id);
  const bodies:unknown[]=[];const keys:string[]=[];let lost=false;await page.route('**/api/v1/bundle-imports',async route=>{if(route.request().method()!=='POST')return lost&&bodies.length===1?route.abort('failed'):route.continue();bodies.push(route.request().postDataJSON());keys.push(route.request().headers()['idempotency-key']);const response=await route.fetch();if(!lost){lost=true;await route.abort('failed');}else await route.fulfill({response});});
  await page.getByRole('button',{name:'开始导入',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'尚未确认'})).toBeVisible();await expect(page.getByRole('dialog').getByRole('combobox',{name:'所属集合',exact:true})).toBeDisabled();await page.getByRole('button',{name:'重试导入',exact:true}).click();await expect(page.getByText('阅读包导入完成',{exact:true})).toBeVisible();expect(bodies).toHaveLength(2);expect(bodies[1]).toEqual(bodies[0]);expect(keys[1]).toBe(keys[0]);
});
