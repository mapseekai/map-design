import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MapDesignRunResponse } from '../../packages/contracts/src/api/runs.js';
import type { Page } from '@playwright/test';
import { expect, test } from '@/playwright/suite';
import { createAndOpenReadyMapProject } from '@/playwright/map-design-project';

test('[P0] edits and deletes pending messages while a run executes, then dispatches once in order', async ({ page, toolsDev }) => {
  test.setTimeout(120_000);
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  const daemonUrl = toolsDev.daemonUrl;
  if (!daemonUrl) throw new Error('The isolated daemon URL is missing.');
  const configured = await page.request.put(`${daemonUrl}/api/config`, { data: { agentId: 'codex' } });
  expect(configured.ok()).toBe(true);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${daemonUrl}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  const sampleStyle = (await readFile(new URL('../../apps/web/public/cartography-sample/style.json', import.meta.url), 'utf8'))
    .replace('"/cartography-sample/riverside.geojson"', await readFile(new URL('../../apps/web/public/cartography-sample/riverside.geojson', import.meta.url), 'utf8'));
  await page.route('**/api/map-design/projects/*/style', (route) => route.fulfill({ contentType: 'application/json', body: sampleStyle }));
  await page.route('**/api/agents', (route) => route.fulfill({ json: { agents: [{
    id: 'codex', label: 'Codex', available: true, modelCatalogSource: 'live',
    mapDesign: { nativeMapTools: true, publicReasoningSummary: true },
  }] } }));
  await page.route('**/conversations/*/runtime', (route) => {
    const runtime = { agentId: 'codex', revision: 1, updatedAt: '2026-09-22T00:00:00.000Z' };
    return route.fulfill({ json: { runtime, effectiveRuntime: runtime } });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const projectId = await createAndOpenReadyMapProject(page, daemonUrl, { projectPrefix: 'message-queue' });
  await page.evaluate(() => {
    localStorage.setItem('map-design:locale', 'zh-CN');
    localStorage.setItem('map-design:locale-source', 'manual');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const conversationId = new URL(page.url()).searchParams.get('conversation');
  if (!conversationId) throw new Error('The project has no selected conversation.');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  const prompts: string[] = [];
  const firstFinished = createGate();
  const secondAccepted = createGate();
  const secondFinished = createGate();
  const thirdFinished = createGate();
  const makeRun = (number: number, status: MapDesignRunResponse['status']): MapDesignRunResponse => ({
    runId: `queue-run-${number}`, projectId, conversationId, status,
  });
  await page.route('**/api/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body: unknown = route.request().postDataJSON();
    if (typeof body !== 'object' || body === null || !('prompt' in body) || typeof body.prompt !== 'string') {
      throw new Error('The run request has no prompt.');
    }
    prompts.push(body.prompt);
    const number = prompts.length;
    if (number === 2) await secondAccepted.promise;
    await route.fulfill({ json: makeRun(number, 'running') });
  });
  await page.route('**/api/runs/queue-run-*/events', async (route) => {
    const number = Number(new URL(route.request().url()).pathname.split('/')[3]?.replace('queue-run-', ''));
    if (number === 1) await firstFinished.promise;
    else if (number === 2) await secondFinished.promise;
    else await thirdFinished.promise;
    await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({
      type: 'run_finished', run: makeRun(number, number === 2 ? 'failed' : 'succeeded'),
    })}\n\n` });
  });
  const composer = page.getByRole('textbox', { name: '向地图智能体发送消息', exact: true });
  await composer.fill('检查当前地图的道路层级');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消运行', exact: true })).toBeVisible();
  await expect(composer).toBeEditable();
  await composer.fill('接下来调整道路标签，让中文地名更易读');
  await page.getByRole('button', { name: '加入队列', exact: true }).click();
  await composer.fill('再把水域调整为浅蓝色');
  await composer.press('Enter');
  const queue = page.getByRole('region', { name: '待发送消息', exact: true });
  await expect(queue.getByRole('listitem')).toHaveCount(2);
  expect(prompts).toEqual(['检查当前地图的道路层级']);
  const evidence = fileURLToPath(new URL('../../.tmp/message-queue-qa/', import.meta.url));
  await mkdir(evidence, { recursive: true });
  const captures: string[] = [];
  await captureWidths(page, evidence, 'queued', captures);
  const detail = resolve(evidence, 'queued-detail.png');
  await queue.locator('..').screenshot({ path: detail, animations: 'disabled' });
  captures.push(detail);
  await queue.getByRole('button', { name: '编辑待发送消息' }).first().click();
  const editor = queue.getByRole('textbox', { name: '编辑消息' });
  await editor.fill('调整道路标签：保留中文地名，并提高文字对比度');
  await captureWidths(page, evidence, 'editing', captures);
  await queue.getByRole('button', { name: '保存', exact: true }).click();
  await queue.getByRole('listitem').nth(1).getByRole('button', { name: '删除待发送消息' }).click();
  await expect(queue.getByRole('listitem')).toHaveCount(1);
  firstFinished.resolve();
  await expect.poll(() => prompts.length).toBe(2);
  await expect(queue.getByRole('button', { name: '编辑待发送消息' })).toBeDisabled();
  await expect(queue.getByRole('button', { name: '删除待发送消息' })).toBeDisabled();
  expect(prompts).toEqual(['检查当前地图的道路层级', '调整道路标签：保留中文地名，并提高文字对比度']);
  secondAccepted.resolve();
  await expect(queue).toBeHidden();
  await composer.fill('完成后检查所有标签是否清晰');
  await composer.press('Enter');
  await expect(queue.getByRole('listitem')).toHaveCount(1);
  secondFinished.resolve();
  await expect(queue.getByRole('button', { name: '继续队列' })).toBeVisible();
  await captureWidths(page, evidence, 'paused', captures);
  expect(prompts).toHaveLength(2);
  await queue.getByRole('button', { name: '继续队列' }).click();
  await expect.poll(() => prompts.length).toBe(3);
  await expect(queue).toBeHidden();
  thirdFinished.resolve();
  await expect(page.getByRole('button', { name: '取消运行', exact: true })).toBeHidden();
  expect(prompts).toEqual(['检查当前地图的道路层级', '调整道路标签：保留中文地名，并提高文字对比度', '完成后检查所有标签是否清晰']);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await writeFile(resolve(evidence, 'manifest.json'), JSON.stringify({
    captures, prompts, errors, browserErrors,
    interception: 'API requests forward to the real isolated daemon. GET /api/map-design/projects/*/style returns the existing bundled cartography-sample/style.json with its riverside.geojson inlined. POST /api/runs, GET run events, /api/agents and conversation runtime metadata are controlled. The project, map renderer, UI, queue and interactions are production code.',
    fixtureNotes: 'The initial project design requirement may show a failed fixture-agent run and the frozen production proxy may emit an EventSource MIME warning before the queue scenario. browserErrors records the entire page lifetime; errors records the controlled queue scenario after reload.',
  }, null, 2));
  expect(errors).toEqual([]);
});

function createGate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, resolve: () => release() };
}

async function captureWidths(page: Page, directory: string, state: string, captures: string[]) {
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const expand = page.getByRole('button', { name: '展开设计对话', exact: true });
    if (await expand.isVisible()) await expand.click();
    await expect(page.getByRole('region', { name: '待发送消息', exact: true })).toBeVisible();
    const path = resolve(directory, `${state}-${width}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    captures.push(path);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
