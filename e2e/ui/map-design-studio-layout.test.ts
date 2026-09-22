import { writeFile } from 'node:fs/promises';

import { expect, test } from '@/playwright/suite';
import { createAndOpenReadyMapProject, waitForRenderedMap } from '@/playwright/map-design-project';
import { T } from '@/timeouts';
import type { Locator, Page, TestInfo } from '@playwright/test';

const DESKTOP_VIEWPORT = { width: 1440, height: 960 } as const;
const TABLET_VIEWPORT = { width: 1024, height: 768 } as const;
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

test.describe.configure({ mode: 'default', timeout: T.xlong });

test('[P0] keeps long localized conversation metadata separated inside a 390 px chat pane', async ({ page, toolsDev }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const consoleErrors = recordConsoleErrors(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  const projectId = await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!);
  const creationConversationId = new URL(page.url()).searchParams.get('conversation');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('conversation')).not.toBe(creationConversationId);
  const conversationId = new URL(page.url()).searchParams.get('conversation');
  if (!conversationId) throw new Error('Map Studio did not select a conversation.');
  await resizeChatPane(page, 390);

  const prompt = 'Improve road hierarchy while reviewing exceptionally detailed localized labels across every regional corridor';
  const eventRequest = page.waitForRequest((request) => (
    request.method() === 'GET' && /\/api\/runs\/[^/]+\/events$/u.test(new URL(request.url()).pathname)
  ));
  await page.getByLabel('Message map agent').fill(prompt);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeVisible();
  await eventRequest;
  await writeFile(`${toolsDev.fakeMapAcp.capturePath}.activity-success-start.release`, 'activity-success-start', 'utf8');
  await expect.poll(async () => {
    const response = await fetch(`${toolsDev.daemonUrl}/api/map-design/projects/${projectId}/conversations/${conversationId}`);
    if (!response.ok) throw new Error(`Conversation request failed: ${await response.text()}`);
    const conversation = await response.json() as {
      messages: Array<{ events?: Array<{ kind: string; status?: string; toolUseId?: string }> }>;
    };
    return conversation.messages.some((message) => message.events?.some((event) => (
      event.kind === 'tool_result' && event.toolUseId === 'apply-call' && event.status === 'succeeded'
    )));
  }).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const chat = page.locator('#map-design-chat-surface');
  await expect.poll(async () => Math.round((await chat.boundingBox())?.width ?? 0)).toBe(390);
  const activityToggle = page.getByTestId('task-activity-toggle').last();
  const activity = page.getByRole('region', { name: /analyzing/i }).last();
  const applyChanges = activity.getByRole('button', { name: /Apply map changes.*Completed/i });
  await expect(applyChanges).toBeVisible();
  await applyChanges.click();
  const resultSummary = activity.getByRole('heading', { name: 'Result summary', exact: true });
  await expect(resultSummary).toBeVisible();
  const toolBody = resultSummary.locator('..').locator('..');
  expect(await toolBody.evaluate((element) => getComputedStyle(element).maxHeight)).toBe('280px');
  expect(await toolBody.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  await assertContainedWithin(chat, [activityToggle, activity, applyChanges, toolBody]);

  const trigger = page.locator('button[aria-haspopup="listbox"]');
  await expect(trigger).toContainText('Improve road hierarchy');
  await trigger.click();
  const option = page.getByRole('option', { name: /Improve road hierarchy.*Running/u });
  await expect(option).toBeVisible();
  const title = option.locator('[data-conversation-title]');
  const time = option.locator('[data-conversation-time]');
  const count = option.locator('[data-conversation-count]');
  const run = option.locator('[data-conversation-run]');
  await expect(title).toContainText('Improve road hierarchy');
  await expect(count).toHaveText('2 messages');
  await expect(run).toHaveText('Running');
  await expect(run.locator('[data-conversation-run-dot]')).toHaveCount(1);
  await expect(option).toHaveAttribute('aria-selected', 'true');
  const conversationPopup = page.locator('[data-slot="popover-content"]').filter({ has: option });
  expect(await conversationPopup.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none');
  const dateTime = await time.getAttribute('datetime');
  expect(dateTime).toBeTruthy();
  expect(await time.innerText()).not.toBe(dateTime);
  await assertContainedAndNonIntersecting(option, [title, time, count, run]);

  await page.keyboard.press('Escape');
  await writeFile(`${toolsDev.fakeMapAcp.capturePath}.activity-success.release`, 'activity-success', 'utf8');
  await expect.poll(async () => {
    const response = await fetch(`${toolsDev.daemonUrl}/api/map-design/projects/${projectId}/conversations/${conversationId}`);
    if (!response.ok) throw new Error(`Conversation request failed: ${await response.text()}`);
    const conversation = await response.json() as { messages: Array<{ role: string; runStatus?: string }> };
    return conversation.messages.find((message) => message.role === 'assistant')?.runStatus;
  }).toBe('succeeded');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: /completed/i })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('[P1] Map Studio preserves its mounted map across desktop workbench transitions', async ({ page, toolsDev }, testInfo) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const consoleErrors = recordConsoleErrors(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!);

  const map = mapLocator(page);
  await expect(map).toBeVisible();
  const mapIdentity = await map.elementHandle();
  const navigation = page.getByRole('group', { name: 'Map navigation', exact: true });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole('button')).toHaveCount(4);
  const zoomIn = navigation.getByRole('button', { name: 'Zoom in', exact: true });
  const scaleBeforeZoom = await mapScaleText(page);
  await zoomIn.focus();
  await zoomIn.press('Enter');
  await expect(zoomIn).toBeFocused();
  await expect.poll(async () => await mapScaleText(page)).not.toBe(scaleBeforeZoom);
  await assertNavigationStaysInsideMap(map, navigation);
  await expectMapFitsViewport(page, map);
  await captureWorkbenchScreenshot(page, testInfo, 'desktop-expanded', [map]);

  const conversationResize = page.getByRole('separator', { name: 'Resize design conversation', exact: true });
  await conversationResize.press('End');
  await expect.poll(async () => Math.round((await page.locator('#map-design-chat-surface').boundingBox())?.width ?? 0)).toBe(520);
  await expectResizableValue(conversationResize, 'maximum');
  await page.getByRole('button', { name: 'Collapse chat', exact: true }).click();
  const expandConversation = page.getByRole('button', { name: 'Expand design conversation', exact: true });
  await expect(expandConversation).toBeFocused();
  await captureWorkbenchScreenshot(page, testInfo, 'desktop-collapsed', [map, expandConversation]);
  await expandConversation.click();
  await expect(page.getByRole('button', { name: 'Collapse chat', exact: true })).toBeVisible();
  await expectMapIdentity(map, mapIdentity);

  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: 'Map inspector', exact: true });
  await expect(inspector).toHaveAttribute('data-placement', 'floating');
  await waitForStableWorkbench(page, [map, inspector]);
  await expectWidthWithin(inspector, 286, 320);
  await expectMeaningfulPanelHeight(page, inspector);
  await captureWorkbenchScreenshot(page, testInfo, 'desktop-floating-inspector', [map, inspector]);
  await page.getByRole('button', { name: 'Dock inspector', exact: true }).click();
  await expect(inspector).toHaveAttribute('data-placement', 'docked');
  const inspectorResize = page.getByRole('separator', { name: 'Resize map inspector', exact: true });
  await expect(inspectorResize).toBeVisible();
  await waitForDescendantAnimations(inspector);
  await waitForStableWorkbench(page, [map, inspector]);
  await expectWidthWithin(inspector, 280, 420);
  await expectMeaningfulPanelHeight(page, inspector);
  await assertDockedInspectorLayout(page, { inspector, inspectorResize, map });
  await captureWorkbenchScreenshot(page, testInfo, 'desktop-docked-inspector', [map, inspector]);
  await expectMapIdentity(map, mapIdentity);

  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
  await expectMapFitsViewport(page, map, 0.8);
  await captureWorkbenchScreenshot(page, testInfo, 'desktop-fullscreen-map', [map]);
  await expectMapIdentity(map, mapIdentity);
  expect(consoleErrors).toEqual([]);
});

test('[P1] Map Studio resizers follow logical tracks after selecting an RTL language', async ({ page, toolsDev }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const consoleErrors = recordConsoleErrors(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!);

  const projectUrl = page.url();
  await page.goto('/settings/appearance');
  await page.getByRole('combobox', { name: 'Language', exact: true }).click();
  await page.getByRole('option', { name: 'العربية', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.goto(projectUrl);
  const conversationResize = page.getByRole('separator', { name: 'تغيير حجم محادثة التصميم', exact: true });
  const chat = page.locator('#map-design-chat-surface');
  const map = mapLocator(page);
  await expect.poll(async () => {
    const [chatBox, mapBox] = await Promise.all([chat.boundingBox(), map.boundingBox()]);
    return chatBox !== null && mapBox !== null && chatBox.x > mapBox.x;
  }).toBe(true);
  const conversationControlsChat = await conversationResize.getAttribute('aria-controls') === 'chat';
  const mapIdentity = await map.elementHandle();
  await conversationResize.press(conversationControlsChat ? 'Home' : 'End');
  await expect.poll(async () => Math.round((await chat.boundingBox())?.width ?? 0)).toBe(320);
  await expectResizableValue(conversationResize, conversationControlsChat ? 'minimum' : 'maximum');
  await conversationResize.press('ArrowLeft');
  await expect.poll(async () => (await chat.boundingBox())?.width ?? 0).toBeGreaterThan(320);
  await expectResizableValue(conversationResize);
  const [chatHandle, chatBeforeDrag] = await Promise.all([conversationResize.boundingBox(), chat.boundingBox()]);
  if (!chatHandle || !chatBeforeDrag) throw new Error('RTL conversation resize geometry is unavailable');
  await conversationResize.hover();
  await page.mouse.down();
  await page.mouse.move(chatHandle.x + chatHandle.width / 2 - 24, chatHandle.y + chatHandle.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await chat.boundingBox())?.width ?? 0)).toBe(Math.round(chatBeforeDrag.width + 24));
  await expectResizableValue(conversationResize);

  await page.getByRole('button', { name: 'الطبقات', exact: true }).click();
  await page.getByRole('button', { name: 'إرساء الفاحص', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: 'فاحص الخريطة', exact: true });
  const inspectorResize = page.getByRole('separator', { name: 'تغيير حجم فاحص الخريطة', exact: true });
  await expect.poll(async () => {
    const [inspectorBox, handleBox, mapBox] = await Promise.all([inspector.boundingBox(), inspectorResize.boundingBox(), map.boundingBox()]);
    return inspectorBox !== null && handleBox !== null && mapBox !== null
      && inspectorBox.x < handleBox.x && handleBox.x < mapBox.x;
  }).toBe(true);
  const inspectorControlsInspector = await inspectorResize.getAttribute('aria-controls') === 'inspector';
  await inspectorResize.press(inspectorControlsInspector ? 'Home' : 'End');
  await expect.poll(async () => Math.round((await inspector.boundingBox())?.width ?? 0)).toBe(280);
  await expectResizableValue(inspectorResize, inspectorControlsInspector ? 'minimum' : 'maximum');
  await inspectorResize.press('ArrowRight');
  await expect.poll(async () => (await inspector.boundingBox())?.width ?? 0).toBeGreaterThan(280);
  await expectResizableValue(inspectorResize);
  const [inspectorHandle, inspectorBeforeDrag] = await Promise.all([inspectorResize.boundingBox(), inspector.boundingBox()]);
  if (!inspectorHandle || !inspectorBeforeDrag) throw new Error('RTL inspector resize geometry is unavailable');
  await page.mouse.move(inspectorHandle.x + inspectorHandle.width / 2, inspectorHandle.y + inspectorHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(inspectorHandle.x + inspectorHandle.width / 2 + 24, inspectorHandle.y + inspectorHandle.height / 2);
  await page.mouse.up();
  await expect.poll(async () => Math.round((await inspector.boundingBox())?.width ?? 0)).toBe(Math.round(inspectorBeforeDrag.width + 24));
  await expectResizableValue(inspectorResize);
  await expectMapIdentity(map, mapIdentity);
  const savedChatWidth = Math.round((await chat.boundingBox())?.width ?? 0);
  const savedInspectorWidth = Math.round((await inspector.boundingBox())?.width ?? 0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(async () => Math.round((await chat.boundingBox())?.width ?? 0)).toBe(savedChatWidth);
  await page.getByRole('button', { name: 'الطبقات', exact: true }).click();
  await expect(inspector).toHaveAttribute('data-placement', 'docked');
  await expect.poll(async () => Math.round((await inspector.boundingBox())?.width ?? 0)).toBe(savedInspectorWidth);
  expect(consoleErrors).toEqual([]);
});

test('[P1] Map Studio presents a modal tablet inspector without losing map or focus', async ({ page, toolsDev }, testInfo) => {
  await page.setViewportSize(TABLET_VIEWPORT);
  const consoleErrors = recordConsoleErrors(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!);

  const map = mapLocator(page);
  await expect(map).toBeVisible();
  const mapIdentity = await map.elementHandle();
  await assertAccessibleMapStatus(page);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Map inspector', exact: true });
  const closeInspector = dialog.getByRole('button', { name: 'Close inspector', exact: true });
  await expect(dialog).toBeVisible();
  await expect(closeInspector).toBeFocused();
  await expect(page.locator('#map-design-chat-surface')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('[role="separator"][aria-label="Resize design conversation"]')).toHaveCount(0);
  const mapColumn = page.locator('#map-design-map-surface section[aria-label="Map canvas"]');
  await expect(mapColumn).toHaveAttribute('aria-hidden', 'true');
  await expect(mapColumn).toHaveAttribute('inert', '');
  await captureWorkbenchScreenshot(page, testInfo, 'tablet-drawer-inspector', [dialog]);

  const commentsTab = dialog.getByRole('tab', { name: 'Comment (0)', exact: true });
  const commentsPanel = dialog.getByRole('tabpanel', { name: 'Comment (0)', exact: true });
  await commentsTab.click();
  await expect(commentsPanel).toBeVisible();
  await commentsTab.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(closeInspector).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(commentsTab).toBeFocused();
  const newComment = commentsPanel.getByRole('button', { name: 'New comment', exact: true });
  await newComment.focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Dock inspector', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(newComment).toBeFocused();
  await closeInspector.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Comment (0)', exact: true })).toBeFocused();
  await expectMapIdentity(map, mapIdentity);
  expect(consoleErrors).toEqual([]);
});

test('[P1] narrow tablet inspector keeps header spacing and background layer metadata separated', async ({ page, toolsDev }) => {
  await page.setViewportSize({ width: 771, height: 764 });
  const consoleErrors = recordConsoleErrors(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  const inspector = page.getByRole('dialog', { name: 'Map inspector', exact: true });
  const tabs = inspector.getByRole('tablist', { name: 'Map inspector', exact: true });
  const title = inspector.locator('[data-slot="tabs"]').getByText('Map inspector', { exact: true });
  const dock = inspector.getByRole('button', { name: 'Dock inspector', exact: true });
  const close = inspector.getByRole('button', { name: 'Close inspector', exact: true });
  await inspector.getByRole('tab', { name: 'Layers', exact: true }).click();
  const layers = inspector.getByRole('tabpanel', { name: 'Layers', exact: true });
  const background = layers.locator('[data-slot="card"]').filter({
    has: page.locator('[data-slot="badge"]').filter({ hasText: /^background$/u }),
  }).first();
  const badge = background.locator('[data-slot="badge"]');
  const layerTitle = background.locator('[data-slot="card-title"]');
  await expect(background).toBeVisible();
  await expect(layerTitle).not.toBeEmpty();
  await waitForStableWorkbench(page, [inspector, tabs, background]);
  await assertContainedWithin(inspector, [title, dock, close, tabs, background]);
  await assertContainedWithin(background, [badge, layerTitle]);

  const [titleBox, dockBox, closeBox, tabsBox, badgeBox, layerTitleBox] = await Promise.all(
    [title, dock, close, tabs, badge, layerTitle].map((locator) => locator.boundingBox()),
  );
  if (!titleBox || !dockBox || !closeBox || !tabsBox || !badgeBox || !layerTitleBox) {
    throw new Error('Inspector header or background metadata is not measurable.');
  }
  // Both header text and actions must stay above the tabs with breathing room.
  expect(tabsBox.y - Math.max(titleBox.y + titleBox.height, dockBox.y + dockBox.height, closeBox.y + closeBox.height)).toBeGreaterThanOrEqual(8);
  expect(dockBox.x - (titleBox.x + titleBox.width)).toBeGreaterThanOrEqual(4);
  // A long layer type stays alongside its title, without collision or a new row.
  expect(layerTitleBox.x - (badgeBox.x + badgeBox.width)).toBeGreaterThanOrEqual(4);
  expect(Math.min(badgeBox.y + badgeBox.height, layerTitleBox.y + layerTitleBox.height)
    - Math.max(badgeBox.y, layerTitleBox.y)).toBeGreaterThan(0);
  expect(consoleErrors).toEqual([]);
});

test('[P1] Map Studio switches mobile Chat and Map panels with retained map identity', async ({ page, toolsDev }, testInfo) => {
  const consoleErrors = recordConsoleErrors(page);
  await selectFakeLocalAgent(toolsDev.daemonUrl!);
  await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!);
  await page.setViewportSize(MOBILE_VIEWPORT);

  const chatTab = page.getByRole('tab', { name: 'Chat', exact: true });
  const mapTab = page.getByRole('tab', { name: 'Map', exact: true });
  const chatPanel = page.getByRole('tabpanel', { name: 'Chat', exact: true });
  const mapPanel = page.getByRole('tabpanel', { name: 'Map', exact: true });
  const map = mapLocator(page);
  await expect(map).toBeAttached();
  const mapIdentity = await map.elementHandle();
  await expect(chatTab).toHaveAttribute('aria-selected', 'true');
  await expect(chatPanel).toBeVisible();
  await expect(mapPanel).toBeHidden();
  await captureWorkbenchScreenshot(page, testInfo, 'mobile-chat', [chatPanel]);

  await chatTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(mapTab).toBeFocused();
  await expect(mapTab).toHaveAttribute('aria-selected', 'true');
  await expect(mapPanel).toBeVisible();
  await expect(chatPanel).toBeHidden();
  await expect(page.locator('#map-design-chat-surface')).toHaveAttribute('aria-hidden', 'true');
  await expect(map).toBeVisible();
  await expectMapFitsViewport(page, map, 0.8);
  await assertAccessibleMapStatus(page);
  const navigation = page.getByRole('group', { name: 'Map navigation', exact: true });
  await expect(navigation).toBeVisible();
  const zoomOut = navigation.getByRole('button', { name: 'Zoom out', exact: true });
  const scaleBeforeZoom = await mapScaleText(page);
  await zoomOut.click();
  await expect.poll(async () => await mapScaleText(page)).not.toBe(scaleBeforeZoom);
  await assertNavigationStaysInsideMap(map, navigation);
  await captureWorkbenchScreenshot(page, testInfo, 'mobile-map', [mapPanel, map]);
  await expectMapIdentity(map, mapIdentity);
  expect(consoleErrors).toEqual([]);
});

function recordConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

async function selectFakeLocalAgent(daemonUrl: string): Promise<void> {
  const response = await fetch(`${daemonUrl}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: 'codex' }),
  });
  expect(response.ok, await response.text()).toBe(true);
}

function mapLocator(page: Page): Locator {
  return page.locator('#map-design-map-surface [role="region"][aria-label="Map"]');
}

async function expectMapFitsViewport(page: Page, map: Locator, widthRatio = 0.5, heightRatio = 0.5): Promise<void> {
  await expect.poll(async () => (await map.boundingBox())?.width ?? 0)
    .toBeGreaterThan((page.viewportSize()?.width ?? 0) * widthRatio);
  await expect.poll(async () => (await map.boundingBox())?.height ?? 0)
    .toBeGreaterThan((page.viewportSize()?.height ?? 0) * heightRatio);
}

async function expectMapIdentity(map: Locator, identity: Awaited<ReturnType<Locator['elementHandle']>>): Promise<void> {
  expect(await map.evaluate((element, original) => element === original, identity)).toBe(true);
}

async function resizeChatPane(page: Page, width: number): Promise<void> {
  const workspace = page.locator('[data-chat-collapsed]');
  const chat = page.locator('#map-design-chat-surface');
  const handle = page.getByRole('separator', { name: 'Resize design conversation', exact: true });
  const [workspaceBox, handleBox] = await Promise.all([workspace.boundingBox(), handle.boundingBox()]);
  if (!workspaceBox || !handleBox) throw new Error('Chat resize geometry is unavailable');
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(workspaceBox.x + width + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.up();
  await expect.poll(async () => Math.round((await chat.boundingBox())?.width ?? 0)).toBe(width);
  await expectResizableValue(handle);
}

async function expectResizableValue(handle: Locator, boundary?: 'minimum' | 'maximum'): Promise<void> {
  for (const attribute of ['aria-valuenow', 'aria-valuemin', 'aria-valuemax']) {
    await expect(handle).toHaveAttribute(attribute, /^\d+(?:\.\d+)?$/);
  }
  const values = await handle.evaluate((element) => {
    const controlledId = element.getAttribute('aria-controls');
    const panel = controlledId ? document.getElementById(controlledId) : null;
    const group = element.parentElement;
    if (!panel || !group) throw new Error('Resizable panel geometry is unavailable');
    const availableWidth = Array.from(group.children)
      .filter((child) => child.getAttribute('data-slot') === 'resizable-panel')
      .reduce((total, child) => total + child.getBoundingClientRect().width, 0);
    return {
      current: Number(element.getAttribute('aria-valuenow')),
      minimum: Number(element.getAttribute('aria-valuemin')),
      maximum: Number(element.getAttribute('aria-valuemax')),
      percentage: panel.getBoundingClientRect().width / availableWidth * 100,
    };
  });
  expect(values.current).toBeCloseTo(values.percentage, 2);
  expect(values.minimum).toBeGreaterThanOrEqual(0);
  expect(values.maximum).toBeLessThanOrEqual(100);
  expect(values.current).toBeGreaterThanOrEqual(values.minimum);
  expect(values.current).toBeLessThanOrEqual(values.maximum);
  if (boundary) expect(values.current).toBe(values[boundary]);
}

async function assertContainedAndNonIntersecting(option: Locator, metadata: readonly Locator[]): Promise<void> {
  const optionBox = await option.boundingBox();
  const boxes = await Promise.all(metadata.map(async (element) => await element.boundingBox()));
  if (!optionBox || boxes.some((box) => box === null)) {
    throw new Error(`Conversation metadata boxes unavailable: ${JSON.stringify({ optionBox, boxes })}`);
  }
  const concrete = boxes.filter((box): box is NonNullable<typeof box> => box !== null);
  const tolerance = 1;
  for (const box of concrete) {
    expect(box.x).toBeGreaterThanOrEqual(optionBox.x - tolerance);
    expect(box.y).toBeGreaterThanOrEqual(optionBox.y - tolerance);
    expect(box.x + box.width).toBeLessThanOrEqual(optionBox.x + optionBox.width + tolerance);
    expect(box.y + box.height).toBeLessThanOrEqual(optionBox.y + optionBox.height + tolerance);
  }
  for (let index = 0; index < concrete.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < concrete.length; otherIndex += 1) {
      const first = concrete[index]!;
      const second = concrete[otherIndex]!;
      const intersects = first.x < second.x + second.width - tolerance
        && first.x + first.width > second.x + tolerance
        && first.y < second.y + second.height - tolerance
        && first.y + first.height > second.y + tolerance;
      expect(intersects, `Metadata overlap: ${JSON.stringify({ first, second })}`).toBe(false);
    }
  }
}

async function assertContainedWithin(container: Locator, descendants: readonly Locator[]): Promise<void> {
  const containerBox = await container.boundingBox();
  const descendantBoxes = await Promise.all(descendants.map(async (descendant) => await descendant.boundingBox()));
  if (!containerBox || descendantBoxes.some((box) => box === null)) {
    throw new Error(`Containment boxes unavailable: ${JSON.stringify({ containerBox, descendantBoxes })}`);
  }
  const tolerance = 1;
  for (const box of descendantBoxes) {
    if (!box) continue;
    expect(box.x).toBeGreaterThanOrEqual(containerBox.x - tolerance);
    expect(box.x + box.width).toBeLessThanOrEqual(containerBox.x + containerBox.width + tolerance);
  }
  expect(await container.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

async function assertAccessibleMapStatus(page: Page): Promise<void> {
  const status = page.getByRole('status').filter({ hasText: 'EPSG:3857' });
  await expect(status).toHaveClass(/\bsr-only\b/);
  await expect(status).toHaveAttribute('aria-live', 'off');
  await expect(status).not.toHaveAttribute('aria-hidden', 'true');
  await expect(status.locator('span').nth(1)).toHaveText(/^1:[\d,]+$/);
}

async function mapScaleText(page: Page): Promise<string> {
  return await page.getByRole('status').filter({ hasText: 'EPSG:3857' }).locator('span').nth(1).innerText();
}

async function assertNavigationStaysInsideMap(map: Locator, navigation: Locator): Promise<void> {
  const [mapBox, navigationBox] = await Promise.all([
    map.boundingBox(),
    navigation.boundingBox(),
  ]);
  if (!mapBox || !navigationBox) {
    throw new Error(`Map navigation boxes unavailable: ${JSON.stringify({ mapBox, navigationBox })}`);
  }
  const tolerance = 1;
  expect(navigationBox.x).toBeGreaterThanOrEqual(mapBox.x - tolerance);
  expect(navigationBox.x + navigationBox.width).toBeLessThanOrEqual(mapBox.x + mapBox.width + tolerance);
  expect(navigationBox.y).toBeGreaterThanOrEqual(mapBox.y - tolerance);
  expect(navigationBox.y + navigationBox.height).toBeLessThanOrEqual(mapBox.y + mapBox.height - 8);
}

async function expectWidthWithin(panel: Locator, minimum: number, maximum: number): Promise<void> {
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(minimum);
  await expect.poll(async () => (await panel.boundingBox())?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(maximum);
}

async function expectMeaningfulPanelHeight(page: Page, panel: Locator): Promise<void> {
  await expect.poll(async () => (await panel.boundingBox())?.height ?? 0)
    .toBeGreaterThan((page.viewportSize()?.height ?? 0) * 0.5);
}

async function waitForDescendantAnimations(target: Locator): Promise<void> {
  await expect.poll(async () => await target.evaluate((element) =>
    element.getAnimations({ subtree: true }).every((animation) => animation.playState === 'finished' || animation.playState === 'idle'),
  )).toBe(true);
}

async function assertDockedInspectorLayout(page: Page, targets: { inspector: Locator; inspectorResize: Locator; map: Locator }): Promise<void> {
  const layersPanel = targets.inspector.getByRole('tabpanel', { name: 'Layers', exact: true });
  await expect(layersPanel).toBeVisible();
  const [inspector, inspectorResize, map, layersPanelBox] = await Promise.all([
    targets.inspector.boundingBox(),
    targets.inspectorResize.boundingBox(),
    targets.map.boundingBox(),
    layersPanel.boundingBox(),
  ]);
  const viewport = page.viewportSize();
  if (!inspector || !inspectorResize || !map || !layersPanelBox || !viewport) {
    throw new Error(`Docked layout boxes unavailable: ${JSON.stringify({ inspector, inspectorResize, map, layersPanel: layersPanelBox, viewport })}`);
  }
  const tolerance = 1;
  const panelInsideInspector = layersPanelBox.x >= inspector.x - tolerance
    && layersPanelBox.y >= inspector.y - tolerance
    && layersPanelBox.x + layersPanelBox.width <= inspector.x + inspector.width + tolerance
    && layersPanelBox.y + layersPanelBox.height <= inspector.y + inspector.height + tolerance;
  const panelMeaningful = layersPanelBox.width > 200 && layersPanelBox.height > 200;
  const mapBeforeHandle = map.x + map.width <= inspectorResize.x + tolerance;
  const handleBeforeInspector = inspectorResize.x + inspectorResize.width <= inspector.x + tolerance;
  const inspectorInViewport = inspector.x + inspector.width <= viewport.width + tolerance;
  if (!panelInsideInspector || !panelMeaningful || !mapBeforeHandle || !handleBeforeInspector || !inspectorInViewport) {
    throw new Error(`Docked layout geometry mismatch: ${JSON.stringify({ inspector, inspectorResize, map, layersPanel: layersPanelBox, viewport, tolerance })}`);
  }
}

async function captureWorkbenchScreenshot(page: Page, testInfo: TestInfo, name: string, targets: readonly Locator[]): Promise<void> {
  await waitForStableWorkbench(page, targets);
  const map = mapLocator(page);
  if (await map.isVisible()) await waitForRenderedMap(map);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function waitForStableWorkbench(page: Page, targets: readonly Locator[]): Promise<void> {
  const workspace = page.locator('[data-chat-collapsed]');
  const affected = [workspace, ...targets];
  await expect.poll(async () => {
    const before = await visualState(affected);
    await page.evaluate(async () => await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    return JSON.stringify(before) === JSON.stringify(await visualState(affected));
  }).toBe(true);
}

async function visualState(targets: readonly Locator[]): Promise<Array<{ height: number; opacity: string; transform: string; width: number; x: number; y: number } | null>> {
  return await Promise.all(targets.map(async (target) => {
    const box = await target.boundingBox();
    if (!box) return null;
    const style = await target.evaluate((element) => {
      const computed = getComputedStyle(element);
      return { opacity: computed.opacity, transform: computed.transform };
    });
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height), ...style };
  }));
}
