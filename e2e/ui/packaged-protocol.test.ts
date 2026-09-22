import { expect, test } from '../lib/playwright/packaged-protocol.ts';

test('loads module worker imports through the packaged protocol while preserving Origin', async ({ packagedProtocol }) => {
  await expect(packagedProtocol.page.locator('body')).toHaveAttribute('data-worker', 'ready');
  expect(packagedProtocol.origins).toContain('map-design://app');
});
