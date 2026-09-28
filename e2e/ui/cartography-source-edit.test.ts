import { expect, test } from '@/playwright/suite';
import { createCartographySourceModelFixture } from '../lib/playwright/cartography-source-model-fixture.js';

test('[P1] imported style actions precede the draft and Agent reads its original source', async ({ page, toolsDev }, testInfo) => {
  test.setTimeout(180_000);
  const source = '---\nversion: "0.4.0"\nname: 原始样式规范\n---\n\n## Overview\n原始供应商字段已核对，补充道路尺度指导。';
  const uploaded = JSON.stringify({ version: 8, name: 'Original style', metadata: { vendorEvidence: 'source-only-7f3c' }, sources: {}, layers: [{ id: 'paper', type: 'background', paint: { 'background-color': '#faf9f5' } }] });
  const model = await createCartographySourceModelFixture(source);
  try {
    const configured = await page.request.put(`${toolsDev.daemonUrl}/api/map-design/api-profiles/cartography-source`, {
      data: { name: 'Source model', protocol: 'openai', apiFormat: 'chat-completions', baseUrl: model.baseUrl, model: 'source-model', apiKey: 'local-fixture-key', requiresApiKey: true },
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
    await page.getByRole('tab', { name: '从样式创建', exact: true }).click();
    await page.getByRole('textbox', { name: '规范名称', exact: true }).fill('原始样式规范');
    await page.locator('input[type="file"]').setInputFiles({ name: 'original-style.json', mimeType: 'application/json', buffer: Buffer.from(uploaded) });
    await page.getByRole('button', { name: '生成草稿', exact: true }).click();
    const edit = page.getByRole('button', { name: '使用 Agent 编辑', exact: true });
    await expect(edit).toBeVisible();
    const textarea = page.getByRole('textbox', { name: 'CARTOGRAPHY.md', exact: true });
    expect(await textarea.inputValue()).not.toContain('source-only-7f3c');
    const editBox = await edit.boundingBox();
    const draftBox = await textarea.boundingBox();
    if (!editBox || !draftBox) throw new Error('Draft actions and document must be rendered.');
    expect(editBox.y + editBox.height).toBeLessThanOrEqual(draftBox.y);
    await page.screenshot({ path: testInfo.outputPath('imported-draft.png') });
    await edit.click();
    await expect(page).toHaveURL(/\/cartographies\/edit\/[a-f0-9-]+/, { timeout: 60_000 });
    await expect(page.getByRole('button', { name: /更改运行时:/ })).toContainText('Source model');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByText('已读取原始样式并完善规范。', { exact: true })).toBeVisible({ timeout: 60_000 });
    expect(model.requests).toHaveLength(2);
    expect(model.toolResults).toHaveLength(1);
    const result: unknown = JSON.parse(model.toolResults[0] ?? 'null');
    expect(result).toEqual(expect.objectContaining({ fileName: 'source/document-1.json', content: uploaded, nextOffset: null }));
    await expect(page.getByLabel('预览规范')).toContainText('原始供应商字段已核对');
    await page.screenshot({ path: testInfo.outputPath('source-edit-complete.png') });
  } finally { await model.close(); }
});
