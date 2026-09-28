import { CartographyDocumentSchema, CartographySummarySchema } from '../../packages/map-design-contracts/src/cartography.js';
import { CartographyEditSessionSchema } from '../../packages/map-design-contracts/src/cartography-edit.js';
import { expect, test } from '@/playwright/suite';
import { createCartographySourceModelFixture } from '../lib/playwright/cartography-source-model-fixture.js';

test('[P1] Agent edits overwrite a library specification and save a named copy', async ({ page, toolsDev }, testInfo) => {
  test.setTimeout(180_000);
  const source = '---\nversion: "0.4.0"\nname: 保存测试规范\n---\n\n## Overview\n原始规范。';
  const edited = source.replace('原始规范。', 'Agent 已补充道路尺度指导。');
  const sourceFile = { fileName: 'original.json', content: Buffer.from('{"version":8,"metadata":{"vendor":"original"},"sources":{},"layers":[]}').toString('base64') };
  const model = await createCartographySourceModelFixture(edited);
  const libraryUrl = `${toolsDev.daemonUrl}/api/map-design/cartographies`;
  try {
    const profile = await page.request.put(`${toolsDev.daemonUrl}/api/map-design/api-profiles/cartography-save`, {
      data: { name: 'Save model', protocol: 'openai', apiFormat: 'chat-completions', baseUrl: model.baseUrl, model: 'source-model', apiKey: 'local-fixture-key', requiresApiKey: true },
    });
    expect(profile.ok()).toBe(true);
    const imported = await page.request.post(libraryUrl, { data: { source, sourceFile } });
    expect(imported.ok()).toBe(true);
    const original = CartographySummarySchema.parse(await imported.json());
    const created = await page.request.post(`${toolsDev.daemonUrl}/api/map-design/cartography-tools/edit-sessions`, {
      data: { source, sourceDocumentId: original.id, sourceFile, initialPrompt: '读取原始样式并完善道路尺度指导。', runtime: 'api' },
    });
    expect(created.ok()).toBe(true);
    const session = CartographyEditSessionSchema.parse(await created.json());
    await page.goto(`/cartographies/edit/${session.id}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { localStorage.setItem('map-design:locale', 'zh-CN'); localStorage.setItem('map-design:locale-source', 'manual'); });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByText('已读取原始样式并完善规范。', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel('预览规范')).toContainText('Agent 已补充道路尺度指导。');
    const overwritten = page.waitForResponse(response => response.url().endsWith(`/edit-sessions/${session.id}/save`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: '覆盖保存', exact: true }).click();
    const saveResponse = await overwritten;
    expect(saveResponse.ok()).toBe(true);
    const savedBody: unknown = await saveResponse.json();
    expect(savedBody).toMatchObject({ document: { name: '保存测试规范' }, session: { canOverwrite: true } });
    await expect(page.getByRole('button', { name: '覆盖保存', exact: true })).toBeDisabled();
    const current = CartographyEditSessionSchema.parse(await (await page.request.get(`${toolsDev.daemonUrl}/api/map-design/cartography-tools/edit-sessions/${session.id}`)).json());
    const document = CartographyDocumentSchema.parse(await (await page.request.get(`${libraryUrl}/${current.savedId}`)).json());
    expect(document.source).toContain('Agent 已补充道路尺度指导。');
    expect(document.sourceFile).toEqual(sourceFile);

    for (const width of [1280, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole('button', { name: '保存为新规范', exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`save-toolbar-${width}.png`) });
      await page.getByRole('button', { name: '保存为新规范', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('textbox', { name: '规范名称' })).toBeFocused();
      await dialog.getByRole('textbox', { name: '规范名称' }).fill('道路规范副本');
      await page.screenshot({ path: testInfo.outputPath(`save-dialog-${width}.png`) });
      if (width !== 375) await dialog.getByRole('button', { name: '取消', exact: true }).click();
    }
    await page.getByRole('dialog').getByRole('button', { name: '保存为新规范', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '道路规范副本', exact: true })).toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '道路规范副本', exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: '覆盖保存', exact: true })).toBeDisabled();
    const library: unknown = await (await page.request.get(libraryUrl)).json();
    expect(library).toMatchObject({ documents: expect.arrayContaining([
      expect.objectContaining({ id: current.savedId, name: '保存测试规范' }),
      expect.objectContaining({ name: '道路规范副本' }),
    ]) });
    expect(library).not.toMatchObject({ documents: expect.arrayContaining([expect.objectContaining({ id: original.id })]) });
    await page.screenshot({ path: testInfo.outputPath('saved-copy.png') });
  } finally { await model.close(); }
});

test('[P1] clearing an API output limit restores automatic budgeting', async ({ page, toolsDev }, testInfo) => {
  test.setTimeout(180_000);
  const configured = await page.request.put(`${toolsDev.daemonUrl}/api/config`, { data: { apiExecution: { maxOutputTokens: 16384 } } });
  expect(configured.ok()).toBe(true);
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('map-design:locale', 'zh-CN'); localStorage.setItem('map-design:locale-source', 'manual'); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: '模型提供商', exact: true }).click();
  const output = page.getByLabel(/每次调用的输出 Token 上限/);
  await expect(output).toHaveValue('16384');
  await output.fill('');
  await page.getByLabel(/最大模型调用步数/).fill('64');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText('设置已保存', { exact: true })).toBeVisible();
  const response = await page.request.get(`${toolsDev.daemonUrl}/api/config`);
  const result: unknown = await response.json();
  expect(result).toMatchObject({ config: { apiExecution: { maxSteps: 64 } } });
  expect(result).not.toMatchObject({ config: { apiExecution: { maxOutputTokens: expect.any(Number) } } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: '模型提供商', exact: true }).click();
  await expect(output).toHaveValue('');
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await output.scrollIntoViewIfNeeded();
    await output.focus();
    await page.screenshot({ path: testInfo.outputPath(`automatic-budget-${width}.png`) });
  }
});
