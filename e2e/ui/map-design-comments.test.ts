import { readFile } from 'node:fs/promises';
import { expect, test } from '@/playwright/suite';
import { createAndOpenReadyMapProject, waitForMapResources } from '@/playwright/map-design-project';
import type { Page } from '@playwright/test';

test('[P1] map comments persist, keep geographic markers aligned and submit one scoped batch', async ({ page, toolsDev }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const projectId = await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!, { projectPrefix: 'comments', title: 'Comment acceptance map' });
  const endpoint = `${toolsDev.daemonUrl}/api/map-design/projects/${projectId}/comments`;
  await page.getByRole('button', { name: 'Annotate' }).click();
  const picked = await pickVisibleFeature(page);
  await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Give this layer a warmer color');
  await page.getByRole('button', { name: 'Entire layer', exact: true }).click();
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await expect.poll(async () => (await fetch(endpoint).then((response) => response.json())).length).toBe(1);
  // Native point layers have no DOM marker. Clicking the original geographic
  // anchor must reopen the saved comment instead of selecting underlying data.
  await expect(async () => {
    await page.mouse.click(picked.x, picked.y);
    await expect(page.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue('Give this layer a warmer color');
  }).toPass();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Annotate', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Annotate' }).click();
  await pickVisibleFeature(page);
  await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Make the matching class easier to distinguish');
  // The imported demo countries expose scalar properties for an exact category match.
  await page.getByRole('button', { name: /^(Similar|Matching property)/ }).click();
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await expect.poll(async () => (await fetch(endpoint).then((response) => response.json())).length).toBe(2);
  const before = await fetch(endpoint).then((response) => response.json()) as Array<{ id: string; version: number; scope: string }>;
  expect(before.map((comment) => comment.scope).sort()).toEqual(['layer', 'similar']);
  await page.getByRole('button', { name: /^Comment \(\d+\)$/ }).click();
  await page.getByRole('checkbox', { name: 'Select comment 1', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Select comment 2', exact: true }).check();
  const runRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs');
  await page.getByRole('button', { name: 'Send selected', exact: true }).click();
  const body = (await runRequest).postDataJSON() as { commentRefs: Array<{ id: string; version: number }> };
  expect(body.commentRefs).toEqual(before.map(({ id, version }) => ({ id, version })));
  await expect.poll(async () => (await fetch(endpoint).then((response) => response.json())).length).toBe(0);
  // Successful comments leave the active list; create and immediately submit a new one.
  await page.getByRole('button', { name: 'New comment', exact: true }).click();
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  await pickVisibleFeature(page);
  await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Only adjust this one selected feature');
  await page.getByRole('button', { name: 'This feature', exact: true }).click();
  const immediateRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs');
  const savedCommentResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/map-design/projects/${projectId}/comments`);
  await page.getByRole('button', { name: 'Send now', exact: true }).click();
  expect((await immediateRequest).postDataJSON().commentRefs).toHaveLength(1);
  const savedComment = await (await savedCommentResponse).json() as { scope: string; target: { featureId?: string | number } };
  expect(savedComment.scope).toBe('feature');
  expect(savedComment.target.featureId).toBeDefined();
  await expect.poll(async () => (await fetch(endpoint).then((response) => response.json())).length).toBe(0);
  const capture = await readFile(toolsDev.fakeMapAcp.capturePath, 'utf8');
  expect(capture).toContain('Preserve all nonmatching features');
  for (const comment of before) expect(capture).toContain(comment.id);
  expect(capture).toContain('"resumed":true');
  await page.getByRole('button', { name: /^Comment \(\d+\)$/ }).click();
  await page.screenshot({ path: testInfo.outputPath('map-comments-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Map', exact: true }).click();
  await page.getByRole('button', { name: /^Comment \(\d+\)$/ }).click();
  await expect(page.getByRole('region', { name: 'Map comments', exact: true })).toBeVisible();
  const panel = page.getByRole('tabpanel', { name: /^Comment \(\d+\)$/ });
  const panelBounds = await panel.boundingBox();
  expect(panelBounds).not.toBeNull();
  expect(panelBounds!.x).toBeGreaterThanOrEqual(0);
  expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(390);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('map-comments-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

async function pickVisibleFeature(page: Page): Promise<{ x: number; y: number }> {
  await waitForMapResources(page);
  const canvas = page.locator('#map-design-map-surface canvas.maplibregl-canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Map canvas missing');
  // Probe the uncovered map area; use rendered hits rather than relying on a
  // particular remote dataset's feature IDs or exposing a test-only map handle.
  for (const vertical of [0.35, 0.5, 0.25, 0.65]) {
    for (const horizontal of [0.65, 0.8, 0.95]) {
      const x = bounds.x + bounds.width * horizontal;
      const y = bounds.y + bounds.height * vertical;
      await page.mouse.click(x, y);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const choices = page.getByRole('region', { name: 'Choose the intended feature' });
      if (await choices.isVisible()) await choices.getByRole('button').first().click();
      const comment = page.getByRole('textbox', { name: 'Comment', exact: true });
      if (await comment.isVisible()) {
        if (await comment.inputValue()) {
          const reset = page.getByRole('button', { name: 'New comment', exact: true });
          if (await reset.isVisible()) await reset.click();
          else await page.getByRole('button', { name: 'Cancel', exact: true }).click();
          continue;
        }
        return { x, y };
      }
    }
  }
  throw new Error('No commentable rendered feature found in the map');
}
