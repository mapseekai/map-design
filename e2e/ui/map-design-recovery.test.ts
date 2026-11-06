import { expect, test } from '@/playwright/suite';
import { createAndOpenReadyMapProject, waitForRenderedMap } from '@/playwright/map-design-project';
import { PNG } from 'pngjs';

test('[P1] external edits and restores update both the rendered map and editor revision', async ({ page, toolsDev }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  const id = await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!);
  const base = `${toolsDev.daemonUrl}/api/map-design/projects/${id}`;
  const readContext = () => fetch(`${base}/context`).then(response => response.json());
  const initial = await readContext();
  const original = await fetch(`${base}/style`).then(response => response.json());
  const changed = structuredClone(original);
  changed.name = 'external-edit';
  for (const layer of changed.layers) {
    if (layer.type === 'background') layer.paint = { ...layer.paint, 'background-color': '#123456' };
    if (layer.type === 'fill') layer.paint = { ...layer.paint, 'fill-color': '#123456', 'fill-opacity': 1 };
  }
  const saveResponse = await fetch(`${base}/style-document`, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: initial.draftRevision, styleHash: initial.styleHash, idempotencyKey: crypto.randomUUID(), style: changed }) });
  const saved = await saveResponse.json();
  expect(saveResponse.ok, JSON.stringify(saved)).toBe(true);
  const canvas = page.locator('#map-design-map-surface canvas.maplibregl-canvas');
  const blueFraction = async () => {
    const png = PNG.sync.read(await canvas.screenshot());
    let blue = 0, samples = 0;
    for (let y = 0; y < png.height; y += 10) for (let x = 0; x < png.width; x += 10) {
      const i = (y * png.width + x) * 4;
      samples++;
      if (Math.abs(png.data[i]! - 18) < 3 && Math.abs(png.data[i + 1]! - 52) < 3 && Math.abs(png.data[i + 2]! - 86) < 3) blue++;
    }
    return blue / samples;
  };
  await expect.poll(blueFraction).toBeGreaterThan(0.6);
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'style.json', exact: true });
  await expect(editor).toBeVisible();
  const header = page.getByRole('region', { name: 'Map canvas', exact: true }).locator('header');
  await expect(header).toContainText(`Revision ${saved.draftRevision}`);
  await page.screenshot({ path: testInfo.outputPath('external-edit-synchronized.png'), fullPage: true });
  await editor.fill('{"version":8,"name":"unsaved-local-draft"');
  await expect(page.getByRole('status').filter({ hasText: 'Invalid JSON' })).toBeVisible();
  const restoreResponse = await fetch(`${base}/revisions/0/restore`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedDraftRevision: saved.draftRevision, idempotencyKey: crypto.randomUUID(), confirmReplaceDraft: true,
      intentSummary: `Restore MapDesign revision 0 as a new draft for project ${id}.` }) });
  const restored = await restoreResponse.json();
  expect(restoreResponse.ok, JSON.stringify(restored)).toBe(true);
  expect(restored.draftRevision).toBe(saved.draftRevision + 1);
  await expect(header).toContainText(`Revision ${restored.draftRevision}`);
  await expect(editor).toContainText('unsaved-local-draft');
  await expect(page.getByRole('button', { name: 'Discard edits and reload', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect.poll(blueFraction).toBeLessThan(0.2);
  expect(await fetch(`${base}/style`).then(response => response.json())).toEqual(original);
  await page.screenshot({ path: testInfo.outputPath('external-restore-synchronized.png'), fullPage: true });
});

test('[P1] restores a historical version as a new draft without rewriting committed history', async ({ page, toolsDev }) => {
  test.setTimeout(120_000);
  const id = await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!);
  const base = `${toolsDev.daemonUrl}/api/map-design/projects/${id}`;
  const context = () => fetch(`${base}/context`).then(response => response.json());
  const initial = await context();
  const draft = await fetch(`${base}/style`).then(response => response.json());
  draft.name = 'Browser recovery draft';
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await page.getByRole('textbox', { name: 'style.json', exact: true }).fill(JSON.stringify(draft, null, 2));
  await expect.poll(async () => (await context()).draftRevision).toBeGreaterThan(initial.draftRevision);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const before = await context();
  const history = await fetch(`${base}/revisions`).then(response => response.json());
  const original = await fetch(`${base}/revisions/0/snapshot`).then(response => response.json());
  await page.getByRole('button', { name: 'Versions', exact: true }).click();
  await page.getByRole('button', { name: 'View revision 0', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Viewing revision 0 · Read only', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit style', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Restore as new draft', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await context()).draftRevision).toBe(before.draftRevision);
  await page.getByRole('button', { name: 'Restore as new draft', exact: true }).click();
  const restored = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/revisions/0/restore'));
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restore as new draft', exact: true }).click();
  expect((await restored).ok()).toBe(true);
  await expect(page).not.toHaveURL(/revision=/);
  await expect.poll(context).toMatchObject({ committedRevision: initial.committedRevision, draftRevision: before.draftRevision + 1 });
  expect(await fetch(`${base}/revisions`).then(response => response.json())).toEqual(history);
  expect(await fetch(`${base}/style`).then(response => response.json())).toEqual(original.style);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Edit style', exact: true })).toBeEnabled();
});

test('[P1] retries failed map resources and renders the recovered map', async ({ page, toolsDev }) => {
  test.setTimeout(120_000);
  const id = await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const matches = (url: URL) => url.hostname === 'demotiles.maplibre.org' || url.pathname.startsWith(`/api/map-design/projects/${id}/resources/`);
  await page.route(matches, route => route.fulfill({ status: 502, body: 'Resource unavailable' }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  const alert = page.getByRole('region', { name: 'Map canvas', exact: true }).getByRole('alert');
  await expect(alert).toContainText('Some map resources are unavailable.');
  await page.unroute(matches);
  await alert.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(alert).toHaveCount(0);
  await waitForRenderedMap(page.locator('#map-design-map-surface [role="region"][aria-label="Map"]'));
  expect(errors).toEqual([]);
});

test('[P1] exposes exhausted live updates and reconnects on retry', async ({ page, toolsDev }) => {
  test.setTimeout(120_000);
  const id = await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!);
  const matches = (url: URL) => url.pathname === `/api/map-design/projects/${id}/events`;
  await page.route(matches, route => route.abort());
  await page.reload({ waitUntil: 'domcontentloaded' });
  const alert = page.getByRole('alert').filter({ hasText: 'Live map updates are disconnected' });
  await expect(alert).toBeVisible();
  await page.unroute(matches);
  const connected = page.waitForResponse(response => matches(new URL(response.url())) && response.ok());
  await alert.getByRole('button', { name: 'Retry', exact: true }).click();
  await connected;
  await expect(alert).toHaveCount(0);
});
