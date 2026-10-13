import { routeMapSourceFixtures } from '../lib/playwright/map-source-fixtures.ts';
import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';

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

test.describe.configure({ mode: 'default', timeout: T.xlong });
test.beforeEach(async ({ page }, testInfo) => {
  if (!testInfo.title.includes('[external]')) await routeMapSourceFixtures(page);
});

test('[P1] WebGL2 unavailable keeps the preview error local and project controls usable', async ({ page, toolsDev }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: Parameters<typeof getContext>) {
      if (args[0] === 'webgl2') return null;
      return getContext.apply(this, args);
    } as typeof getContext;
  });
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Project name').fill('Map without WebGL2');
  await page.getByLabel('Public map URL').fill(SOURCE_URL);
  await page.getByLabel('Design requirement').fill('Keep labels legible.');
  await expect(page.getByRole('alert').filter({ hasText: 'Map preview requires WebGL2' })).toBeVisible();
  await page.getByRole('button', { name: 'Reload preview' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Map preview requires WebGL2' })).toBeVisible();
  await page.getByLabel('Project name').fill('Still editable');
  await page.getByRole('combobox', { name: 'Local agent', exact: true }).click();
  await page.getByRole('option', { name: /^Codex CLI(?: — .+)?$/u }).click();
  await expect(page.getByRole('button', { name: 'Create map design', exact: true })).toBeEnabled();
  expect(errors.filter(message => /GPUInitializationError|WebGL2 is required|Uncaught/u.test(message))).toEqual([]);
});

test('[P0] hides unavailable and unsupported Agents before spawn', async ({ page, toolsDev }) => {
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
  for (const agent of agents.filter(agent => !agent.available || !agent.mapDesign.nativeMapTools)) {
    await expect(page.locator(`[role="option"][data-value="${agent.id}"]`)).toHaveCount(0);
  }
  await expect(page.locator('[role="option"][data-value="codex"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Create map design', exact: true })).toBeDisabled();

  expect(blockedMutations).toEqual([]);
  expect(await unsupportedSpawnCount(toolsDev.fakeMapAcp.capturePath)).toBe(spawnCountBefore);
});

test('[P1] [external] Home creates a local map project through the daemon without retired API traffic', async ({ page, toolsDev }) => {
  test.skip(process.env.MAP_DESIGN_EXTERNAL_SMOKE !== '1', 'External network acceptance is opt-in.');
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
  const preflight = page.getByRole('region', { name: 'Preview' });
  await expect(preflight.locator('canvas.maplibregl-canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create map design' })).toBeEnabled();
  await expect.poll(() => directSourceRequests.length).toBeGreaterThan(0);
  expect(requests).not.toContain('/api/map-design/source-preflight');
  await page.getByRole('button', { name: 'Create map design' }).click();

  await expectImportedWorkspace(page, toolsDev.daemonUrl!);
  expectNoRetiredApiRequests(requests);
});

test('[P2] Home keyboard order reaches creation after shell navigation', async ({ page, toolsDev }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const requests = recordRetainedApiRequests(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  await page.route(SOURCE_URL, async (route) => {
    await route.fulfill({ json: {
      version: 8, sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f4f3ee' } }],
    } });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'MapDesign workbench' })).toBeVisible();

  const mapDesignHome = page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'Home', exact: true });
  await mapDesignHome.focus();
  await expect(mapDesignHome).toBeFocused();
  const focusOrder = [
    page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'Map projects', exact: true }),
    page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'Design specifications', exact: true }),
    page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'Settings', exact: true }),
    page.getByLabel('Project name', { exact: true }),
    page.getByLabel('Public map URL', { exact: true }),
    page.getByRole('button', { name: 'Use default map', exact: true }),
    page.getByLabel('Design requirement', { exact: true }),
    page.getByRole('combobox', { name: 'Map design system', exact: true }),
    page.getByRole('region', { name: 'Source and brief', exact: true }).getByRole('button', { name: 'Design specifications', exact: true }),
    page.getByRole('combobox', { name: 'Local agent', exact: true }),
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
  await expect(page.getByRole('button', { name: 'Create map design' })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Local agent', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('combobox', { name: 'Models', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Create map design', exact: true })).toBeFocused();
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


test('[P1] Home previews an entered Style URL without an agent or daemon preflight', async ({ page }) => {
  const terrainUrl = 'https://demotiles.maplibre.org/styles/osm-bright-gl-terrain/style.json';
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.route(terrainUrl, async (route) => route.fulfill({ json: {
    version: 8, sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#dde8d6' } }],
  } }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Public map URL').fill(terrainUrl);
  const preview = page.getByRole('region', { name: 'Preview', exact: true });
  await expect(preview.locator('[data-preview-ready="true"]')).toBeVisible();
  await expect(preview.locator('canvas.maplibregl-canvas')).toBeVisible();
  await expect(page.getByLabel('Project name')).toHaveValue('');
  await expect(page.getByLabel('Design requirement')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Check source', exact: true })).toHaveCount(0);
  expect(requests).toContain(terrainUrl);
  expect(requests.some((url) => url.includes('/source-preflight') || url.includes('/source-previews/'))).toBe(false);
  // An external request failure is a preview problem, not a creation gate.
  await page.route('https://maps.example.com/unavailable.json', (route) => route.abort('failed'));
  await page.getByLabel('Public map URL').fill('https://maps.example.com/unavailable.json');
  await expect(preview.getByRole('alert')).toContainText('You can still create the project.');
  await page.getByLabel('Project name').fill('Preview failure does not block import');
  await page.getByLabel('Design requirement').fill('Keep the original style.');
  await page.getByRole('combobox', { name: 'Local agent', exact: true }).click();
  await page.getByRole('option', { name: /^Codex CLI(?: — .+)?$/u }).click();
  await expect(page.getByRole('button', { name: 'Create map design', exact: true })).toBeEnabled();
});


/** Assert the persisted import result, not just navigation or a preview canvas. */
async function expectImportedWorkspace(page: Page, daemonUrl: string): Promise<string> {
  await expect(page).toHaveURL(/\/projects\/[^/]+$/u);
  const projectId = new URL(page.url()).pathname.split('/').at(-1)!;
  let lastState: unknown;
  await expect.poll(async () => {
    const response = await fetch(`${daemonUrl}/api/map-design/projects/${encodeURIComponent(projectId)}`);
    expect(response.ok, `Project read returned ${response.status}`).toBe(true);
    const { project } = await response.json() as {
      project: { lifecycle: string; failure: { code: string; message: string } | null };
    };
    lastState = { lifecycle: project.lifecycle, failure: project.failure };
    return project.lifecycle;
  }, { timeout: 45_000, message: 'The real daemon import must finish' }).not.toBe('importing');
  expect(lastState, 'The real daemon import must persist ready, with no failure')
    .toEqual({ lifecycle: 'ready', failure: null });
  await expect(page.getByRole('region', { name: 'Map design agent chat' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Map canvas' })).toBeVisible();
  return projectId;
}

test('[P1] [external] Home imports the real terrain Style and reopens the persisted workspace', async ({ page, toolsDev }, testInfo) => {
  test.skip(process.env.MAP_DESIGN_EXTERNAL_SMOKE !== '1', 'External network acceptance is opt-in.');
  const sourceUrl = 'https://demotiles.maplibre.org/styles/osm-bright-gl-terrain/style.json';
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const requests = recordRetainedApiRequests(page);
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (path.includes('/resources/') && !response.ok()) console.log('resource-response', response.status(), path);
  });
  // Only the agent is simulated by the shared fixture. Source fetches, imports,
  // SQLite persistence, gateway requests and MapLibre rendering remain real.
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Public map URL').fill(sourceUrl);
  await page.getByLabel('Project name').fill('Terrain import regression');
  await page.getByLabel('Design requirement').fill('Keep the terrain and map sources; use legible labels.');
  await page.getByRole('combobox', { name: 'Local agent', exact: true }).click();
  await page.getByRole('option', { name: /^Codex CLI(?: — .+)?$/u }).click();
  const tileResponse = page.waitForResponse((response) => {
    const path = new URL(response.url()).pathname;
    return new URL(response.url()).hostname === 'demotiles.maplibre.org' && path.startsWith('/tiles-omt/') && path.endsWith('.pbf') && response.ok();
  }, { timeout: 45_000 });
  // Attach a rejection handler immediately, even if creation itself fails.
  void tileResponse.catch(() => undefined);
  await page.getByRole('button', { name: 'Create map design', exact: true }).click();
  const projectId = await expectImportedWorkspace(page, toolsDev.daemonUrl!);
  expect((await tileResponse).ok()).toBe(true);
  const styleResponse = await fetch(`${toolsDev.daemonUrl}/api/map-design/projects/${projectId}/style`);
  expect(styleResponse.ok).toBe(true);
  const style = await styleResponse.json() as { version: number; sources: Record<string, { type: string }>; layers: unknown[] };
  expect(style.version).toBe(8);
  expect(JSON.stringify(style.sources)).toContain('https://demotiles.maplibre.org/');
  expect(JSON.stringify(style.sources)).not.toContain('/api/map-design/projects/');
  expect(style.layers.length).toBeGreaterThan(100);
  expect(style.sources).toMatchObject({
    openmaptiles: { type: 'vector' },
    TerrainSource: { type: 'raster-dem' },
    HillshadeSource: { type: 'raster-dem' },
  });
  const reloadStartedAt = Date.now();
  const reloadedTile = page.waitForResponse((response) => {
    const path = new URL(response.url()).pathname;
    return response.request().timing().startTime >= reloadStartedAt
      && new URL(response.url()).hostname === 'demotiles.maplibre.org' && path.startsWith('/tiles-omt/') && path.endsWith('.pbf') && response.ok();
  }, { timeout: 45_000 });
  void reloadedTile.catch(() => undefined);
  await page.reload({ waitUntil: 'domcontentloaded' });
  expect(await expectImportedWorkspace(page, toolsDev.daemonUrl!)).toBe(projectId);
  expect((await reloadedTile).ok()).toBe(true);
  await expect(page.getByRole('region', { name: 'Map canvas' }).locator('canvas.maplibregl-canvas')).toBeVisible();
  const canvas = page.getByRole('region', { name: 'Map canvas' }).locator('canvas.maplibregl-canvas');
  // A DOM canvas alone also exists after a failed render. Check real pixels.
  await expect.poll(async () => {
    const image = PNG.sync.read(await canvas.screenshot());
    const colors = new Set<number>();
    for (let i = 0; i < image.data.length; i += 64) {
      colors.add((image.data[i]! << 16) | (image.data[i + 1]! << 8) | image.data[i + 2]!);
    }
    return colors.size;
  }, { timeout: 30_000, intervals: [500, 1_000], message: 'The reopened map must render data, not an empty canvas' })
    .toBeGreaterThan(32);
  await expect(page.getByText('Could not load map studio.', { exact: true })).toHaveCount(0, { timeout: 30_000 });
  await testInfo.attach('terrain-import-workspace', { body: await page.screenshot(), contentType: 'image/png' });
  expect(requests).not.toContain('/api/map-design/source-preflight');
  expectNoRetiredApiRequests(requests);
});
