import { expect, test } from '@/playwright/suite';
import { createApiProfileFixture } from '../lib/playwright/api-profile-fixture.js';

test('[P1] localizes project failures and API profile dialog controls in Chinese', async ({ page, toolsDev }, testInfo) => {
  test.setTimeout(120_000);
  const daemonUrl = toolsDev.daemonUrl;
  if (!daemonUrl) throw new Error('Missing isolated daemon URL');
  const projectId = `review-localization-${crypto.randomUUID()}`;
  const title = 'Review localized project';
  const created = await page.request.post(`${daemonUrl}/api/map-design/projects`, { data: {
    projectId, title, source: { url: 'https://example.invalid/style.json' }, runtime: { agentId: 'codex' },
    designRequirement: 'Review localized failures.', idempotencyKey: projectId,
  } });
  expect(created.ok()).toBe(true);
  await page.addInitScript(() => {
    localStorage.setItem('map-design:locale', 'zh-CN');
    localStorage.setItem('map-design:locale-source', 'manual');
  });
  await page.route(`**/api/map-design/projects/${projectId}`, route => route.request().method() === 'DELETE'
    ? route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: 'An English upstream failure' } } })
    : route.continue());
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: new RegExp(`: ${title}$`) }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByText('无法删除项目，请重试。', { exact: true })).toBeVisible();
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByText('无法删除项目，请重试。', { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByText('无法删除项目，请重试。', { exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`project-error-${width}.png`), animations: 'disabled', style: 'nextjs-portal { visibility: hidden; }' });
  }

  const fixture = await createApiProfileFixture();
  const profileId = `review-profile-${crypto.randomUUID()}`;
  try {
    const saved = await page.request.put(`${daemonUrl}/api/map-design/api-profiles/${profileId}`, { data: {
      name: '审查模型', protocol: 'openai', apiFormat: 'chat-completions', baseUrl: `${fixture.baseUrl}/first/v1`,
      model: 'shared-model', requiresApiKey: false,
    } });
    expect(saved.ok()).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '模型提供商', exact: true }).click();
    const profile = page.locator(`[data-profile-id="${profileId}"]`);
    await expect(profile).toBeVisible();
    const dialog = page.getByRole('dialog');
    for (const width of [1280, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('tab', { name: '模型提供商', exact: true }).click();
      await profile.getByRole('button', { name: '删除', exact: true }).click();
      await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`profile-dialog-${width}.png`), animations: 'disabled', style: 'nextjs-portal { visibility: hidden; }' });
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await expect(dialog).toBeHidden();
    }
    expect(fixture.calls).toHaveLength(0);
  } finally { await fixture.close(); }
});
