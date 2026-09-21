import { expect, test } from '@/playwright/suite';
import { createApiProfileFixture } from '../lib/playwright/api-profile-fixture.js';

test('[P1] saves, tests, selects and deletes named API profiles with persistent feedback', async ({ page, toolsDev }, testInfo) => {
  const model = await createApiProfileFixture();
  try {
    const setup = await fetch(`${toolsDev.daemonUrl}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'api' }) });
    expect(setup.ok).toBe(true);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto('/settings', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Saved API models' })).toBeVisible();
    await page.getByLabel('Configuration name', { exact: true }).fill('Primary API');
    await page.getByLabel('Base URL', { exact: true }).fill(`${model.baseUrl}/first/v1`);
    await page.getByLabel('API model', { exact: true }).fill('shared-model');
    await page.getByLabel('API key', { exact: true }).fill('local-test-value');
    await page.getByRole('button', { name: 'Save model', exact: true }).click();
    await expect(page.getByText('Primary API：Model saved', { exact: true })).toBeVisible();
    expect(model.calls).toHaveLength(0);
    const primary = page.locator('[data-profile-id]').filter({ hasText: 'Primary API' });
    await expect(primary.getByText('Default', { exact: true })).toBeVisible();
    await primary.getByRole('button', { name: 'Test connection' }).click();
    await expect(primary.getByText('Connection verified', { exact: true })).toBeVisible();
    expect(model.calls).toEqual([{ path: '/first/v1/chat/completions', model: 'shared-model' }]);
    await page.getByRole('button', { name: 'Add model' }).click();
    await page.getByLabel('Configuration name', { exact: true }).fill('Secondary API');
    await page.getByLabel('Base URL', { exact: true }).fill(`${model.baseUrl}/second/v1`);
    await page.getByLabel('API model', { exact: true }).fill('shared-model');
    await page.getByLabel('API key', { exact: true }).fill('local-second-value');
    await page.getByRole('button', { name: 'Save model', exact: true }).click();
    await expect(page.getByText('Secondary API：Model saved', { exact: true })).toBeVisible();
    const secondary = page.locator('[data-profile-id]').filter({ hasText: 'Secondary API' });
    await secondary.getByRole('button', { name: 'Set as default' }).click();
    await expect(secondary.getByText('Default', { exact: true })).toBeVisible();
    await secondary.getByRole('button', { name: 'Test connection' }).click();
    await expect(secondary.getByText('Connection verified', { exact: true })).toBeVisible();
    expect(model.calls.at(-1)).toEqual({ path: '/second/v1/chat/completions', model: 'shared-model' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(primary.getByText('Connection verified', { exact: true })).toBeVisible();
    await expect(secondary.getByText('Default', { exact: true })).toBeVisible();
    const response = await fetch(`${toolsDev.daemonUrl}/api/agents`); const catalogue = await response.json();
    const models = catalogue.agents.find((agent: { id: string }) => agent.id === 'api').models;
    expect(models).toHaveLength(2); expect(models.filter((item: { default: boolean }) => item.default)).toHaveLength(1);
    await testInfo.attach('api-profiles-settings', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await primary.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(primary).toBeVisible();
    await primary.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(primary).toHaveCount(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-profile-id]')).toHaveCount(1);
    await expect(secondary.getByText('Default', { exact: true })).toBeVisible();
  } finally { await model.close(); }
});


test('[P1] [external] conversation switches real API streams and recovers after deleting its selected profile', async ({ page, toolsDev }, testInfo) => {
  test.skip(process.env.MAP_DESIGN_EXTERNAL_SMOKE !== '1', 'Public map import acceptance is opt-in; model calls stay local.');
  test.setTimeout(120_000);
  const fixture = await createApiProfileFixture();
  const firstId = `first-${crypto.randomUUID()}`;
  const secondId = `second-${crypto.randomUUID()}`;
  const endpoint = `${toolsDev.daemonUrl}/api/map-design/api-profiles`;
  const projectId = `api-routing-${crypto.randomUUID()}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const profiles = [
    { id: firstId, name: 'Routing primary', path: 'first', key: 'local-test-value' },
    { id: secondId, name: 'Routing secondary', path: 'second', key: 'local-second-value' },
  ];
  try {
    for (const profile of profiles) {
      const response = await fetch(`${endpoint}/${profile.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: profile.name, protocol: 'openai', apiFormat: 'chat-completions',
          baseUrl: `${fixture.baseUrl}/${profile.path}/v1`, model: 'shared-model', apiKey: profile.key, requiresApiKey: true }) });
      expect(response.ok).toBe(true);
    }
    expect((await fetch(`${endpoint}/${firstId}/activate`, { method: 'POST' })).ok).toBe(true);
    const created = await fetch(`${toolsDev.daemonUrl}/api/map-design/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title: 'API conversation routing acceptance',
        source: { url: 'https://demotiles.maplibre.org/style.json' }, designRequirement: 'Reply without editing the map.',
        runtime: { agentId: 'api', model: `api-profile:${firstId}` }, idempotencyKey: `create:${projectId}` }),
    });
    expect(created.ok, await created.text()).toBe(true);
    await expect.poll(async () => {
      const response = await fetch(`${toolsDev.daemonUrl}/api/map-design/projects/${projectId}`);
      const result = await response.json(); return result.project.lifecycle;
    }, { timeout: 45_000 }).toBe('ready');
    await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Primary model answered.', { exact: true }).first()).toBeVisible();
    const picker = page.getByRole('button', { name: /Change runtime/ });
    await expect(picker).toBeEnabled();
    expect(fixture.streamCalls).toEqual([{ path: '/first/v1/chat/completions', model: 'shared-model', authenticated: true }]);

    const choose = async (name: string) => {
      await picker.click();
      const dialog = page.getByRole('dialog', { name: 'Runtime settings' });
      await dialog.getByRole('option', { name: new RegExp(name) }).click();
      await expect(dialog.getByRole('option', { name: new RegExp(name) })).toHaveAttribute('aria-selected', 'true');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(picker).toContainText(name);
    };
    const send = async (prompt: string, count: number, path: string) => {
      await page.getByRole('textbox', { name: 'Message map agent', exact: true }).fill(prompt);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => fixture.streamCalls.length).toBe(count);
      await expect(picker).toBeEnabled();
      expect(fixture.streamCalls.at(-1)).toEqual({ path, model: 'shared-model', authenticated: true });
    };
    await choose('Routing secondary');
    await send('Answer using the second saved configuration.', 2, '/second/v1/chat/completions');
    await expect(page.getByText('Secondary model answered.', { exact: true }).first()).toBeVisible();

    expect((await fetch(`${endpoint}/${firstId}/activate`, { method: 'POST' })).ok).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(picker).toContainText('Routing secondary');
    await send('Keep this conversation on its chosen model after reload.', 3, '/second/v1/chat/completions');

    expect((await fetch(`${endpoint}/${secondId}`, { method: 'DELETE' })).ok).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText('The selected API configuration is missing or unavailable. Select another saved model.').first()).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message map agent', exact: true })).toBeDisabled();
    await expect(picker).toBeEnabled();
    expect(fixture.streamCalls).toHaveLength(3);
    await choose('Routing primary');
    await send('Continue after explicitly choosing another saved configuration.', 4, '/first/v1/chat/completions');
    expect(errors).toEqual([]);
    await testInfo.attach('api-profile-conversation-routing', { body: await page.screenshot(), contentType: 'image/png' });
  } finally {
    for (const profile of profiles) await fetch(`${endpoint}/${profile.id}`, { method: 'DELETE' }).catch(() => undefined);
    await fixture.close();
  }
});
