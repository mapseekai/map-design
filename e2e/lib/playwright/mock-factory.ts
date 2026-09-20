import type { Page, Route } from '@playwright/test';

export const STORAGE_KEY = 'map-design:config';

const STANDARD_CONFIG = {
  mode: 'daemon',
  apiKey: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'default',
  agentId: 'codex',
  skillId: 'map-design',
  designSystemId: 'quiet-walking',
  onboardingCompleted: true,
  agentModels: {},
  privacyDecisionAt: 1,
  telemetry: { metrics: false, content: false, artifactManifest: false },
};

const DEFAULT_MODEL = {
  id: 'default',
  label: 'Default (CLI config)',
  enabled: true,
  default: true,
  reasoningOptions: [],
  serviceTierOptions: [],
} as const;

type StandardAgent = {
  id: string;
  label: string;
  available: boolean;
  version: string;
  mapDesign: {
    nativeMapTools: boolean;
    publicReasoningSummary: boolean;
    reason?: 'map-tools-policy-unsupported';
  };
  models: Array<typeof DEFAULT_MODEL>;
  modelCatalogSource: 'fallback' | 'live';
};

const STANDARD_NATIVE_AGENTS: StandardAgent[] = ([
  ['codex', 'Codex', true],
  ['oh-my-pi', 'Oh My Pi', true],
  ['pi', 'Pi', false],
  ['opencode', 'OpenCode', false],
  ['deepseek-harness', 'DeepSeek Harness', true],
] as const).map(([id, label, publicReasoningSummary]) => ({
  id,
  label,
  available: true,
  version: '1.0.0-e2e',
  mapDesign: { nativeMapTools: true, publicReasoningSummary },
  models: [{ ...DEFAULT_MODEL }],
  modelCatalogSource: 'live' as const,
}));

export const STANDARD_AGENTS: readonly StandardAgent[] = [...STANDARD_NATIVE_AGENTS, {
  id: 'claude',
  label: 'Claude Code',
  available: true,
  version: '1.0.0-e2e',
  mapDesign: {
    nativeMapTools: false,
    publicReasoningSummary: true,
    reason: 'map-tools-policy-unsupported',
  },
  models: [{ ...DEFAULT_MODEL }],
  modelCatalogSource: 'fallback',
}];

export async function applyStandardMocks(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, value }: { key: string; value: string }) => window.localStorage.setItem(key, value),
    { key: STORAGE_KEY, value: JSON.stringify(STANDARD_CONFIG) },
  );
  await routeAgents(page);
  await routeAppConfig(page);
  await routeUnavailableVelaStatus(page);
  await suppressWhatsNew(page);
}

async function routeAppConfig(page: Page): Promise<void> {
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() !== 'GET') return await route.fallback();
    await route.fulfill({ json: { config: STANDARD_CONFIG } });
  });
}

async function routeAgents(page: Page): Promise<void> {
  await page.route('**/api/agents**', async (route) => {
    if (route.request().method() !== 'GET') return await route.fallback();
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/agents') return await route.fallback();
    if (url.searchParams.get('stream') !== '1') {
      await route.fulfill({ json: { agents: STANDARD_AGENTS } });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream; charset=utf-8',
      body: `${STANDARD_AGENTS.map((agent) => `event: agent\ndata: ${JSON.stringify(agent)}\n\n`).join('')}event: done\ndata: {}\n\n`,
    });
  });
}

async function routeUnavailableVelaStatus(page: Page): Promise<void> {
  await page.route('**/api/integrations/vela/status*', async (route) => {
    if (route.request().method() !== 'GET') return await route.fallback();
    await route.fulfill({ status: 503, json: { error: 'unavailable in MapDesign e2e' } });
  });
}

async function suppressWhatsNew(page: Page): Promise<void> {
  await page.route('**/api/whats-new', async (route) => {
    if (route.request().method() !== 'GET') return await route.fallback();
    await route.fulfill({ json: { version: 'e2e', id: null, content: null } });
  });
}

export async function fulfillAgentsRoute(route: Route, agents: readonly unknown[]): Promise<void> {
  if (route.request().method() !== 'GET') return await route.fallback();
  const url = new URL(route.request().url());
  if (url.pathname !== '/api/agents') return await route.fallback();
  if (url.searchParams.get('stream') !== '1') {
    await route.fulfill({ json: { agents } });
    return;
  }
  const events = agents.map((agent) => `event: agent\ndata: ${JSON.stringify(agent)}\n\n`).join('');
  await route.fulfill({
    status: 200,
    contentType: 'text/event-stream; charset=utf-8',
    body: `${events}event: done\ndata: {}\n\n`,
  });
}
