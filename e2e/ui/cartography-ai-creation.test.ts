import { expect, test } from '@/playwright/suite';
import { createCartographyModelFixture } from '../lib/playwright/cartography-model-fixture.js';

test('[P1] AI creation opens the editing conversation before the model finishes', async ({ page, toolsDev }, testInfo) => {
  test.setTimeout(180_000);
  const name = '步行地图规范';
  const brief = '创建温暖纸色的城市步行地图，明确道路层级和中文标签。';
  const source = `---\nversion: "0.4.0"\nname: ${name}\n---\n\n## Overview\n温暖纸色，突出步行道路与中文标签。`;
  const model = await createCartographyModelFixture(source);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const configured = await page.request.put(`${toolsDev.daemonUrl}/api/map-design/api-profiles/cartography-creation`, {
      data: { name: 'Creation model', protocol: 'openai', apiFormat: 'chat-completions', baseUrl: model.baseUrl,
        model: 'cartography-model', apiKey: 'local-fixture-key', requiresApiKey: true },
    });
    expect(configured.ok()).toBe(true);
    await page.goto('/cartographies', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.setItem('map-design:locale', 'zh-CN');
      localStorage.setItem('map-design:locale-source', 'manual');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '添加规范', exact: true }).click();
    await page.getByRole('tab', { name: 'AI 从零创作', exact: true }).click();
    await page.locator('#cartographymanager-6').click();
    await page.locator('[role="option"][data-value="api"]').click();
    await page.getByRole('textbox', { name: '规范名称', exact: true }).fill(name);
    await page.getByRole('textbox', { name: '设计要求', exact: true }).fill(brief);
    await page.getByRole('button', { name: '生成草稿', exact: true }).click();
    await expect(page).toHaveURL(/\/cartographies\/edit\/[a-f0-9-]+/);
    await expect(page.getByText(brief, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '取消运行', exact: true })).toBeVisible();
    await expect.poll(() => model.requests.length).toBe(1);
    expect(model.requests[0]).toContain('cartography-model');
    expect(model.requests[0]).toContain(brief);
    for (const width of [1280, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      if (width < 768) await expect(page.getByRole('tab', { name: '对话', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText(brief, { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`running-${width}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    model.release();
    await expect(page.getByText('已根据设计要求创建步行地图规范。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '取消运行', exact: true })).toBeHidden();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText(brief, { exact: true })).toBeVisible();
    await expect(page.getByText('已根据设计要求创建步行地图规范。', { exact: true })).toBeVisible();
    expect(model.requests).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath('completed.png') });
    expect(errors).toEqual([]);
  } finally { await model.close(); }
});
