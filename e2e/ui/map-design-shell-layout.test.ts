import { expect, test } from '@/playwright/suite';

const locales = [
  { code: 'en', label: 'English', rtl: false, open: 'Open navigation' },
  { code: 'zh-CN', label: '简体中文', rtl: false, open: '打开导航' },
  { code: 'ar', label: 'العربية', rtl: true, open: 'فتح التنقل' },
  { code: 'fa', label: 'فارسی', rtl: true, open: 'باز کردن پیمایش' },
] as const;

for (const locale of locales) {
  test(`keeps ${locale.code} navigation beside settings and opens mobile navigation at the starting edge`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/settings/appearance');
    await page.getByRole('combobox', { name: 'Language', exact: true }).click();
    await page.getByRole('option', { name: locale.label, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', locale.code);
    const sidebar = page.locator('[data-slot="sidebar-container"]');
    const main = page.getByRole('main');
    await expect.poll(async () => {
      const [navigation, content] = await Promise.all([sidebar.boundingBox(), main.boundingBox()]);
      if (!navigation || !content) return false;
      return locale.rtl ? content.x + content.width <= navigation.x + 1
        : navigation.x + navigation.width <= content.x + 1;
    }).toBe(true);
    await expect(sidebar).toHaveAttribute('data-side', locale.rtl ? 'right' : 'left');
    await testInfo.attach(`${locale.code}-desktop-settings`, { body: await page.screenshot(), contentType: 'image/png' });

    await page.setViewportSize({ width: 390, height: 844 });
    const trigger = page.getByRole('button', { name: locale.open, exact: true });
    await expect.poll(async () => {
      const bounds = await trigger.boundingBox();
      return bounds !== null && (locale.rtl ? bounds.x > 195 : bounds.x + bounds.width < 195);
    }).toBe(true);
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect.poll(async () => {
      const bounds = await dialog.boundingBox();
      return bounds === null ? -1 : Math.round(locale.rtl ? bounds.x + bounds.width : bounds.x);
    }).toBe(locale.rtl ? 390 : 0);
    await testInfo.attach(`${locale.code}-mobile-navigation`, { body: await page.screenshot(), contentType: 'image/png' });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
}
