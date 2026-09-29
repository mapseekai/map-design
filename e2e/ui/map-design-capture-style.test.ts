import { expect, test } from '@/playwright/suite';
import { createAndOpenReadyMapProject, waitForMapResources, waitForRenderedMap } from '@/playwright/map-design-project';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';

test('[P1] screenshots reach chat and direct styles preview, cancel and persist', async ({ page, toolsDev }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const projectId = await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!, { projectPrefix: 'capture-style', title: 'Screenshot and style acceptance' });
  const styleUrl = `${toolsDev.daemonUrl}/api/map-design/projects/${projectId}/style`;
  const readStyle = async () => await fetch(styleUrl).then((response) => response.json()) as { layers: Array<{ id: string; paint?: Record<string, unknown> }> };
  const original = await readStyle();
  const thumbnailUrl = `${toolsDev.daemonUrl}/api/map-design/projects/${projectId}/thumbnail`;
  await expect.poll(async () => (await fetch(thumbnailUrl)).status).toBe(200);
  const projectThumbnail = PNG.sync.read(Buffer.from(await (await fetch(thumbnailUrl)).arrayBuffer()));
  expect(projectThumbnail.width).toBeGreaterThan(100);
  expect(projectThumbnail.height).toBeGreaterThan(100);
  expect(new Set(projectThumbnail.data).size).toBeGreaterThan(4);

  await page.getByRole('button', { name: 'Screenshot to chat', exact: true }).click();
  const thumbnail = page.getByRole('img', { name: 'Map screenshot', exact: true });
  await expect(thumbnail).toBeVisible();
  const pngUrl = await thumbnail.getAttribute('src');
  const response = await page.request.get(pngUrl!);
  expect(response.ok()).toBe(true);
  const png = PNG.sync.read(await response.body());
  expect(png.width).toBeGreaterThan(100); expect(png.height).toBeGreaterThan(100);
  expect(new Set(Array.from(png.data.subarray(0, Math.min(png.data.length, 65536))))).not.toEqual(new Set([0]));
  await page.getByRole('button', { name: 'Remove screenshot', exact: true }).click();
  await expect(thumbnail).toHaveCount(0);
  await page.getByRole('button', { name: 'Screenshot to chat', exact: true }).click();
  await expect(thumbnail).toBeVisible();

  await page.getByRole('button', { name: 'Edit style', exact: true }).click();
  await pickStyleFeature(page);
  const editor = page.getByRole('dialog', { name: 'Style map feature', exact: true });
  await editor.getByRole('button', { name: 'Entire layer', exact: true }).click();
  await editor.getByRole('textbox', { name: /^(Color|Text color)$/ }).fill('#123456');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await readStyle()).toEqual(original);
  await expect(page.getByRole('button', { name: 'Edit style', exact: true })).toBeFocused();

  await expect(page.getByRole('button', { name: 'Edit style', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await pickStyleFeature(page);
  await editor.getByRole('button', { name: 'Entire layer', exact: true }).click();
  await editor.getByRole('textbox', { name: /^(Color|Text color)$/ }).fill('#123456');
  const saved = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/style-edits'));
  await editor.getByRole('button', { name: 'Save style', exact: true }).click();
  const saveResponse = await saved;
  expect(saveResponse.ok(), await saveResponse.text()).toBe(true);
  const edit = saveResponse.request().postDataJSON() as { target: { layerId: string }; changes: Record<string, unknown> };
  await expect(editor).toHaveCount(0);
  expect((await readStyle()).layers.find((layer) => layer.id === edit.target.layerId)?.paint).toMatchObject(edit.changes);

  await page.getByRole('textbox', { name: 'Message map agent', exact: true }).fill('Describe the attached map screenshot');
  const started = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect((await started).postDataJSON().screenshotIds).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Remove screenshot', exact: true })).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Map screenshot', exact: true })).toHaveCount(1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('img', { name: 'Map screenshot', exact: true })).toBeVisible();
  await waitForRenderedMap(page.locator('#map-design-map-surface [role="region"][aria-label="Map"]'));
  expect((await readStyle()).layers.find((layer) => layer.id === edit.target.layerId)?.paint).toMatchObject(edit.changes);
  await page.screenshot({ path: testInfo.outputPath('capture-style-desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Map', exact: true }).click();
  await page.getByRole('button', { name: 'Edit style', exact: true }).click();
  await pickStyleFeature(page);
  const bounds = await editor.boundingBox();
  expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('capture-style-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: /^Comment \(/ }).click();
  await expect(editor).toHaveCount(0);
  expect(errors).toEqual([]);
});

async function pickStyleFeature(page: Page) {
  await waitForMapResources(page);
  const canvas = page.locator('#map-design-map-surface canvas.maplibregl-canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Map canvas missing');
  for (const vertical of [0.5, 0.65, 0.35, 0.8]) {
    for (const horizontal of [0.25, 0.4, 0.1, 0.5]) {
      await page.mouse.click(bounds.x + bounds.width * horizontal, bounds.y + bounds.height * vertical);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const choices = page.getByRole('region', { name: 'Choose the intended feature', exact: true });
      if (await choices.isVisible()) await choices.getByRole('button').first().click();
      if (await page.getByRole('textbox', { name: /^(Color|Text color)$/ }).isVisible()) return;
    }
  }
  throw new Error('No styleable rendered feature found');
}
