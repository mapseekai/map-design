import { expect, it } from 'vitest';
import { MapScreenshotInputSchema, MapScreenshotSchema } from '../src/api/map-screenshots.js';
import { StartMapDesignRunRequestSchema } from '../src/api/runs.js';

const input = { pngBase64: 'AAAA', draftRevision: 1, styleHash: 'a'.repeat(64), width: 800, height: 600,
  viewport: { center: [120, 30], zoom: 10, bearing: 0, pitch: 0 } };

it('bounds image and viewport inputs and accepts only PNG base64 payloads', () => {
  expect(MapScreenshotInputSchema.safeParse(input).success).toBe(true);
  for (const change of [{ width: 0 }, { height: 9000 }, { pngBase64: 'https://example.com/a.png' },
    { viewport: { ...input.viewport, center: [181, 0] } }]) {
    expect(MapScreenshotInputSchema.safeParse({ ...input, ...change }).success).toBe(false);
  }
});

it('validates a near-limit base64 payload without overflowing the regex stack', () => {
  const pngBase64 = 'A'.repeat(5_592_404);
  expect(MapScreenshotInputSchema.safeParse({ ...input, pngBase64 }).success).toBe(true);
  expect(MapScreenshotInputSchema.safeParse({ ...input, pngBase64: pngBase64.slice(0, -1) + '!' }).success).toBe(false);
});

it('run screenshot references accept bounded unique digests, not client-supplied files or URLs', () => {
  const request = { projectId: 'p', conversationId: 'c', prompt: 'fix this', runtimeRevision: 0,
    clientRequestId: 'r', userMessageId: 'u', assistantMessageId: 'a', screenshotIds: ['b'.repeat(64)] };
  expect(StartMapDesignRunRequestSchema.parse(request).screenshotIds).toEqual(request.screenshotIds);
  for (const ids of [['../secret'], [request.screenshotIds[0], request.screenshotIds[0]], Array.from({ length: 5 }, (_, i) => String(i).repeat(64))]) {
    expect(StartMapDesignRunRequestSchema.safeParse({ ...request, screenshotIds: ids }).success).toBe(false);
  }
  expect(MapScreenshotSchema.safeParse({ ...input, pngBase64: undefined, id: 'b'.repeat(64), projectId: 'p', capturedAt: new Date().toISOString() }).success).toBe(false);
});
