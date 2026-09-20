import { readFile } from 'node:fs/promises';

import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';
import type { Page } from '@playwright/test';

const DESKTOP_VIEWPORT = { width: 1280, height: 900 } as const;
const SOURCE_URL = 'https://demotiles.maplibre.org/style.json';
const RETAINED_API_PATH = /^\/api\/(?:agents|config|runs(?:\/.*)?|map-design(?:\/.*)?)$/u;
type AgentCapabilitySnapshot = {
  id: string;
  available: boolean;
  mapDesign: { nativeMapTools: boolean; publicReasoningSummary: boolean; reason?: string };
};

test.describe.configure({ mode: 'serial', timeout: T.xlong });

test('[P0] keeps ACP and BYOK Agents visible but blocks unsupported map work before spawn', async ({ page, toolsDev }) => {
  const agentsResponse = await fetch(`${toolsDev.daemonUrl}/api/agents`);
  if (!agentsResponse.ok) throw new Error(`Agent catalogue request failed: ${await agentsResponse.text()}`);
  const { agents } = await agentsResponse.json() as { agents: AgentCapabilitySnapshot[] };
  expect(agents.find((agent) => agent.id === 'codex')?.mapDesign).toMatchObject({
    nativeMapTools: true,
    publicReasoningSummary: true,
  });
  for (const id of ['kimi', 'byok-opencode']) {
    expect(agents.find((agent) => agent.id === id)).toMatchObject({
      available: true,
      mapDesign: { nativeMapTools: false, reason: 'native-tools-unavailable' },
    });
  }
  const blockedMutations: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && (path === '/api/runs' || path === '/api/map-design/projects')) {
      blockedMutations.push(path);
    }
  });
  const spawnCountBefore = await unsupportedSpawnCount(toolsDev.fakeMapAcp.capturePath);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Project name').fill('Unsupported runtime map');
  await page.getByLabel('Public map URL').fill(SOURCE_URL);
  await page.getByLabel('Design requirement').fill('Keep labels legible.');
  const agentSelect = page.getByRole('combobox', { name: 'Local agent', exact: true });
  await agentSelect.click();
  for (const name of ['Kimi CLI — Map editing unavailable', 'BYOK OpenCode — Map editing unavailable']) {
    const option = page.getByRole('option', { name, exact: true });
    await expect(option).toBeVisible();
    await expect(option).toBeEnabled();
  }
  await page.keyboard.press('Escape');

  for (const name of ['Kimi CLI — Map editing unavailable', 'BYOK OpenCode — Map editing unavailable']) {
    await agentSelect.click();
    await page.getByRole('option', { name, exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Map editing unavailable' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create map design', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Check source', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Source and brief', exact: true }).getByRole('alert'))
      .toHaveText('Map editing unavailable');
  }

  expect(blockedMutations).toEqual([]);
  expect(await unsupportedSpawnCount(toolsDev.fakeMapAcp.capturePath)).toBe(spawnCountBefore);
});

test('[P1] Home creates a local map project through the daemon without retired API traffic', async ({ page, toolsDev }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const requests = recordRetainedApiRequests(page);
  const directSourceRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url() === SOURCE_URL) directSourceRequests.push(request.url());
  });
  await selectFakeLocalAgent(toolsDev.daemonUrl!);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'MapDesign workbench' })).toBeVisible();
  await page.getByLabel('Project name').fill('Transit service map');
  await page.getByLabel('Public map URL').fill(SOURCE_URL);
  await page.getByLabel('Design requirement').fill('Show the transit network with legible station labels.');
  await page.getByRole('combobox', { name: 'Local agent', exact: true }).click();
  await page.getByRole('option', { name: /^Codex CLI(?: — .+)?$/u }).click();
  await page.getByRole('button', { name: 'Check source' }).click();
  const preflight = page.getByRole('region', { name: 'Preview' });
  await expect(preflight.locator('canvas.maplibregl-canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create map design' })).toBeEnabled();
  expect(directSourceRequests).toEqual([]);
  await page.getByRole('button', { name: 'Create map design' }).click();

  await expect(page).toHaveURL(/\/projects\/[^/]+$/u);
  await expect(page.getByRole('region', { name: 'Map design agent chat' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Map canvas' })).toBeVisible();
  expectNoRetiredApiRequests(requests);
});

test('[P2] Home keyboard order reaches creation after shell navigation', async ({ page, toolsDev }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const requests = recordRetainedApiRequests(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  const previewId = 'keyboard-preview';
  await page.route('**/api/map-design/source-preflight', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({ json: {
      kind: 'style', requestedHost: 'demotiles.maplibre.org', finalHost: 'demotiles.maplibre.org',
      redirectCount: 0, reachability: 'reachable',
      security: { scheme: 'https', allResolvedAddressesPublic: true, credentialsPresent: false },
      mediaType: 'application/json', byteLength: 1,
      preview: {
        previewId,
        styleUrl: `/api/map-design/source-previews/${previewId}/style`,
        expiresAt: '2026-09-04T03:10:00.000Z',
      },
    } });
  });
  await page.route(`**/api/map-design/source-previews/${previewId}/style`, async (route) => {
    await route.fulfill({ json: {
      version: 8,
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f4f3ee' } }],
    } });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'MapDesign workbench' })).toBeVisible();

  const mapDesignHome = page.getByRole('button', { name: 'MapDesign home', exact: true });
  await mapDesignHome.focus();
  await expect(mapDesignHome).toBeFocused();
  const focusOrder = [
    page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'Home', exact: true }),
    page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'Map projects', exact: true }),
    page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'Design specifications', exact: true }),
    page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'Settings', exact: true }),
    page.getByLabel('Project name', { exact: true }),
    page.getByLabel('Public map URL', { exact: true }),
    page.getByLabel('Design requirement', { exact: true }),
    page.getByRole('combobox', { name: 'Map design system', exact: true }),
    page.getByRole('region', { name: 'Source and brief', exact: true }).getByRole('button', { name: 'Design specifications', exact: true }),
    page.getByRole('combobox', { name: 'Local agent', exact: true }),
    page.getByRole('button', { name: 'Check source', exact: true }),
  ];
  for (const control of focusOrder) {
    await page.keyboard.press('Tab');
    await expect(control).toBeFocused();
  }

  await page.getByLabel('Project name').fill('Keyboard transit map');
  await page.getByLabel('Public map URL').fill(SOURCE_URL);
  await page.getByLabel('Design requirement').fill('Keep labels legible.');
  await page.getByRole('combobox', { name: 'Local agent', exact: true }).click();
  await page.getByRole('option', { name: /^Codex CLI(?: — .+)?$/u }).click();
  await page.getByRole('button', { name: 'Check source' }).click();
  await expect(page.getByRole('button', { name: 'Create map design' })).toBeEnabled();
  await page.getByRole('button', { name: 'Check source' }).focus();
  await page.keyboard.press('Tab');
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent?.trim() ?? null))
    .toBe('Create map design');
  expectNoRetiredApiRequests(requests);
});

function recordRetainedApiRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(page.url()).origin && url.pathname.startsWith('/api/')) {
      requests.push(url.pathname);
    }
  });
  return requests;
}

function expectNoRetiredApiRequests(requests: readonly string[]): void {
  expect(requests.filter((path) => !RETAINED_API_PATH.test(path))).toEqual([]);
}

async function selectFakeLocalAgent(daemonUrl: string): Promise<void> {
  const response = await fetch(`${daemonUrl}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: 'codex' }),
  });
  expect(response.ok, await response.text()).toBe(true);
}

async function unsupportedSpawnCount(capturePath: string): Promise<number> {
  const capture = await readFile(capturePath, 'utf8');
  return capture.split('\n').filter(Boolean).filter((line) => (
    (JSON.parse(line) as { type?: string }).type === 'unsupported-run-spawn'
  )).length;
}
