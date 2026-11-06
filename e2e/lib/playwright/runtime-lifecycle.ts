import type { ConsoleMessage, Page, Request, Response as PlaywrightResponse } from '@playwright/test';

// Reserve an extra minute beyond start + web/daemon warmup + stop budgets so
// Playwright can finish fixture bookkeeping without cutting teardown short.
// Budgets: 180s start + 60s daemon warmup + 180s browser navigation + 120s
// App mount + 30s stop + 60s bookkeeping = 630s.
export const PLAYWRIGHT_TOOLS_DEV_FIXTURE_TIMEOUT_MS = 630_000;
export const PLAYWRIGHT_WEB_NAVIGATION_WARMUP_TIMEOUT_MS = 180_000;
export const PLAYWRIGHT_WEB_MOUNT_WARMUP_TIMEOUT_MS = 120_000;
export const PLAYWRIGHT_DAEMON_WARMUP_TIMEOUT_MS = 60_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type WebWarmupDiagnostics = {
  console: string[];
  pageErrors: string[];
  requestFailures: string[];
  scriptResponses: string[];
};

type WebWarmupSnapshot = {
  loadingShellCount: number;
  loadingShellText: string[];
  mounted: string | null;
  readyState: string;
  scriptSources: string[];
  url: string;
};

type WebWarmupPhase = 'navigation' | 'mount';

export async function warmPlaywrightWebRuntime(
  page: Page,
  url: string,
  options: {
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const navigationTimeoutMs = options.timeoutMs
    ?? PLAYWRIGHT_WEB_NAVIGATION_WARMUP_TIMEOUT_MS;
  const mountTimeoutMs = options.timeoutMs
    ?? PLAYWRIGHT_WEB_MOUNT_WARMUP_TIMEOUT_MS;
  const diagnostics: WebWarmupDiagnostics = {
    console: [],
    pageErrors: [],
    requestFailures: [],
    scriptResponses: [],
  };
  const record = (target: string[], value: string) => {
    if (target.length < 20) target.push(value);
  };
  const onConsole = (message: ConsoleMessage) => {
    record(diagnostics.console, `[${message.type()}] ${message.text()}`);
  };
  const onPageError = (error: Error) => {
    record(diagnostics.pageErrors, error.stack ?? error.message);
  };
  const onRequestFailed = (request: Request) => {
    if (request.resourceType() === 'script') {
      record(
        diagnostics.requestFailures,
        `${request.url()} (${request.failure()?.errorText ?? 'unknown failure'})`,
      );
    }
  };
  const onResponse = (response: PlaywrightResponse) => {
    if (response.request().resourceType() === 'script') {
      record(diagnostics.scriptResponses, `${response.url()} status=${response.status()}`);
    }
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);

  let navigationSucceeded = false;
  let phase: WebWarmupPhase = 'navigation';
  try {
    const navigationDeadline = Date.now() + navigationTimeoutMs;
    const response = await page.goto(url, {
      timeout: remainingWarmupTime(navigationDeadline),
      waitUntil: 'domcontentloaded',
    });
    if (response == null || !response.ok()) {
      throw new Error(
        `navigation returned ${response == null ? 'no response' : `${response.status()} ${response.statusText()}`}`,
      );
    }
    navigationSucceeded = true;
    phase = 'mount';
    const mountDeadline = Date.now() + mountTimeoutMs;
    await page.waitForFunction(
      () => document.documentElement.dataset.mapDesignAppMounted === '1'
        && document.querySelectorAll('.map-design-loading-shell').length === 0,
      undefined,
      { timeout: remainingWarmupTime(mountDeadline) },
    );
    if (diagnostics.pageErrors.length > 0) {
      throw new Error('page raised an uncaught exception during browser warmup');
    }
  } catch (error) {
    const snapshot = await readWebWarmupSnapshot(page);
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    // Playwright's polling timeout and the browser's final readiness mutation
    // can be delivered on adjacent event-loop turns. The DOM snapshot is the
    // authoritative oracle, so do not fail a navigation that is demonstrably
    // ready by the time timeout diagnostics are collected.
    if (
      timedOut
      && phase === 'mount'
      && navigationSucceeded
      && diagnostics.pageErrors.length === 0
      && isWebWarmupSnapshotReady(snapshot)
    ) return;
    const phaseTimeoutMs = phase === 'navigation'
      ? navigationTimeoutMs
      : mountTimeoutMs;
    throw new Error(
      formatWebWarmupFailure(phase, timedOut, phaseTimeoutMs, error, snapshot, diagnostics),
      { cause: error },
    );
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('requestfailed', onRequestFailed);
    page.off('response', onResponse);
  }
}

function isWebWarmupSnapshotReady(snapshot: WebWarmupSnapshot | null): boolean {
  return snapshot?.mounted === '1' && snapshot.loadingShellCount === 0;
}

function remainingWarmupTime(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function readWebWarmupSnapshot(page: Page): Promise<WebWarmupSnapshot | null> {
  try {
    return await page.evaluate(() => ({
      loadingShellCount: document.querySelectorAll('.map-design-loading-shell').length,
      loadingShellText: Array.from(document.querySelectorAll('.map-design-loading-shell'))
        .map((node) => node.textContent?.trim() ?? ''),
      mounted: document.documentElement.getAttribute('data-map-design-app-mounted'),
      readyState: document.readyState,
      scriptSources: Array.from(document.scripts)
        .map((script) => script.src)
        .filter((source) => source.length > 0),
      url: window.location.href,
    }));
  } catch {
    return null;
  }
}

function formatWebWarmupFailure(
  phase: WebWarmupPhase,
  timedOut: boolean,
  timeoutMs: number,
  error: unknown,
  snapshot: WebWarmupSnapshot | null,
  diagnostics: WebWarmupDiagnostics,
): string {
  const phaseLabel = phase === 'navigation' ? 'browser navigation' : 'App mount';
  const summary = `Playwright ${phaseLabel} ${timedOut ? `timed out after ${timeoutMs}ms` : 'failed'}`;
  const cause = error instanceof Error ? error.message : String(error);
  const pageState = snapshot == null
    ? 'unavailable'
    : JSON.stringify(snapshot);
  return [
    `${summary}: ${cause}`,
    `phase: ${phase}`,
    `page state: ${pageState}`,
    `script responses: ${diagnostics.scriptResponses.join(' | ') || 'none'}`,
    `request failures: ${diagnostics.requestFailures.join(' | ') || 'none'}`,
    `console: ${diagnostics.console.join(' | ') || 'none'}`,
    `page errors: ${diagnostics.pageErrors.join(' | ') || 'none'}`,
  ].join('\n');
}

/**
 * Block the Playwright worker until the daemon HTTP surface can serve
 * `/api/health`. The suite previously only warmed the web HTML shell, so the
 * first API-backed action in a worker (usually `POST /api/projects`) raced
 * daemon listen readiness and each call site invented its own retry loop.
 */
export async function warmPlaywrightDaemonRuntime(
  healthUrl: string,
  options: {
    fetch?: FetchLike;
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<void> {
  const fetchRuntime = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? PLAYWRIGHT_DAEMON_WARMUP_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetchRuntime(healthUrl, {
        signal: AbortSignal.timeout(Math.max(250, Math.min(2_000, deadline - Date.now()))),
      });
      if (response.ok) {
        // Drain the body so keep-alive sockets stay reusable under Node fetch.
        // Body-drain failures must retry — a truncated 2xx is not readiness.
        await response.arrayBuffer();
        return;
      }
      // Consume non-OK bodies so repeated 503 probes do not leave streams open.
      await response.arrayBuffer().catch(() => undefined);
      lastError = new Error(
        `Playwright daemon warmup failed with ${response.status} ${response.statusText}`,
      );
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  throw new Error(`Playwright daemon warmup timed out after ${timeoutMs}ms`, {
    cause: lastError,
  });
}
