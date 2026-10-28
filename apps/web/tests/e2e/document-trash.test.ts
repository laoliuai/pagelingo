import { test, expect } from '@playwright/test';
import { newReader, upload } from './library-helpers';
test('restores and permanently removes only the selected item', async ({ page }) => {
  await newReader(page, 'trash-ui'); await upload(page, '保留原文', 1); await upload(page, '移除原文', 2);
  await page.getByRole('link', { name: '移除原文', exact: true }).click();
  await page.getByText('管理资料', { exact: true }).click();
  await page.getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('link', { name: '回收站', exact: true }).click();
  await expect(page.getByText('移除原文', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await page.getByRole('link', { name: '返回资料库', exact: true }).click();
  await expect(page.getByRole('link', { name: '移除原文', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '移除原文', exact: true }).click();
  await page.getByText('管理资料', { exact: true }).click();
  await page.getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('link', { name: '回收站', exact: true }).click();
  await page.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '确认永久删除', exact: true }).click();
  await expect(page.getByText('正在永久清理', { exact: true })).toBeVisible();
  await expect(page.getByText('已永久删除', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('link', { name: '返回资料库', exact: true }).click();
  await expect(page.getByRole('link', { name: '保留原文', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '移除原文', exact: true })).toHaveCount(0);
});

test('keeps an item in trash when retained original material cannot be restored', async({page})=>{
  await newReader(page,'restore-missing');await upload(page,'缺失原件');await page.getByRole('link',{name:'缺失原件',exact:true}).click();const id=page.url().split('/').pop()!;
  await page.request.post(`/__test/missing-source/${id}`);
  await page.getByText('管理资料',{exact:true}).click();await page.getByRole('button',{name:'移入回收站',exact:true}).click();await page.getByRole('link',{name:'回收站',exact:true}).click();
  await page.getByRole('button',{name:'恢复',exact:true}).click();await expect(page.getByRole('alert')).toContainText('原件');await expect(page.getByText('缺失原件',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'恢复',exact:true})).toBeEnabled();
});
