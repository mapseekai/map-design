import { readFile } from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';
import { StartMapDesignRunRequestSchema } from '../../packages/contracts/src/api/runs.js';
import { expect, test } from '@/playwright/suite';
import { createAndOpenReadyMapProject, waitForRenderedMap } from '@/playwright/map-design-project';

async function useBundledMap(page: Page) {
  const style = (await readFile(new URL('../../apps/web/public/cartography-sample/style.json', import.meta.url), 'utf8'))
    .replace('"/cartography-sample/riverside.geojson"', await readFile(new URL('../../apps/web/public/cartography-sample/riverside.geojson', import.meta.url), 'utf8'));
  await page.route('**/api/map-design/projects/*/style', route => route.fulfill({ contentType: 'application/json', body: style }));
}

async function captureResponsive(page: Page, testInfo: TestInfo, state: string) {
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const expand = page.getByRole('button', { name: /^(Expand design conversation|展开设计对话)$/ });
    if (await expand.isVisible()) await expand.click();
    await expect(page.getByRole('region', { name: '待发送消息', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`${state}-${width}.png`), animations: 'disabled',
      style: 'nextjs-portal { visibility: hidden; }' });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

test('[P1] recovers editable screenshots after a real daemon runtime conflict without losing a new draft', async ({ page, toolsDev }, testInfo) => {
  test.setTimeout(180_000);
  const daemonUrl = toolsDev.daemonUrl;
  if (!daemonUrl) throw new Error('Missing isolated daemon URL');
  await page.setViewportSize({ width: 1280, height: 900 });
  await useBundledMap(page);
  const projectId = await createAndOpenReadyMapProject(page, daemonUrl, { projectPrefix: 'review-screenshots', title: 'Review screenshot recovery' });
  const conversationId = new URL(page.url()).searchParams.get('conversation');
  if (!conversationId) throw new Error('Missing selected conversation');
  await expect.poll(async () => {
    const response = await page.request.get(`${daemonUrl}/api/map-design/projects/${projectId}/conversations/${conversationId}`);
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('messages' in body) || !Array.isArray(body.messages)) return null;
    const last: unknown = body.messages.at(-1);
    return typeof last === 'object' && last !== null && 'runStatus' in last ? last.runStatus : null;
  }, { timeout: 30_000 }).toBe('succeeded');
  await page.evaluate(() => {
    localStorage.setItem('map-design:locale', 'zh-CN');
    localStorage.setItem('map-design:locale-source', 'manual');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForRenderedMap(page.getByRole('region', { name: 'Map', exact: true }));
  const composer = page.getByRole('textbox', { name: '向地图智能体发送消息', exact: true });
  await expect(composer).toBeEditable();
  await page.getByRole('button', { name: '截图到聊天', exact: true }).click();
  await expect(page.getByRole('img', { name: '地图截图', exact: true })).toBeVisible();
  await composer.fill('请检查截图中的中文地名与道路层级。');
  await page.route('**/api/runs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const input = StartMapDesignRunRequestSchema.parse(route.request().postDataJSON());
    await route.continue({ postData: JSON.stringify({ ...input, runtimeRevision: input.runtimeRevision + 100 }) });
  });
  const rejected = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/runs');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  expect((await rejected).status()).toBe(409);
  const queue = page.getByRole('region', { name: '待发送消息', exact: true });
  await expect(queue.getByRole('button', { name: '继续队列', exact: true })).toBeVisible();
  await composer.fill('这是尚未发送的新草稿，请保留。');
  await queue.getByRole('button', { name: '编辑待发送消息', exact: true }).click();
  await expect(queue.getByRole('img', { name: '地图截图', exact: true })).toBeVisible();
  await captureResponsive(page, testInfo, 'rejected-editing');
  await queue.getByRole('button', { name: '移除截图', exact: true }).click();
  await expect(queue.getByRole('img', { name: '地图截图', exact: true })).toHaveCount(0);
  await queue.getByRole('textbox', { name: '编辑消息', exact: true }).fill('改为只检查当前地图的标签。');
  await queue.getByRole('button', { name: '保存', exact: true }).click();
  await captureResponsive(page, testInfo, 'rejected-corrected');
  await expect(composer).toHaveValue('这是尚未发送的新草稿，请保留。');
  await page.unroute('**/api/runs');
  const retried = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs');
  await queue.getByRole('button', { name: '继续队列', exact: true }).click();
  const input = StartMapDesignRunRequestSchema.parse((await retried).postDataJSON());
  expect(input.screenshotIds ?? []).toEqual([]);
  expect(input.prompt).toBe('改为只检查当前地图的标签。');
  await expect(queue).toBeHidden();
  await expect(composer).toHaveValue('这是尚未发送的新草稿，请保留。');
});

test('[P1] restores the last conversation reached through browser history when reopening a workspace tab', async ({ page, toolsDev }, testInfo) => {
  test.setTimeout(120_000);
  const daemonUrl = toolsDev.daemonUrl;
  if (!daemonUrl) throw new Error('Missing isolated daemon URL');
  await page.setViewportSize({ width: 1280, height: 900 });
  await useBundledMap(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const title = 'Review history workspace';
  await createAndOpenReadyMapProject(page, daemonUrl, { projectPrefix: 'review-history', title });
  await page.getByRole('button', { name: 'Back to home', exact: true }).click();
  await page.getByRole('tab', { name: title, exact: true }).click();
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled();
  const firstUrl = page.url();
  const created = page.waitForResponse(response => response.request().method() === 'POST' && /\/conversations$/.test(new URL(response.url()).pathname));
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  expect((await created).ok()).toBe(true);
  await expect.poll(() => page.url()).not.toBe(firstUrl);
  await page.getByRole('button', { name: 'Back to home', exact: true }).click();
  await page.goBack();
  await expect(page.getByRole('textbox', { name: 'Message map agent', exact: true })).toBeVisible();
  await page.goBack();
  await expect.poll(() => page.url()).toBe(firstUrl);
  await page.goBack();
  await page.getByRole('tab', { name: title, exact: true }).click();
  await expect.poll(() => page.url()).toBe(firstUrl);
  await waitForRenderedMap(page.getByRole('region', { name: 'Map', exact: true }));
  await expect(page.getByRole('textbox', { name: 'Message map agent', exact: true })).toBeEditable();
  await page.screenshot({ path: testInfo.outputPath('history-restored-1280.png'), animations: 'disabled' });
});
