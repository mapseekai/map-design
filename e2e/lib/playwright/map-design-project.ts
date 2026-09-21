import { expect } from '@/playwright/suite';
import { PNG } from 'pngjs';
import type { Locator, Page } from '@playwright/test';

export async function createAndOpenReadyMapProject(
  page: Page,
  daemonUrl: string,
  options: { agentId?: string; projectPrefix?: string; title?: string } = {},
): Promise<string> {
  const projectId = `${options.projectPrefix ?? 'layout'}-${crypto.randomUUID()}`;
  const response = await fetch(`${daemonUrl}/api/map-design/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId, title: options.title ?? 'Layout acceptance map',
      source: { url: 'https://demotiles.maplibre.org/style.json' },
      designRequirement: 'Keep the map deterministic and legible.',
      runtime: { agentId: options.agentId ?? 'codex' }, idempotencyKey: `map-create:${projectId}`,
    }),
  });
  expect(response.ok, await response.text()).toBe(true);
  await expect.poll(async () => (await fetch(`${daemonUrl}/api/map-design/projects/${projectId}`).then((value) => value.json()) as { project: { lifecycle: string } }).project.lifecycle)
    .toBe('ready');
  await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('region', { name: 'Map canvas' })).toBeVisible();
  await waitForRenderedMap(page.locator('#map-design-map-surface [role="region"][aria-label="Map"]'));
  return projectId;
}

export async function waitForRenderedMap(map: Locator): Promise<void> {
  await expect(map).toBeVisible();
  await expect.poll(async () => renderedMapFrame(await map.screenshot())).toBe(true);
}

function renderedMapFrame(image: Buffer): boolean {
  const png = PNG.sync.read(image);
  const colors = new Map<string, number>();
  const stride = Math.max(1, Math.floor(Math.min(png.width, png.height) / 40));
  let samples = 0;
  for (let y = 0; y < png.height; y += stride) {
    for (let x = 0; x < png.width; x += stride) {
      const offset = (y * png.width + x) * 4;
      if (png.data[offset + 3] === 0) continue;
      const color = `${png.data[offset]},${png.data[offset + 1]},${png.data[offset + 2]}`;
      colors.set(color, (colors.get(color) ?? 0) + 1);
      samples += 1;
    }
  }
  const dominant = Math.max(0, ...colors.values());
  return colors.size >= 16 && samples > 0 && dominant / samples < 0.9;
}
