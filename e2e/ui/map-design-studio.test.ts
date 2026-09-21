import { readFile, writeFile } from 'node:fs/promises';

import { expect, test } from '@/playwright/suite';
import { createAndOpenReadyMapProject, waitForRenderedMap } from '@/playwright/map-design-project';
import { resetPlaywrightMapDesignConversations } from '@/playwright/reset-development-conversations';
import { T } from '@/timeouts';
import type { Page, Request as PlaywrightRequest, Response as PlaywrightResponse } from '@playwright/test';

const RETAINED_API_PATH = /^\/api\/(?:agents|config|runs(?:\/.*)?|map-design(?:\/.*)?)$/u;
const COMMIT_RESPONSE_FIELDS = ['attestationDigest', 'committedAt', 'draftRevision', 'revision', 'styleHash'];
const LITERAL_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtYXAtZGVzaWduIn0.c2lnbmF0dXJlMTIzNDU2';
const PRIVATE_REASONING = 'PRIVATE_REASONING_MUST_NOT_RENDER';
const PRIVATE_PATH = '/private/tmp/map-design-secret.json';
const PRIVATE_SOURCE_URL = 'https://private.example.test/complete-style.json';
const COMPLETE_STYLE_SENTINEL = 'COMPLETE_STYLE_MUST_NOT_RENDER';
const RAW_PROVIDER_ERROR = 'RAW_PROVIDER_ERROR_MUST_NOT_RENDER';
const REVISION_PAINTS = {
  1: { background: '#F8F4F0', fill: '#DFDBD7', line: '#FFCC88', symbol: '#171717' },
  2: { background: '#0D1117', fill: '#171D24', line: '#59616A', symbol: '#E1DFDB' },
} as const;
const REVISION_TWO_MARKER_LAYER_ID = 'revision-two-marker';
const EXPECTED_MAP_TOOL_NAMES = [
  'map_get_context',
  'map_inspect',
  'map_search_layers',
  'map_apply_transaction',
  'map_update_semantics',
  'map_validate',
  'map_render_preview',
  'map_commit_revision',
  'map_discard_draft',
] as const;
type MapRunStatus = 'queued' | 'running' | 'awaiting_input' | 'succeeded' | 'failed' | 'canceled';
type FakeAgentId = 'codex' | 'oh-my-pi' | 'pi' | 'opencode' | 'deepseek-harness';
type PersistedMapAgentEvent = {
  id?: string;
  kind: string;
  label?: string;
  name?: string;
  status?: string;
  summary?: Record<string, unknown>;
  text?: string;
  toolUseId?: string;
};
const RUNNING_ACTIVITY_SIGNATURE = [
  { kind: 'status', label: 'analyzing' },
  { kind: 'thinking', text: 'Road hierarchy needs more contrast.' },
  { kind: 'tool_use', id: 'context-call', name: 'map_get_context' },
  { kind: 'tool_result', toolUseId: 'context-call', status: 'succeeded' },
  { kind: 'tool_use', id: 'semantics-call', name: 'map_update_semantics' },
  { kind: 'tool_result', toolUseId: 'semantics-call', status: 'succeeded' },
  { kind: 'tool_use', id: 'apply-call', name: 'map_apply_transaction' },
  { kind: 'tool_result', toolUseId: 'apply-call', status: 'succeeded' },
] as const;
const COMPLETED_ACTIVITY_SIGNATURE = [
  ...RUNNING_ACTIVITY_SIGNATURE,
  { kind: 'text', text: 'Road hierarchy updated.' },
  { kind: 'run_finished', status: 'succeeded' },
] as const;

test.describe.configure({ mode: 'serial', timeout: T.xlong });

test('[P0] switches Codex to OpenCode and back with isolated sessions, provenance, and read-only controls', async ({ page, toolsDev }) => {
  const consoleErrors = recordConsoleErrors(page);
  const networkErrors = recordNetworkErrors(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!, 'codex');
  const projectId = await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!, {
    agentId: 'codex',
    projectPrefix: 'runtime-switch',
    title: 'Runtime switching acceptance map',
  });
  const conversationId = selectedConversationId(page);
  const captureOffset = (await readFakeCapture(toolsDev.fakeMapAcp.capturePath)).length;
  const runtimeChip = page.getByRole('button', { name: /Change runtime/u });
  await expect(runtimeChip).toContainText('Codex');

  const firstPrompt = 'Create the Codex cross-Agent committed map revision.';
  await sendMapPrompt(page, firstPrompt);
  await waitForAssistantTurnStatus(toolsDev.daemonUrl!, projectId, conversationId, 0, 'succeeded');
  await expect(page.getByRole('article', { name: 'Assistant message' }).nth(0)).toContainText(/Codex/u);

  await switchConversationRuntime(page, 'OpenCode');
  await expect.poll(async () => (
    await getConversationRuntime(toolsDev.daemonUrl!, projectId, conversationId)
  ).agentId).toBe('opencode');
  await expect(runtimeChip).toContainText('OpenCode');

  const secondPrompt = 'Create the OpenCode cross-Agent committed map revision.';
  await sendMapPrompt(page, secondPrompt);
  await waitForAssistantTurnStatus(toolsDev.daemonUrl!, projectId, conversationId, 1, 'succeeded');
  await expect(page.getByRole('article', { name: 'Assistant message' }).nth(1)).toContainText(/OpenCode/u);

  const afterOpenCode = (await readFakeCapture(toolsDev.fakeMapAcp.capturePath)).slice(captureOffset);
  const openCodeSession = afterOpenCode.find((event) => event.type === 'fake-session' && event.agentId === 'opencode');
  expect(openCodeSession).toMatchObject({
    agentId: 'opencode',
    conversationId,
    resumed: false,
    sessionId: expect.stringMatching(/^opencode-session-/u),
  });
  expect(openCodeSession?.visibleTranscript).toBe([
    `user: ${firstPrompt}`,
    'assistant: Deterministic revision committed.',
    `user: ${secondPrompt}`,
  ].join('\n'));

  await switchConversationRuntime(page, 'Codex');
  await expect.poll(async () => (
    await getConversationRuntime(toolsDev.daemonUrl!, projectId, conversationId)
  ).agentId).toBe('codex');
  const thirdPrompt = 'Create the resumed Codex cross-Agent committed map revision.';
  await sendMapPrompt(page, thirdPrompt);
  await waitForAssistantTurnStatus(toolsDev.daemonUrl!, projectId, conversationId, 2, 'succeeded');

  const capture = (await readFakeCapture(toolsDev.fakeMapAcp.capturePath)).slice(captureOffset);
  const codexSessions = capture.filter((event) => event.type === 'fake-session' && event.agentId === 'codex');
  expect(codexSessions).toHaveLength(2);
  expect(codexSessions[0]).toMatchObject({ resumed: false, sessionId: expect.stringMatching(/^codex-session-/u) });
  expect(codexSessions[1]).toMatchObject({ resumed: true, sessionId: codexSessions[0]?.sessionId });
  expect(codexSessions[1]?.prompt).toBe(thirdPrompt);

  const conversation = await getConversation(toolsDev.daemonUrl!, projectId, conversationId);
  expect(conversation.messages.filter((message) => message.role === 'assistant').map((message) => message.runtime))
    .toEqual([
      expect.objectContaining({ agentId: 'codex', adapter: 'codex-app-server' }),
      expect.objectContaining({ agentId: 'opencode', adapter: 'opencode-plugin' }),
      expect.objectContaining({ agentId: 'codex', adapter: 'codex-app-server' }),
    ]);
  expect(capture.find((event) => event.type === 'opencode-plugin-loaded')).toMatchObject({
    adapterPath: 'opencode-plugin-export',
    agentId: 'opencode',
    tools: EXPECTED_MAP_TOOL_NAMES,
  });
  for (const agentId of ['codex', 'opencode']) {
    const toolEvents = capture.filter((event) => event.type === 'fake-tool-call' && event.agentId === agentId);
    const tools = toolEvents
      .map((event) => event.tool);
    expect(tools).toEqual(expect.arrayContaining([
      'map_get_context',
      'map_apply_transaction',
      'map_validate',
      'map_render_preview',
      'map_commit_revision',
    ]));
    expect(tools.filter((tool) => tool === 'map_render_preview')).toHaveLength(agentId === 'codex' ? 2 : 1);
    expect(tools.filter((tool) => tool === 'map_commit_revision')).toHaveLength(agentId === 'codex' ? 2 : 1);
    if (agentId === 'opencode') {
      expect(toolEvents.every((event) => event.adapterPath === 'opencode-plugin-export')).toBe(true);
    }
  }

  await switchConversationRuntime(page, 'OpenCode');
  await expect.poll(async () => (
    await getConversationRuntime(toolsDev.daemonUrl!, projectId, conversationId)
  ).agentId).toBe('opencode');
  const chat = page.getByRole('region', { name: 'Map design agent chat' });
  await chat.getByRole('button', { name: 'New conversation', exact: true }).last().click();
  let newConversationId = '';
  await expect.poll(() => {
    const current = selectedConversationId(page);
    if (current !== conversationId) newConversationId = current;
    return newConversationId;
  }).not.toBe('');
  expect(await getConversationRuntime(toolsDev.daemonUrl!, projectId, newConversationId)).toMatchObject({
    agentId: 'codex',
    revision: 0,
  });
  await expect(runtimeChip).toContainText('Codex');

  await runtimeChip.click();
  const runtimeDialog = page.getByRole('dialog', { name: 'Runtime settings', exact: true });
  const claude = runtimeDialog.getByRole('option', { name: /Claude Code/u });
  await expect(claude).toBeVisible();
  await expect(claude).toBeDisabled();
  await expect(claude).toContainText('Claude Code policy does not allow MapDesign MCP tools.');
  await runtimeDialog.getByRole('button', { name: 'Close', exact: true }).click();

  await openRevisionInspector(page);
  await page.getByRole('button', { name: 'View revision 1', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Viewing revision 1 · Read only' })).toBeVisible();
  await expect(runtimeChip).toBeVisible();
  await expect(runtimeChip).toBeDisabled();

  expect(capture.filter((event) => event.type === 'map-mcp-server' || event.type === 'map-cli-invocation')).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(networkErrors).toEqual([]);
});

for (const [agentId, adapter, sessionId] of [
  ['oh-my-pi', 'omp-rpc', /^omp-session-/u],
  ['pi', 'pi-sdk', /^pi-session-/u],
  ['deepseek-harness', 'deepseek-profile', /^deepseek-session-/u],
] as const) {
  test(`[P0] ${agentId} invokes the complete native map workflow through ${adapter}`, async ({ page, toolsDev }) => {
    const consoleErrors = recordConsoleErrors(page);
    const networkErrors = recordNetworkErrors(page);
    await selectFakeLocalAgent(toolsDev.daemonUrl!, agentId);
    const projectId = await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!, {
      agentId,
      projectPrefix: `adapter-${agentId}`,
      title: `${agentId} adapter acceptance map`,
    });
    const conversationId = selectedConversationId(page);
    const captureOffset = (await readFakeCapture(toolsDev.fakeMapAcp.capturePath)).length;

    await sendMapPrompt(page, `Create the ${agentId} cross-Agent committed map revision.`);
    await waitForAssistantStatus(toolsDev.daemonUrl!, projectId, conversationId, 'succeeded');

    const capture = (await readFakeCapture(toolsDev.fakeMapAcp.capturePath)).slice(captureOffset);
    const tools = capture.filter((event) => event.type === 'fake-tool-call' && event.agentId === agentId)
      .map((event) => event.tool);
    expect(tools).toEqual(expect.arrayContaining([
      'map_get_context',
      'map_apply_transaction',
      'map_validate',
      'map_render_preview',
      'map_commit_revision',
    ]));
    expect(tools.filter((tool) => tool === 'map_render_preview')).toHaveLength(1);
    expect(tools.filter((tool) => tool === 'map_commit_revision')).toHaveLength(1);
    expect(capture.find((event) => event.type === 'fake-session' && event.agentId === agentId)).toMatchObject({
      resumed: false,
      sessionId: expect.stringMatching(sessionId),
    });
    const conversation = await getConversation(toolsDev.daemonUrl!, projectId, conversationId);
    const assistant = conversation.messages.find((message) => message.role === 'assistant');
    expect(assistant?.runtime)
      .toMatchObject({ agentId, adapter });
    if (agentId === 'pi') {
      expect(assistant?.events.some((event) => event.kind === 'thinking')).toBe(false);
      expect(JSON.stringify(assistant?.events)).not.toContain('PRIVATE_PI_REASONING_MUST_NOT_RENDER');
      await expect(page.getByRole('button', { name: 'Reasoning summary', exact: true })).toHaveCount(0);
      await expect(page.getByText('PRIVATE_PI_REASONING_MUST_NOT_RENDER', { exact: true })).toHaveCount(0);
    }
    expect(capture.filter((event) => event.type === 'map-mcp-server' || event.type === 'map-cli-invocation')).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(networkErrors).toEqual([]);
  });
}

test('[P0] persists completed public activity across reload and conversation switches', async ({ page, toolsDev }) => {
  const consoleErrors = recordConsoleErrors(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!, 'codex');
  const projectId = await createAndOpenReadyMapProjectForAgent(page, toolsDev.daemonUrl!, 'codex');
  const conversationId = selectedConversationId(page);

  const eventRequest = waitForRunEventRequest(page);
  await sendMapPrompt(page, 'Improve road hierarchy');
  await writeFakeRelease(toolsDev.fakeMapAcp.capturePath, 'activity-success-start');
  await expect.poll(async () => {
    const conversation = await getConversation(toolsDev.daemonUrl!, projectId, conversationId);
    const assistant = conversation.messages.find((message) => message.role === 'assistant');
    return eventSignatures(assistant?.events ?? []);
  }).toEqual(RUNNING_ACTIVITY_SIGNATURE);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const working = page.getByTestId('task-activity-toggle').last();
  await expect(working).toHaveAccessibleName(/analyzing.*working/i);
  await expect(working).toHaveAttribute('aria-expanded', 'true');
  const runningActivity = page.getByRole('region', { name: /analyzing/i }).last();
  await expect(runningActivity.getByRole('button', { name: /Read map context.*Completed/i })).toBeVisible();
  await expect(runningActivity.getByRole('button', { name: /Update map semantics.*Completed/i })).toBeVisible();
  await expect(runningActivity.getByRole('button', { name: /Apply map changes.*Completed/i })).toBeVisible();
  const runningReasoning = runningActivity.getByRole('button', { name: 'Reasoning summary', exact: true });
  await runningReasoning.click();
  await expect(runningActivity.getByText('Road hierarchy needs more contrast.', { exact: true })).toBeVisible();
  await expect(page.getByText('Road hierarchy updated.', { exact: true })).toHaveCount(0);
  await writeFakeRelease(toolsDev.fakeMapAcp.capturePath, 'activity-success');
  await waitForAssistantStatus(toolsDev.daemonUrl!, projectId, conversationId, 'succeeded');
  const eventPath = new URL((await eventRequest).url()).pathname;
  const replayResponse = await fetch(`${toolsDev.daemonUrl}${eventPath}`);
  expect(replayResponse.ok).toBe(true);
  const sseText = await replayResponse.text();
  const terminalConversation = await getConversation(toolsDev.daemonUrl!, projectId, conversationId);
  const terminalAssistant = terminalConversation.messages.find((message) => message.role === 'assistant');
  expect(eventSignatures(terminalAssistant?.events ?? [])).toEqual(COMPLETED_ACTIVITY_SIGNATURE);
  const replayEvents = parseSseData(sseText);
  const terminalSnapshot = replayEvents.filter((event) => event.type === 'event_snapshot').at(-1);
  const completedMessage = replayEvents.find((event) => event.type === 'message_completed');
  expect(eventSignatures(eventsFromReplay(terminalSnapshot))).toEqual(COMPLETED_ACTIVITY_SIGNATURE);
  expect(eventSignatures(eventsFromReplay(completedMessage, 'message'))).toEqual(COMPLETED_ACTIVITY_SIGNATURE);
  await page.reload({ waitUntil: 'domcontentloaded' });

  const completed = page.getByTestId('task-activity-toggle').last();
  await expect(completed).toHaveAccessibleName(/analyzing.*completed/i);
  await expect(completed).toHaveAttribute('aria-expanded', 'false');
  const finalAnswer = page.getByText('Road hierarchy updated.', { exact: true });
  await expect(finalAnswer).toBeVisible();
  expect(await finalAnswer.evaluate((answer, toggle) => Boolean(
    answer.compareDocumentPosition(toggle as Node) & Node.DOCUMENT_POSITION_PRECEDING
  ), await completed.elementHandle())).toBe(true);
  await completed.click();
  const completedActivity = page.getByRole('region', { name: /analyzing/i }).last();
  await expect(completedActivity.getByRole('button', { name: /Read map context.*Completed/i })).toBeVisible();
  await expect(completedActivity.getByRole('button', { name: /Apply map changes.*Completed/i })).toBeVisible();
  const fixtureEvents = (await readFakeCapture(toolsDev.fakeMapAcp.capturePath))
    .filter((event) => event.type === 'fixture-event' && event.branch === 'activity-success')
    .slice(-8);
  expect(fixtureEvents.map((event) => event.phase))
    .toEqual([
      'public-summary',
      'tool-start', 'tool-result',
      'tool-start', 'tool-result',
      'tool-start', 'tool-result',
      'final-answer',
    ]);
  expect(fixtureEvents.filter((event) => event.phase === 'tool-start' || event.phase === 'tool-result')
    .map((event) => event.tool)).toEqual([
      'map_get_context', 'map_get_context',
      'map_update_semantics', 'map_update_semantics',
      'map_apply_transaction', 'map_apply_transaction',
    ]);
  const advertisedTools = (await readFakeCapture(toolsDev.fakeMapAcp.capturePath))
    .filter((event) => event.type === 'app-server-thread')
    .at(-1)?.tools;
  expect(advertisedTools).toEqual(EXPECTED_MAP_TOOL_NAMES);
  const conversationJson = JSON.stringify(await getConversation(toolsDev.daemonUrl!, projectId, conversationId));
  for (const secret of [PRIVATE_REASONING, PRIVATE_PATH, LITERAL_JWT, PRIVATE_SOURCE_URL, COMPLETE_STYLE_SENTINEL, RAW_PROVIDER_ERROR]) {
    expect(conversationJson).not.toContain(secret);
    expect(sseText).not.toContain(secret);
    await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
  }

  const chat = page.getByRole('region', { name: 'Map design agent chat' });
  await chat.getByRole('button', { name: 'New conversation', exact: true }).last().click();
  await expect(page.getByRole('button', { name: /completed/i })).toHaveCount(0);
  await page.locator('button[aria-haspopup="listbox"]').click();
  await page.getByRole('option', { name: /Improve road hierarchy/u }).click();
  const switchedCompleted = page.getByTestId('task-activity-toggle').last();
  await expect(switchedCompleted).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Road hierarchy updated.', { exact: true })).toBeVisible();
  await switchedCompleted.click();
  const switchedActivity = page.getByRole('region', { name: /analyzing/i }).last();
  await expect(switchedActivity.getByRole('button', { name: /Apply map changes.*Completed/i })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('[P0] keeps stop beside disabled send and records one canceled activity after rapid activation', async ({ page, toolsDev }) => {
  const consoleErrors = recordConsoleErrors(page);
  const cancelRequests: string[] = [];
  let markStartAccepted = () => {};
  let releaseStartResponse = () => {};
  const startAccepted = new Promise<void>((resolve) => { markStartAccepted = resolve; });
  const startResponseGate = new Promise<void>((resolve) => { releaseStartResponse = resolve; });
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/runs\/[^/]+\/cancel$/u.test(new URL(request.url()).pathname)) {
      cancelRequests.push(request.url());
    }
  });
  await page.route('**/api/runs', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/runs') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    markStartAccepted();
    await startResponseGate;
    await route.fulfill({ response });
  });
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  const projectId = await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!);
  const conversationId = selectedConversationId(page);

  await sendMapPrompt(page, 'Start a long validation');
  await startAccepted;
  const actions = page.getByRole('group', { name: 'Run actions', exact: true });
  const cancel = actions.getByRole('button', { name: 'Cancel run', exact: true });
  const send = actions.getByRole('button', { name: 'Send', exact: true });
  await expect(cancel).toBeVisible();
  await expect(send).toBeDisabled();
  await expectButtonsToBeAdjacent(cancel, send);

  await cancel.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  releaseStartResponse();

  await expect.poll(() => cancelRequests.length).toBe(1);
  await waitForAssistantStatus(toolsDev.daemonUrl!, projectId, conversationId, 'canceled');
  await page.reload({ waitUntil: 'domcontentloaded' });
  expect(cancelRequests).toHaveLength(1);
  const canceled = page.getByRole('button', { name: /canceled/i });
  await expect(canceled).toHaveCount(1);
  await expect(canceled).toHaveAttribute('aria-expanded', 'false');
  expect(consoleErrors).toEqual([]);
});

test('[P0] shows sanitized failed activity without leaking runtime details', async ({ page, toolsDev }) => {
  const consoleErrors = recordConsoleErrors(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  const projectId = await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!);
  const conversationId = selectedConversationId(page);

  const eventRequest = waitForRunEventRequest(page);
  await sendMapPrompt(page, 'Trigger a sanitized failure');
  await waitForAssistantStatus(toolsDev.daemonUrl!, projectId, conversationId, 'failed');
  const eventPath = new URL((await eventRequest).url()).pathname;
  const replayResponse = await fetch(`${toolsDev.daemonUrl}${eventPath}`);
  expect(replayResponse.ok).toBe(true);
  const sseText = await replayResponse.text();
  await page.reload({ waitUntil: 'domcontentloaded' });
  const failed = page.getByRole('button', { name: /failed/i });
  await expect(failed).toHaveAttribute('aria-expanded', 'false');
  await failed.click();

  const failedActivity = page.getByRole('region', { name: /analyzing/i }).last();
  const reasoning = failedActivity.getByRole('button', { name: 'Reasoning summary', exact: true });
  await reasoning.click();
  await expect(failedActivity.getByText('Checking the public validation boundary.', { exact: true })).toBeVisible();
  await expect(failedActivity.getByRole('button', { name: /Validate map.*Failed/i })).toBeVisible();
  await expect(failedActivity.getByRole('alert')).toHaveCount(0);

  const conversationJson = JSON.stringify(await getConversation(toolsDev.daemonUrl!, projectId, conversationId));
  for (const secret of [PRIVATE_REASONING, PRIVATE_PATH, LITERAL_JWT, PRIVATE_SOURCE_URL, COMPLETE_STYLE_SENTINEL, RAW_PROVIDER_ERROR]) {
    expect(conversationJson).not.toContain(secret);
    expect(sseText).not.toContain(secret);
    await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
  }
  await expect(page.getByText(/Bearer|MAP_DESIGN_TOOL_TOKEN|private\/tmp/iu)).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test('[P1] Studio drives the retained local agent tool run, previews, validates, and commits through production routes', async ({ page, toolsDev }) => {
  const requests = recordRetainedApiRequests(page);
  const consoleErrors = recordConsoleErrors(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  const projectId = await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!);

  await expect(page.getByRole('region', { name: 'Map design agent chat' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Map canvas' })).toBeVisible();

  await page.getByLabel('Message map agent').fill('Add the deterministic acceptance metadata.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(async () => (await readFakeCapture(toolsDev.fakeMapAcp.capturePath))
    .some((event) => event.type === 'fixture-complete' && event.branch === 'native-transaction')).toBe(true);
  const nativeToolEvents = (await readFakeCapture(toolsDev.fakeMapAcp.capturePath))
    .filter((event) => event.type === 'fixture-event' && event.branch === 'native-transaction' && event.tool);
  expect(nativeToolEvents.map((event) => `${event.phase}:${event.tool}`)).toEqual([
    'tool-start:map_get_context',
    'tool-result:map_get_context',
    'tool-start:map_update_semantics',
    'tool-result:map_update_semantics',
    'tool-start:map_apply_transaction',
    'tool-result:map_apply_transaction',
    'tool-start:map_validate',
    'tool-result:map_validate',
    'tool-start:map_render_preview',
    'tool-result:map_render_preview',
  ]);

  const preview = await expectCurrentPreview(toolsDev.daemonUrl!, projectId);
  const beforeCommit = await getJson<{ revisions: Array<{ previewId: string | null }> }>(
    toolsDev.daemonUrl!,
    `/api/map-design/projects/${projectId}/revisions`,
  );
  expect(beforeCommit.revisions.some((revision) => revision.previewId === preview.previewId)).toBe(false);

  await page.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect(page.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
  await expect(page.locator('#map-design-chat-surface')).toBeAttached();
  const fullscreenMap = page.getByRole('region', { name: 'Map', exact: true });
  await expect.poll(async () => (await fullscreenMap.boundingBox())?.width ?? 0)
    .toBeGreaterThan((page.viewportSize()?.width ?? 0) * 0.8);
  await page.getByRole('button', { name: 'Exit fullscreen' }).click();
  await expect(page.getByRole('button', { name: 'Enter fullscreen' })).toBeVisible();
  expect(consoleErrors.filter((message) => message.includes('Cannot update a component'))).toEqual([]);

  await page.getByRole('button', { name: 'Open inspector' }).click();
  await page.getByRole('tab', { name: 'Revisions' }).click();
  const commitResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/map-design/projects/${projectId}/revisions/commit-from-preview`
  ));
  await page.getByRole('button', { name: 'Commit revision' }).click();
  const commitResponse = await commitResponsePromise;
  const commit = await readJson(commitResponse);
  expect(Object.keys(commit).sort()).toEqual(COMMIT_RESPONSE_FIELDS);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('region', { name: 'Map design agent chat' })).toBeVisible();
  await page.getByRole('button', { name: 'Open inspector' }).click();
  await page.getByRole('tab', { name: 'Revisions' }).click();
  const afterCommit = await getJson<{ revisions: Array<{ previewId: string | null }> }>(
    toolsDev.daemonUrl!,
    `/api/map-design/projects/${projectId}/revisions`,
  );
  expect(afterCommit.revisions.some((revision) => revision.previewId === preview.previewId)).toBe(true);
  expectNoRetiredApiRequests(requests);
  expect(consoleErrors).toEqual([]);
});

test('[P0] applies a dark background transaction and validates the resulting draft through public routes', async ({ page, toolsDev }) => {
  const consoleErrors = recordConsoleErrors(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  const projectId = await createAndOpenReadyMapProjectForAgent(page, toolsDev.daemonUrl!, 'codex');
  const conversationId = selectedConversationId(page);
  const projectPrefix = `/api/map-design/projects/${projectId}`;
  const seededStyle = await getJson<{
    layers: Array<{ id: string; type: string; paint?: Record<string, unknown> }>;
  }>(toolsDev.daemonUrl!, `${projectPrefix}/style`);
  const seededBackground = seededStyle.layers.find((layer) => layer.id === 'background');
  expect(seededBackground).toMatchObject({ id: 'background', type: 'background' });
  const before = await getJson<{ draftRevision: number }>(toolsDev.daemonUrl!, `${projectPrefix}/context`);
  expect(before.draftRevision).toBe(0);

  await sendMapPrompt(page, 'Apply the deterministic dark theme background.');
  await waitForAssistantStatus(toolsDev.daemonUrl!, projectId, conversationId, 'succeeded');
  const completedConversation = await getConversation(toolsDev.daemonUrl!, projectId, conversationId);
  const completedEvents = completedConversation.messages.find((message) => message.role === 'assistant')?.events ?? [];
  expect(completedEvents.find((event) => event.toolUseId === 'dark-theme-semantics')).toMatchObject({
    kind: 'tool_result',
    status: 'succeeded',
    summary: { revision: 1, validationStatus: 'valid' },
  });
  expect(completedEvents.find((event) => event.toolUseId === 'dark-theme-apply')).toMatchObject({
    kind: 'tool_result',
    status: 'succeeded',
    summary: { revision: 2 },
  });
  expect(completedEvents.find((event) => event.toolUseId === 'dark-theme-validate')).toMatchObject({
    kind: 'tool_result',
    status: 'succeeded',
    summary: { revision: 2, validationStatus: 'valid' },
  });

  const [context, style, validation, conversation] = await Promise.all([
    getJson<{ draftRevision: number }>(toolsDev.daemonUrl!, `${projectPrefix}/context`),
    getJson<{ layers: Array<{ id: string; paint?: Record<string, unknown> }> }>(toolsDev.daemonUrl!, `${projectPrefix}/style`),
    readJson(await fetch(`${toolsDev.daemonUrl}${projectPrefix}/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2 }),
    })) as Promise<{ draftRevision: number; summary: { status: string } }>,
    getConversation(toolsDev.daemonUrl!, projectId, conversationId),
  ]);
  expect(context.draftRevision).toBe(2);
  expect(style.layers.find((layer) => layer.id === 'background')?.paint?.['background-color']).toBe('#111318');
  expect(validation).toMatchObject({ draftRevision: 2, summary: { status: 'valid' } });
  const assistant = conversation.messages.find((message) => message.role === 'assistant');
  expect(eventSignatures(assistant?.events ?? [])).toEqual([
    { kind: 'status', label: 'analyzing' },
    { kind: 'thinking', text: 'Applying a deterministic dark theme background.' },
    { kind: 'tool_use', id: 'dark-theme-semantics', name: 'map_update_semantics' },
    { kind: 'tool_result', toolUseId: 'dark-theme-semantics', status: 'succeeded' },
    { kind: 'tool_use', id: 'dark-theme-apply', name: 'map_apply_transaction' },
    { kind: 'tool_result', toolUseId: 'dark-theme-apply', status: 'succeeded' },
    { kind: 'tool_use', id: 'dark-theme-validate', name: 'map_validate' },
    { kind: 'tool_result', toolUseId: 'dark-theme-validate', status: 'succeeded' },
    { kind: 'text', text: 'Dark theme background applied.' },
    { kind: 'run_finished', status: 'succeeded' },
  ]);
  expect(consoleErrors).toEqual([]);
});

test('[P0] switches and restores committed revisions through historical read-only mode', async ({ page, toolsDev }) => {
  test.slow();
  const consoleErrors = recordConsoleErrors(page);
  const networkErrors = recordNetworkErrors(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  const projectId = await createAndOpenReadyMapProjectForAgent(page, toolsDev.daemonUrl!, 'codex');
  const conversationId = selectedConversationId(page);
  const projectPrefix = `/api/map-design/projects/${projectId}`;

  await sendMapPrompt(page, 'Create and commit deterministic revision one.');
  await waitForAssistantTurnStatus(toolsDev.daemonUrl!, projectId, conversationId, 0, 'succeeded');
  const firstHistory = await waitForRevisionHistory(toolsDev.daemonUrl!, projectPrefix, [0, 1]);
  const firstSnapshot = await getJson<HistoricalSnapshot>(
    toolsDev.daemonUrl!,
    `${projectPrefix}/revisions/1/snapshot`,
  );
  expect(firstSnapshot.revision.revision).toBe(1);
  expect(firstSnapshot.validation.summary.status).toBe('valid');
  expect(representativePaint(firstSnapshot.style)).toEqual(REVISION_PAINTS[1]);
  expectRepresentativeInspect(firstSnapshot.inspect);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForRenderedMap(page.locator('#map-design-map-surface [role="region"][aria-label="Map"]'));
  await expect(page.getByLabel('Message map agent')).toBeEditable();

  await sendMapPrompt(page, 'Create and commit deterministic revision two.');
  await waitForAssistantTurnStatus(toolsDev.daemonUrl!, projectId, conversationId, 1, 'succeeded');
  const committedHistory = await waitForRevisionHistory(toolsDev.daemonUrl!, projectPrefix, [0, 1, 2]);
  const secondSnapshot = await getJson<HistoricalSnapshot>(
    toolsDev.daemonUrl!,
    `${projectPrefix}/revisions/2/snapshot`,
  );
  expect(secondSnapshot.revision.revision).toBe(2);
  expect(secondSnapshot.validation.summary.status).toBe('valid');
  expect(representativePaint(secondSnapshot.style)).toEqual(REVISION_PAINTS[2]);
  expect(representativePaint(secondSnapshot.style)).not.toEqual(representativePaint(firstSnapshot.style));
  expectRepresentativeInspect(secondSnapshot.inspect);
  expect(firstHistory.revisions.map((revision) => revision.revision).sort((left, right) => left - right)).toEqual([0, 1]);

  await openRevisionInspector(page);
  const revisionTwoRow = page.getByRole('listitem').filter({ hasText: /^Revision 2/u });
  await expect(revisionTwoRow.getByText('Current commit', { exact: true })).toBeVisible();
  const firstViewSnapshotResponse = waitForRevisionSnapshotResponse(page, projectPrefix, 1);
  await page.getByRole('button', { name: 'View revision 1', exact: true }).click();
  const browserFirstSnapshot = await readHistoricalSnapshotResponse(await firstViewSnapshotResponse);
  expect(browserFirstSnapshot.revision.revision).toBe(1);
  expect(representativePaint(browserFirstSnapshot.style)).toEqual(REVISION_PAINTS[1]);
  await expect(page).toHaveURL(/(?:\?|&)revision=1(?:&|$)/u);
  await expect(page.getByRole('region', { name: 'Viewing revision 1 · Read only' })).toBeVisible();
  await waitForRenderedMap(page.locator('#map-design-map-surface [role="region"][aria-label="Map"]'));
  await expect(page.locator('[data-status="valid"]')).toBeVisible();
  await page.getByRole('tab', { name: 'Layers', exact: true }).click();
  const firstLayers = page.getByRole('tabpanel', { name: 'Layers' });
  await expect(firstLayers.getByText(`${browserFirstSnapshot.inspect.view.style.layerCount} Layers`, { exact: true })).toBeVisible();
  await expect(firstLayers.getByText(REVISION_TWO_MARKER_LAYER_ID, { exact: true })).toHaveCount(0);

  await page.getByRole('tab', { name: 'Revisions', exact: true }).click();
  const revisionOneRow = page.getByRole('listitem').filter({ hasText: /^Revision 1/u });
  await expect(revisionOneRow.getByText('Viewing', { exact: true })).toBeVisible();
  const secondViewSnapshotResponse = waitForRevisionSnapshotResponse(page, projectPrefix, 2);
  await page.getByRole('button', { name: 'View revision 2', exact: true }).click();
  const browserSecondSnapshot = await readHistoricalSnapshotResponse(await secondViewSnapshotResponse);
  expect(browserSecondSnapshot.revision.revision).toBe(2);
  expect(representativePaint(browserSecondSnapshot.style)).toEqual(REVISION_PAINTS[2]);
  expect(browserSecondSnapshot.inspect.view.style.layerCount)
    .toBe(browserFirstSnapshot.inspect.view.style.layerCount + 1);
  expect(browserSecondSnapshot.inspect.view.layers).toContainEqual(expect.objectContaining({
    id: REVISION_TWO_MARKER_LAYER_ID,
    type: 'circle',
  }));
  await expect(page).toHaveURL(/(?:\?|&)revision=2(?:&|$)/u);
  await expect(page.getByRole('region', { name: 'Viewing revision 2 · Read only' })).toBeVisible();
  await waitForRenderedMap(page.locator('#map-design-map-surface [role="region"][aria-label="Map"]'));
  await page.getByRole('tab', { name: 'Layers', exact: true }).click();
  const secondLayers = page.getByRole('tabpanel', { name: 'Layers' });
  await expect(secondLayers.getByText(`${browserSecondSnapshot.inspect.view.style.layerCount} Layers`, { exact: true })).toBeVisible();
  await expect(secondLayers.getByText(REVISION_TWO_MARKER_LAYER_ID, { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Revisions', exact: true }).click();
  const revisitFirstSnapshotResponse = waitForRevisionSnapshotResponse(page, projectPrefix, 1);
  await page.getByRole('button', { name: 'View revision 1', exact: true }).click();
  const browserRevisitedFirstSnapshot = await readHistoricalSnapshotResponse(await revisitFirstSnapshotResponse);
  expect(browserRevisitedFirstSnapshot.inspect.view.style.layerCount)
    .toBe(browserFirstSnapshot.inspect.view.style.layerCount);
  expect(browserRevisitedFirstSnapshot.inspect.view.layers.some((layer) => layer.id === REVISION_TWO_MARKER_LAYER_ID)).toBe(false);
  await expect(page).toHaveURL(/(?:\?|&)revision=1(?:&|$)/u);
  const reloadedFirstSnapshotResponse = waitForRevisionSnapshotResponse(page, projectPrefix, 1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const browserReloadedFirstSnapshot = await readHistoricalSnapshotResponse(await reloadedFirstSnapshotResponse);
  expect(browserReloadedFirstSnapshot.revision.revision).toBe(1);
  expect(representativePaint(browserReloadedFirstSnapshot.style)).toEqual(REVISION_PAINTS[1]);
  expect(browserReloadedFirstSnapshot.inspect.view.style.layerCount)
    .toBe(browserFirstSnapshot.inspect.view.style.layerCount);
  await expect(page).toHaveURL(/(?:\?|&)revision=1(?:&|$)/u);
  await expect(page.getByRole('region', { name: 'Viewing revision 1 · Read only' })).toBeVisible();
  await waitForRenderedMap(page.locator('#map-design-map-surface [role="region"][aria-label="Map"]'));
  await openRevisionInspector(page);
  await page.getByRole('tab', { name: 'Layers', exact: true }).click();
  const reloadedFirstLayers = page.getByRole('tabpanel', { name: 'Layers' });
  await expect(reloadedFirstLayers.getByText(`${browserReloadedFirstSnapshot.inspect.view.style.layerCount} Layers`, { exact: true })).toBeVisible();
  await expect(reloadedFirstLayers.getByText(REVISION_TWO_MARKER_LAYER_ID, { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Revisions', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: /^Revision 1/u })
    .getByText('Viewing', { exact: true })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: /^Revision 2/u })
    .getByText('Current commit', { exact: true })).toBeVisible();

  const chat = page.getByRole('region', { name: 'Map design agent chat' });
  const composer = chat.getByLabel('Message map agent');
  const send = chat.getByRole('button', { name: 'Send', exact: true });
  const createConversation = chat.getByRole('button', { name: 'New conversation', exact: true });
  const selectConversation = chat.getByRole('button', { name: 'Project conversations' });
  const collapseChat = chat.getByRole('button', { name: 'Collapse chat', exact: true });
  const commit = page.getByRole('button', { name: 'Commit revision', exact: true });
  await expect(composer).toBeDisabled();
  await expect(send).toBeDisabled();
  await expect(createConversation).toBeDisabled();
  await expect(selectConversation).toBeDisabled();
  await expect(collapseChat).toBeDisabled();
  await expect(commit).toBeDisabled();
  await expect(page.getByText('A passed current preview is required.', { exact: true })).toBeVisible();
  const mapCanvas = page.getByRole('region', { name: 'Map canvas' });
  for (const mutation of ['Apply map changes', 'Render preview', 'Discard draft']) {
    await expect(mapCanvas.getByRole('button', { name: mutation, exact: true })).toHaveCount(0);
  }

  await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Return to current version', exact: true }).click();
  await expect(page).not.toHaveURL(/(?:\?|&)revision=/u);
  await expect(composer).toBeEditable();
  const committedContext = await getJson<MapContext>(toolsDev.daemonUrl!, `${projectPrefix}/context`);
  expect(committedContext.committedRevision).toBe(2);
  await sendMapPrompt(page, 'Add the deterministic acceptance metadata.');
  await waitForAssistantTurnStatus(toolsDev.daemonUrl!, projectId, conversationId, 2, 'succeeded');
  const uncommittedContext = await getJson<MapContext>(toolsDev.daemonUrl!, `${projectPrefix}/context`);
  expect(uncommittedContext.draftRevision).toBeGreaterThan(committedContext.draftRevision);
  expect(uncommittedContext.committedRevision).toBe(2);
  const historyBeforeRestore = await getJson<RevisionHistory>(toolsDev.daemonUrl!, `${projectPrefix}/revisions`);
  expect(historyBeforeRestore).toEqual(committedHistory);

  await openRevisionInspector(page);
  const restoreViewSnapshotResponse = waitForRevisionSnapshotResponse(page, projectPrefix, 1);
  await page.getByRole('button', { name: 'View revision 1', exact: true }).click();
  const browserRestoreSnapshot = await readHistoricalSnapshotResponse(await restoreViewSnapshotResponse);
  expect(browserRestoreSnapshot.revision.revision).toBe(1);
  expect(browserRestoreSnapshot.inspect.view.style.layerCount)
    .toBe(browserFirstSnapshot.inspect.view.style.layerCount);
  await expect(page.getByRole('region', { name: 'Viewing revision 1 · Read only' })).toBeVisible();
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Restore as new draft', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(
    `Revision 1 will replace current draft revision ${uncommittedContext.draftRevision}.`,
  );
  await expect(dialog).toContainText('Committed history will stay unchanged.');
  const restoreResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${projectPrefix}/revisions/1/restore`
  ));
  await dialog.getByRole('button', { name: 'Restore as new draft', exact: true }).click();
  const restoreResponse = await restoreResponsePromise;
  const restore = await readJson(restoreResponse) as {
    draftRevision: number;
    restoredRevision: number;
    validationSummary: { status: string };
  };
  expect(restore).toMatchObject({
    draftRevision: uncommittedContext.draftRevision + 1,
    restoredRevision: 1,
    validationSummary: { status: 'valid' },
  });
  await expect(page).not.toHaveURL(/(?:\?|&)revision=/u);
  await expect(page.getByRole('region', { name: /Viewing revision/u })).toHaveCount(0);
  await expect(page.getByText(
    `Restored revision 1 as new draft revision ${restore.draftRevision}.`,
    { exact: true },
  )).toBeVisible();
  await waitForRenderedMap(page.locator('#map-design-map-surface [role="region"][aria-label="Map"]'));

  const [restoredContext, restoredStyle, restoredHistory, restoredValidation] = await Promise.all([
    getJson<MapContext>(toolsDev.daemonUrl!, `${projectPrefix}/context`),
    getJson<PublicStyle>(toolsDev.daemonUrl!, `${projectPrefix}/style`),
    getJson<RevisionHistory>(toolsDev.daemonUrl!, `${projectPrefix}/revisions`),
    readJson(await fetch(`${toolsDev.daemonUrl}${projectPrefix}/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: restore.draftRevision }),
    })) as Promise<{ draftRevision: number; summary: { status: string } }>,
  ]);
  expect(restoredContext).toMatchObject({
    committedRevision: 2,
    draftRevision: restore.draftRevision,
    validationStatus: 'valid',
  });
  expect(representativePaint(restoredStyle)).toEqual(REVISION_PAINTS[1]);
  expect(restoredHistory).toEqual(historyBeforeRestore);
  expect(restoredValidation).toMatchObject({
    draftRevision: restore.draftRevision,
    summary: { status: 'valid' },
  });
  expect(representativePaint((await getJson<HistoricalSnapshot>(
    toolsDev.daemonUrl!,
    `${projectPrefix}/revisions/1/snapshot`,
  )).style)).toEqual(REVISION_PAINTS[1]);
  expect(consoleErrors).toEqual([]);
  expect(networkErrors).toEqual([]);
});

test('[P0] halts a repeated invalid legacy mutation at eight calls and renders localized loop copy', async ({ page, toolsDev }) => {
  const consoleErrors = recordConsoleErrors(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  const projectId = await createAndOpenReadyMapProjectForAgent(page, toolsDev.daemonUrl!, 'codex');
  const conversationId = selectedConversationId(page);
  await page.evaluate(() => {
    window.localStorage.setItem('map-design:locale', 'zh-CN');
    window.localStorage.setItem('map-design:locale-source', 'manual');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('region', { name: '地图设计智能体对话' })).toBeVisible();

  await page.getByLabel('向地图智能体发送消息').fill('Repeat the invalid legacy map operation until the run is stopped.');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await waitForAssistantStatus(toolsDev.daemonUrl!, projectId, conversationId, 'failed');
  await expect(page.getByRole('region', { name: '地图设计智能体对话' }).getByRole('alert'))
    .toHaveText('已停止重复的无效地图工具调用。');

  const conversation = await getConversation(toolsDev.daemonUrl!, projectId, conversationId);
  const assistant = conversation.messages.find((message) => message.role === 'assistant');
  const events = assistant?.events ?? [];
  expect(events.filter((event) => event.kind === 'tool_use' && event.name === 'map_apply_transaction')
    .map((event) => event.id)).toEqual(Array.from({ length: 8 }, (_, index) => `legacy-repeat-${index + 1}`));
  expect(events.filter((event) => event.kind === 'tool_result' && event.toolUseId?.startsWith('legacy-repeat-'))
    .map((event) => event.status)).toEqual(Array.from({ length: 8 }, () => 'failed'));
  expect(events.find((event) => event.toolUseId === 'legacy-repeat-8')).toMatchObject({
    kind: 'tool_result',
    status: 'failed',
    summary: { loopHalted: true, failureCount: 8 },
  });
  expect(events.some((event) => event.id === 'legacy-repeat-9' || event.toolUseId === 'legacy-repeat-9')).toBe(false);
  const omittedCounts = events
    .filter((event) => event.id === 'tools-omitted' || event.toolUseId === 'tools-omitted')
    .map((event) => event.summary?.omitted)
    .filter((value): value is number => typeof value === 'number');
  expect(Math.max(0, ...omittedCounts)).toBeLessThanOrEqual(8);
  expect(consoleErrors).toEqual([]);
});

test('[P1] Studio conversation creation keeps map identity and deep links isolate messages', async ({ page, toolsDev }) => {
  const consoleErrors = recordConsoleErrors(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  const projectId = await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!);

  const map = page.getByRole('region', { name: 'Map', exact: true });
  await expect(map).toBeVisible();
  const mapIdentity = await map.elementHandle();
  const previousConversationId = new URL(page.url()).searchParams.get('conversation');
  expect(previousConversationId).toBeTruthy();
  if (!previousConversationId) throw new Error('Map Studio did not select an initial conversation.');
  const conversationPrefix = `/api/map-design/projects/${projectId}/conversations/`;
  const newConversationGet = page.waitForResponse((response) => {
    const url = new URL(response.url());
    const conversationId = url.pathname.startsWith(conversationPrefix) ? url.pathname.slice(conversationPrefix.length) : '';
    return response.request().method() === 'GET' && conversationId.length > 0 && conversationId !== previousConversationId;
  });

  await page.getByRole('region', { name: 'Map design agent chat' })
    .getByRole('button', { name: 'New conversation', exact: true }).last().click();
  let conversationId = '';
  await expect.poll(() => {
    const current = new URL(page.url()).searchParams.get('conversation');
    return current && current !== previousConversationId ? current : '';
  }).not.toBe('');
  conversationId = new URL(page.url()).searchParams.get('conversation')!;
  await newConversationGet;
  const composer = page.getByLabel('Message map agent');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(composer).toBeEditable();
  const composerIdentity = await composer.elementHandle();
  await page.evaluate(async () => await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await composer.evaluate((element, original) => element === original, composerIdentity)).toBe(true);
  await composer.fill('Review park colors');
  await expect(send).toBeEnabled();
  await send.click();
  const conversationSelector = page.getByRole('button', { name: 'Project conversations' })
    .filter({ hasText: 'Review park colors' });
  await expect(conversationSelector).toBeVisible();

  await conversationSelector.click();
  await page.getByRole('option', { name: /New conversation/u }).click();
  await expect(page.getByRole('article', { name: 'Your message' }).filter({ hasText: 'Review park colors' })).toHaveCount(0);
  await expect(map).toBeAttached();
  expect(await map.evaluate((element, original) => element === original, mapIdentity)).toBe(true);

  await page.getByRole('button', { name: 'Project conversations' })
    .filter({ hasText: 'New conversation' }).click();
  await page.getByRole('option', { name: /Review park colors/u }).click();
  await expect(page.getByRole('article', { name: 'Your message' }).filter({ hasText: 'Review park colors' })).toBeVisible();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(new RegExp(`conversation=${conversationId}`, 'u'));
  await expect(page.getByRole('article', { name: 'Your message' }).filter({ hasText: 'Review park colors' })).toBeVisible();
  await waitForRenderedMap(page.locator('#map-design-map-surface [role="region"][aria-label="Map"]'));

  const deepLinkPage = await page.context().newPage();
  const deepLinkErrors = recordConsoleErrors(deepLinkPage);
  try {
    await deepLinkPage.goto(new URL(`/projects/${projectId}?conversation=${encodeURIComponent(conversationId)}`, page.url()).toString(), { waitUntil: 'domcontentloaded' });
    await expect(deepLinkPage.getByRole('article', { name: 'Your message' }).filter({ hasText: 'Review park colors' })).toBeVisible();
    await waitForRenderedMap(deepLinkPage.locator('#map-design-map-surface [role="region"][aria-label="Map"]'));
    expect(deepLinkErrors).toEqual([]);
  } finally {
    await deepLinkPage.close();
  }
  expect(consoleErrors).toEqual([]);
});

test('[P0] recovers from a resource gateway 502 without an unhandled console error', async ({ page, toolsDev }) => {
  const consoleErrors = recordConsoleErrors(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  const projectId = `resource-error-${crypto.randomUUID()}`;
  const response = await fetch(`${toolsDev.daemonUrl}/api/map-design/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId,
      title: 'Recoverable resource map',
      source: { url: 'https://demotiles.maplibre.org/style.json' },
      designRequirement: 'Keep resource failures recoverable.',
      runtime: { agentId: 'codex' },
      idempotencyKey: `map-create:${projectId}`,
    }),
  });
  if (!response.ok) throw new Error(`Map project creation failed: ${await response.text()}`);
  await expect.poll(async () => (
    await fetch(`${toolsDev.daemonUrl}/api/map-design/projects/${projectId}`).then((value) => value.json()) as { project: { lifecycle: string } }
  ).project.lifecycle).toBe('ready');
  await page.addInitScript(({ resourcePrefix }) => {
    const state = window as unknown as { __mapDesignFailResources: boolean };
    state.__mapDesignFailResources = true;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const url = new URL(raw, window.location.href);
      if (state.__mapDesignFailResources && (url.pathname.startsWith(resourcePrefix) || url.hostname === 'demotiles.maplibre.org')) {
        return new Response(JSON.stringify({ error: { code: 'RESOURCE_ERROR', message: 'Map resource request failed' } }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
      return await nativeFetch(input, init);
    };
  }, { resourcePrefix: `/api/map-design/projects/${projectId}/resources/` });

  await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
  const mapCanvas = page.getByRole('region', { name: 'Map canvas' });
  const alert = mapCanvas.getByRole('alert');
  await expect(alert).toContainText('Some map resources are unavailable.');
  await expect(alert).not.toContainText(/https?:|\/private|RESOURCE_ERROR/iu);
  expect(consoleErrors).toEqual([]);

  await page.evaluate(() => {
    (window as unknown as { __mapDesignFailResources: boolean }).__mapDesignFailResources = false;
  });
  await alert.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(alert).toBeHidden();
  await waitForRenderedMap(page.locator('#map-design-map-surface [role="region"][aria-label="Map"]'));
  expect(consoleErrors).toEqual([]);
});

test('[P0] recovers a hard-reset project with a new selected conversation and Run', async ({ page, toolsDev }) => {
  const consoleErrors = recordConsoleErrors(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  const projectId = await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!);

  await resetPlaywrightMapDesignConversations(toolsDev.dataDir);
  const reloadedProject = await getJson<{ conversationId: string | null }>(
    toolsDev.daemonUrl!,
    `/api/map-design/projects/${projectId}`,
  );
  expect(reloadedProject.conversationId).toBeNull();
  await page.reload({ waitUntil: 'domcontentloaded' });
  const chat = page.getByRole('region', { name: 'Map design agent chat' });
  await expect(chat.getByText('No conversation is available for this project.', { exact: true })).toBeVisible();
  await chat.getByRole('button', { name: 'New conversation', exact: true }).click();
  let conversationId = '';
  await expect.poll(() => {
    conversationId = new URL(page.url()).searchParams.get('conversation') ?? '';
    return conversationId;
  }).not.toBe('');
  await expect(chat.getByLabel('Message map agent')).toBeEditable();
  await sendMapPrompt(page, 'Review the recovered map');
  await waitForAssistantStatus(toolsDev.daemonUrl!, projectId, conversationId, 'succeeded');
  await expect(page.getByText('Map request reviewed.', { exact: true })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

function recordRetainedApiRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(page.url()).origin && url.pathname.startsWith('/api/')) requests.push(url.pathname);
  });
  return requests;
}

function recordConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

function recordNetworkErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'request failed';
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/u.test(failure)) errors.push(`${request.method()} ${request.url()} ${failure}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.request().method()} ${response.url()} ${response.status()}`);
  });
  return errors;
}

function expectNoRetiredApiRequests(requests: readonly string[]): void {
  expect(requests.filter((path) => !RETAINED_API_PATH.test(path))).toEqual([]);
}

async function selectFakeLocalAgent(daemonUrl: string, agentId: FakeAgentId | 'kimi' = 'codex'): Promise<void> {
  const response = await fetch(`${daemonUrl}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(agentId === 'kimi'
      ? { agentId, agentModels: { kimi: { model: 'moonshot-v1-8k' } } }
      : { agentId }),
  });
  await readJson(response);
}

async function switchConversationRuntime(page: Page, agentLabel: 'Codex' | 'OpenCode'): Promise<void> {
  const trigger = page.getByRole('button', { name: /Change runtime/u });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Runtime settings', exact: true });
  await dialog.getByRole('option', { name: new RegExp(`^${agentLabel}(?:\\s|$)`, 'u') }).click();
  await expect(trigger).toContainText(agentLabel);
  await expect(dialog).toBeHidden();
}

async function createAndOpenReadyMapProjectForAgent(page: Page, daemonUrl: string, agentId: 'codex'): Promise<string> {
  const projectId = `activity-${crypto.randomUUID()}`;
  const response = await fetch(`${daemonUrl}/api/map-design/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId,
      title: 'Activity acceptance map',
      source: { url: 'https://demotiles.maplibre.org/style.json' },
      designRequirement: 'Keep the map deterministic and legible.',
      runtime: { agentId },
      idempotencyKey: `map-create:${projectId}`,
    }),
  });
  if (!response.ok) throw new Error(`Map project creation failed: ${await response.text()}`);
  await expect.poll(async () => (
    await fetch(`${daemonUrl}/api/map-design/projects/${projectId}`).then((value) => value.json()) as { project: { lifecycle: string } }
  ).project.lifecycle).toBe('ready');
  await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('region', { name: 'Map canvas' })).toBeVisible();
  await waitForRenderedMap(page.locator('#map-design-map-surface [role="region"][aria-label="Map"]'));
  return projectId;
}

async function sendMapPrompt(page: Page, prompt: string): Promise<void> {
  const composer = page.getByLabel('Message map agent');
  await composer.fill(prompt);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

async function writeFakeRelease(capturePath: string, branch: string): Promise<void> {
  await writeFile(`${capturePath}.${branch}.release`, branch, 'utf8');
}

function waitForRunEventRequest(page: Page): Promise<PlaywrightRequest> {
  return page.waitForRequest((request) => (
    request.method() === 'GET' && /\/api\/runs\/[^/]+\/events$/u.test(new URL(request.url()).pathname)
  ));
}

function selectedConversationId(page: Page): string {
  const conversationId = new URL(page.url()).searchParams.get('conversation');
  if (!conversationId) throw new Error('Map Studio did not select a conversation.');
  return conversationId;
}

type ConversationSnapshot = {
  messages: Array<{
    role: 'assistant' | 'user';
    content: string;
    events: PersistedMapAgentEvent[];
    runStatus: MapRunStatus;
    runtime?: {
      adapter: string;
      agentId: string;
      model: string;
    };
  }>;
};

type ConversationRuntimeSnapshot = {
  agentId: string;
  model?: string;
  reasoning?: string;
  revision: number;
  serviceTier?: string;
  updatedAt: string;
};

type ReplayEvent = {
  type?: string;
  events?: PersistedMapAgentEvent[];
  message?: { events?: PersistedMapAgentEvent[] };
};

function eventSignatures(events: readonly PersistedMapAgentEvent[]): Array<Record<string, string>> {
  return events.map((event) => {
    const signature: Record<string, string> = { kind: event.kind };
    for (const key of ['label', 'text', 'id', 'name', 'toolUseId', 'status'] as const) {
      const value = event[key];
      if (typeof value === 'string') signature[key] = value;
    }
    return signature;
  });
}

function parseSseData(value: string): ReplayEvent[] {
  return value.split('\n\n').flatMap((frame) => {
    const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
    if (!line) return [];
    try { return [JSON.parse(line.slice(6)) as ReplayEvent]; } catch { return []; }
  });
}

function eventsFromReplay(event: ReplayEvent | undefined, source: 'root' | 'message' = 'root'): PersistedMapAgentEvent[] {
  return source === 'message' ? event?.message?.events ?? [] : event?.events ?? [];
}

async function getConversation(daemonUrl: string, projectId: string, conversationId: string): Promise<ConversationSnapshot> {
  const response = await fetch(`${daemonUrl}/api/map-design/projects/${projectId}/conversations/${conversationId}`);
  if (!response.ok) throw new Error(`Conversation request failed: ${await response.text()}`);
  return await response.json() as ConversationSnapshot;
}

async function getConversationRuntime(
  daemonUrl: string,
  projectId: string,
  conversationId: string,
): Promise<ConversationRuntimeSnapshot> {
  const response = await fetch(`${daemonUrl}/api/map-design/projects/${projectId}/conversations/${conversationId}/runtime`);
  const body = await readJson(response) as { runtime: ConversationRuntimeSnapshot };
  return body.runtime;
}

async function waitForAssistantStatus(
  daemonUrl: string,
  projectId: string,
  conversationId: string,
  status: 'succeeded' | 'failed' | 'canceled',
): Promise<void> {
  await expect.poll(async () => {
    const conversation = await getConversation(daemonUrl, projectId, conversationId);
    return conversation.messages.find((message) => message.role === 'assistant')?.runStatus;
  }).toBe(status);
}

async function waitForAssistantTurnStatus(
  daemonUrl: string,
  projectId: string,
  conversationId: string,
  assistantIndex: number,
  status: 'succeeded' | 'failed' | 'canceled',
): Promise<void> {
  await expect.poll(async () => {
    const conversation = await getConversation(daemonUrl, projectId, conversationId);
    return conversation.messages.filter((message) => message.role === 'assistant')[assistantIndex]?.runStatus;
  }, { timeout: T.xlong }).toBe(status);
}

async function expectButtonsToBeAdjacent(first: ReturnType<Page['getByRole']>, second: ReturnType<Page['getByRole']>): Promise<void> {
  await expect.poll(async () => {
    const [firstBox, secondBox] = await Promise.all([first.boundingBox(), second.boundingBox()]);
    if (!firstBox || !secondBox) return false;
    const firstBeforeSecond = firstBox.x + firstBox.width <= secondBox.x;
    const sameRow = Math.abs((firstBox.y + firstBox.height / 2) - (secondBox.y + secondBox.height / 2)) <= 1;
    const gap = secondBox.x - (firstBox.x + firstBox.width);
    return firstBeforeSecond && sameRow && gap >= 0 && gap <= 16;
  }).toBe(true);
}

async function expectCurrentPreview(daemonUrl: string, projectId: string): Promise<{ previewId: string }> {
  let previewId = '';
  await expect.poll(async () => {
    const current = await getJson<{ preview: { status: string; previewId: string } | null }>(
      daemonUrl,
      `/api/map-design/projects/${projectId}/previews/current`,
    );
    previewId = current.preview?.status === 'succeeded' ? current.preview.previewId : '';
    return previewId;
  }, { timeout: T.xlong }).not.toBe('');
  return { previewId };
}

async function getJson<T>(daemonUrl: string, path: string): Promise<T> {
  return readJson(await fetch(`${daemonUrl}${path}`)) as Promise<T>;
}

type MapContext = {
  committedRevision: number | null;
  draftRevision: number;
  validationStatus: string;
};

type PublicStyle = {
  layers: Array<{
    id: string;
    paint?: Record<string, unknown>;
    type: string;
  }>;
};

type RevisionHistory = {
  returned: number;
  revisions: Array<{
    committedAt: string;
    draftRevision: number;
    previewId: string | null;
    revision: number;
    styleHash: string;
  }>;
  truncated: boolean;
};

type HistoricalSnapshot = {
  inspect: {
    view: {
      kind: 'root';
      layers: Array<{ id: string; type: string }>;
      style: { layerCount: number };
    };
  };
  revision: { revision: number };
  style: PublicStyle;
  validation: { summary: { status: string } };
};

function representativePaint(style: PublicStyle): { background: string; fill: string; line: string; symbol: string } {
  const property = (layerId: string, paintProperty: string): string => {
    const value = style.layers.find((layer) => layer.id === layerId)?.paint?.[paintProperty];
    if (typeof value !== 'string') throw new Error(`Missing ${paintProperty} on ${layerId}.`);
    return value;
  };
  return {
    background: property('background', 'background-color'),
    fill: property('countries-fill', 'fill-color'),
    line: property('countries-boundary', 'line-color'),
    symbol: property('countries-label', 'text-color'),
  };
}

function expectRepresentativeInspect(inspect: HistoricalSnapshot['inspect']): void {
  expect(inspect.view.kind).toBe('root');
  expect(inspect.view.layers).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'background', type: 'background' }),
    expect.objectContaining({ id: 'countries-fill', type: 'fill' }),
    expect.objectContaining({ id: 'countries-boundary', type: 'line' }),
    expect.objectContaining({ id: 'countries-label', type: 'symbol' }),
  ]));
}

async function waitForRevisionHistory(
  daemonUrl: string,
  projectPrefix: string,
  expectedRevisions: number[],
): Promise<RevisionHistory> {
  let history: RevisionHistory | null = null;
  await expect.poll(async () => {
    history = await getJson<RevisionHistory>(daemonUrl, `${projectPrefix}/revisions`);
    return history.revisions.map((revision) => revision.revision).sort((left, right) => left - right);
  }, { timeout: T.xlong }).toEqual(expectedRevisions);
  if (!history) throw new Error('Revision history did not load.');
  return history;
}

async function openRevisionInspector(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name: 'Open inspector', exact: true });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  await page.getByRole('tab', { name: 'Revisions', exact: true }).click();
}

function waitForRevisionSnapshotResponse(
  page: Page,
  projectPrefix: string,
  revision: number,
): Promise<PlaywrightResponse> {
  return page.waitForResponse((response) => (
    response.request().method() === 'GET'
    && response.ok()
    && new URL(response.url()).pathname === `${projectPrefix}/revisions/${revision}/snapshot`
  ));
}

async function readHistoricalSnapshotResponse(response: PlaywrightResponse): Promise<HistoricalSnapshot> {
  return await readJson(response) as unknown as HistoricalSnapshot;
}

async function readJson(response: Response | PlaywrightResponse): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  const ok = 'ok' in response && typeof response.ok === 'function' ? response.ok() : response.ok;
  expect(ok, JSON.stringify(body)).toBe(true);
  return body;
}

async function readFakeCapture(path: string): Promise<Array<{
  adapterPath?: string;
  agentId?: string;
  branch?: string;
  conversationId?: string;
  phase?: string;
  prompt?: string;
  resumed?: boolean;
  sessionId?: string;
  skillObserved?: boolean;
  tool?: string;
  tools?: string[];
  type: string;
  visibleTranscript?: string;
}>> {
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
    adapterPath?: string;
    agentId?: string;
    branch?: string;
    conversationId?: string;
    phase?: string;
    prompt?: string;
    resumed?: boolean;
    sessionId?: string;
    skillObserved?: boolean;
    tool?: string;
    tools?: string[];
    type: string;
    visibleTranscript?: string;
  });
}
