import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type { MapDesignConversationResponse } from '../../packages/contracts/src/api/conversations.js';
import type { MapDesignRunResponse } from '../../packages/contracts/src/api/runs.js';
import { expect, test } from '@/playwright/suite';
import { createAndOpenReadyMapProject } from '@/playwright/map-design-project';

test('[P0] restores queued messages and real daemon run control after leaving the workspace', async ({ page, toolsDev }) => {
  test.setTimeout(240_000);
  const daemonUrl = toolsDev.daemonUrl;
  if (!daemonUrl) throw new Error('Missing isolated daemon URL.');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  expect((await page.request.put(`${daemonUrl}/api/config`, { data: { agentId: 'codex' } })).ok()).toBe(true);
  const sampleStyle = (await readFile(new URL('../../apps/web/public/cartography-sample/style.json', import.meta.url), 'utf8'))
    .replace('"/cartography-sample/riverside.geojson"', await readFile(new URL('../../apps/web/public/cartography-sample/riverside.geojson', import.meta.url), 'utf8'));
  await page.route('**/api/map-design/projects/*/style', route => route.fulfill({ contentType: 'application/json', body: sampleStyle }));
  await page.setViewportSize({ width: 1280, height: 900 });
  const title = 'Recovery workspace';
  const projectId = await createAndOpenReadyMapProject(page, daemonUrl, { projectPrefix: 'workspace-recovery', title });
  const conversationId = new URL(page.url()).searchParams.get('conversation');
  if (!conversationId) throw new Error('No selected conversation.');
  const conversationUrl = `${daemonUrl}/api/map-design/projects/${projectId}/conversations/${conversationId}`;
  const snapshot = async (): Promise<MapDesignConversationResponse> => (await page.request.get(conversationUrl)).json();
  await expect.poll(async () => (await snapshot()).messages.at(-1)?.runStatus, { timeout: 30_000 }).toBe('succeeded');
  await page.reload({ waitUntil: 'domcontentloaded' });
  const composer = page.getByRole('textbox', { name: 'Message map agent', exact: true });
  await expect(composer).toBeEditable({ timeout: 60_000 });
  await page.getByLabel('Choose text files', { exact: true }).setInputFiles({ name: 'navigation-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep the river labels readable.') });
  await expect(page.getByRole('button', { name: 'Remove navigation-notes.txt', exact: true })).toBeVisible();
  await composer.fill('Start a long validation');
  await visitSettingsAndReturn(page, title);
  await expect(composer).toHaveValue('Start a long validation');
  await expect(page.getByRole('button', { name: 'Remove navigation-notes.txt', exact: true })).toBeVisible();
  const attachmentRequests: unknown[] = [];
  const prompts: string[] = [];
  const eventRequests: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path === '/api/runs') {
      const body: unknown = request.postDataJSON();
      if (typeof body === 'object' && body !== null && 'attachmentIds' in body) attachmentRequests.push(body.attachmentIds);
      if (typeof body === 'object' && body !== null && 'prompt' in body && typeof body.prompt === 'string') prompts.push(body.prompt);
    }
    if (/^\/api\/runs\/[^/]+\/events$/.test(path)) eventRequests.push(path);
  });
  await composer.fill('Start a long validation');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const cancel = page.getByRole('button', { name: 'Cancel run', exact: true });
  await expect(cancel).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove navigation-notes.txt', exact: true })).toBeHidden();
  await expect.poll(() => attachmentRequests).toEqual([[expect.stringMatching(/^[a-f0-9]{64}$/)]]);
  await expect.poll(async () => (await snapshot()).activeRun?.status).toBe('running');
  const activeRun = (await snapshot()).activeRun;
  if (!activeRun) throw new Error('The real daemon did not expose its active run.');
  const queuedPrompt = '检查中文地名，并保留水域与道路的清晰层级。';
  await composer.fill(queuedPrompt);
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click();
  const queue = page.getByRole('region', { name: 'Queued messages', exact: true });
  await expect(queue).toContainText(queuedPrompt);
  await visitSettingsAndReturn(page, title);
  await expect(queue).toContainText(queuedPrompt);
  await expect(cancel).toBeVisible();
  await expect.poll(() => eventRequests.filter(path => path.includes(activeRun.runId)).length).toBeGreaterThanOrEqual(2);
  expect((await snapshot()).activeRun?.runId).toBe(activeRun.runId);
  expect(prompts).toEqual(['Start a long validation']);
  await writeFile(`${toolsDev.fakeMapAcp.capturePath}.long-validation-start.release`, 'release', 'utf8');
  await page.getByRole('button', { name: /Reasoning summary/ }).last().click();
  await expect(page.getByText('Checking long-running validation constraints.', { exact: true })).toBeVisible({ timeout: 30_000 });
  const directory = fileURLToPath(new URL('../../.tmp/workspace-recovery/', import.meta.url));
  await mkdir(directory, { recursive: true });
  const captures: string[] = [];
  const layouts: Array<{ width: number; scrollWidth: number }> = [];
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(queue).toBeVisible();
    const path = resolve(directory, `restored-${width}.png`);
    await page.screenshot({ path, animations: 'disabled', style: 'nextjs-portal { visibility: hidden; }' });
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(width);
    layouts.push({ width, scrollWidth });
    captures.push(path);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await cancel.click();
  await expect.poll(async () => {
    const run: MapDesignRunResponse = await (await page.request.get(`${daemonUrl}/api/runs/${activeRun.runId}`)).json();
    return run.status;
  }).toBe('canceled');
  await expect(queue.getByRole('button', { name: 'Continue queue' })).toBeVisible();
  await visitSettingsAndReturn(page, title);
  await expect(queue).toContainText(queuedPrompt);
  await expect(queue.getByRole('button', { name: 'Continue queue' })).toBeVisible();
  expect(prompts).toEqual(['Start a long validation']);
  const paused = resolve(directory, 'paused-after-return.png');
  await page.screenshot({ path: paused, animations: 'disabled', style: 'nextjs-portal { visibility: hidden; }' });
  captures.push(paused);
  await queue.getByRole('button', { name: 'Continue queue' }).click();
  await expect(queue).toBeHidden();
  await expect.poll(async () => (await snapshot()).messages.at(-1)?.runStatus, { timeout: 30_000 }).toBe('succeeded');
  await expect(cancel).toBeHidden();
  expect(prompts).toEqual(['Start a long validation', queuedPrompt]);
  expect(errors).toEqual([]);
  await writeFile(resolve(directory, 'browser-result.json'), JSON.stringify({ captures, layouts, prompts, eventRequests, attachmentRequests, errors,
    evidence: 'Real isolated daemon, conversation discovery, run SSE, cancellation and local fake Codex process; only rendered map style uses bundled inline sample data. No commercial model requests.' }, null, 2));
});

async function visitSettingsAndReturn(page: Page, title: string) {
  await page.getByRole('button', { name: 'Back to home', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('tab', { name: title, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message map agent', exact: true })).toBeVisible();
}
