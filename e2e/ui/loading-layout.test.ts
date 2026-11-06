import { expect, test } from '@/playwright/suite';

for (const width of [390, 1280]) {
  test(`centers page and preview loaders at ${width}px and ships the Monet preset`, async ({ page, toolsDev }) => {
    await page.setViewportSize({ width, height: 900 });
    const library = await fetch(`${toolsDev.daemonUrl}/api/map-design/cartographies`).then(response => response.json());
    expect(library.documents).toEqual(expect.arrayContaining([expect.objectContaining({ name: '莫奈风格', origin: 'preset' })]));
    let releaseConfig!: () => void;
    const configReady = new Promise<void>(resolve => { releaseConfig = resolve; });
    await page.route('**/api/config', async route => { await configReady; await route.continue(); });
    try {
      await page.goto('/settings');
      const loader = page.locator('main .map-loading[data-variant="panel"]');
      await expect(loader).toBeVisible();
      const offset = await loader.evaluate(element => {
        const main = element.closest('main')!;
        const bounds = main.getBoundingClientRect();
        const padding = parseFloat(getComputedStyle(main).paddingTop);
        const loading = element.getBoundingClientRect();
        return { x: loading.x + loading.width / 2 - (bounds.x + bounds.width / 2),
          y: loading.y + loading.height / 2 - (bounds.y + padding + (bounds.height - padding) / 2) };
      });
      expect(Math.abs(offset.x)).toBeLessThan(2);
      expect(Math.abs(offset.y)).toBeLessThan(2);
    } finally { releaseConfig(); }
    await page.unrouteAll({ behavior: 'wait' });

    let releaseStyle!: () => void;
    const styleReady = new Promise<void>(resolve => { releaseStyle = resolve; });
    await page.route('https://maps.example.com/loading-style.json', async route => {
      await styleReady;
      await route.fulfill({ json: { version: 8, sources: {}, layers: [] } });
    });
    try {
      await page.goto('/');
      await page.getByLabel('Public map URL').fill('https://maps.example.com/loading-style.json');
      const preview = page.getByRole('region', { name: 'Preview', exact: true });
      const loader = preview.locator('.map-loading');
      await expect(loader).toBeVisible();
      const bounds = await preview.boundingBox();
      const loading = await loader.boundingBox();
      expect(Math.abs(loading!.x + loading!.width / 2 - (bounds!.x + bounds!.width / 2))).toBeLessThan(2);
      expect(Math.abs(loading!.y + loading!.height / 2 - (bounds!.y + bounds!.height / 2))).toBeLessThan(2);
    } finally { releaseStyle(); }
    await page.unrouteAll({ behavior: 'wait' });
  });
}
