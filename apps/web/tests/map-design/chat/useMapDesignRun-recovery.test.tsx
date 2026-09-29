// @vitest-environment jsdom
import type { MapDesignConversationResponse, MapDesignMessage, MapDesignRunResponse } from "@mapseekai/contracts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMapDesignRun } from "../../../src/map-design/chat/useMapDesignRun";

const run: MapDesignRunResponse = { runId: "existing-run", projectId: "map-1", conversationId: "conversation-1", status: "running" };
const message: MapDesignMessage = { id: "assistant-1", conversationId: "conversation-1", role: "assistant", content: "Completed while away", events: [], runStatus: "succeeded", startedAt: 1, endedAt: 2 };
const snapshot: MapDesignConversationResponse = { id: "conversation-1", projectId: "map-1", createdAt: "", updatedAt: "", messages: [], activeRun: run };
const options = { projectId: "map-1", conversationId: "conversation-1", runtime: { revision: 0, agentId: "codex" } };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
function sse(events: unknown[]) {
  return new Response(new ReadableStream({ start(controller) {
    for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    controller.close();
  } }));
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("map run recovery", () => {
  it("blocks new sends until a matching daemon snapshot is loaded", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const initialProps: { conversation: MapDesignConversationResponse | null } = { conversation: null };
    const hook = renderHook(({ conversation }: { conversation: MapDesignConversationResponse | null }) =>
      useMapDesignRun({ ...options, conversation }), { initialProps });
    expect(hook.result.current.ready).toBe(false);
    await act(async () => { expect(await hook.result.current.send("Do not duplicate")).toBe(false); });
    expect(fetch).not.toHaveBeenCalled();
    hook.rerender({ conversation: { ...snapshot, activeRun: null } });
    expect(hook.result.current.ready).toBe(true);
  });

  it("reconnects the accepted run after remount and restores cancel without starting a second run", async () => {
    let signal: AbortSignal | null | undefined;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/events")) {
        signal = init?.signal;
        return new Response(new ReadableStream());
      }
      if (String(input).endsWith("/cancel")) return json({ runId: run.runId, status: "canceled" });
      return json({ ...snapshot, activeRun: null, messages: [{ ...message, runStatus: "canceled" }] });
    });
    const first = renderHook(() => useMapDesignRun({ ...options, conversation: snapshot }));
    await waitFor(() => expect(first.result.current.sending).toBe(true));
    first.unmount();
    expect(signal?.aborted).toBe(true);
    const second = renderHook(() => useMapDesignRun({ ...options, conversation: snapshot }));
    expect(second.result.current.runId).toBe(run.runId);
    expect(second.result.current.ready).toBe(false);
    await act(async () => { await second.result.current.cancel(); });
    expect(second.result.current.status).toBe("canceled");
    expect(second.result.current.ready).toBe(true);
    expect(second.result.current.messages[0]?.content).toBe(message.content);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/events"))).toHaveLength(2);
    expect(fetch.mock.calls.some(([url]) => String(url) === "/api/runs")).toBe(false);
  });

  it("accepts terminal replay when the run finishes between discovery and subscription", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sse([
      { type: "message_completed", runId: run.runId, message },
      { type: "run_finished", run: { ...run, status: "succeeded" } },
    ]));
    const { result } = renderHook(() => useMapDesignRun({ ...options, conversation: snapshot }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.status).toBe("succeeded");
    expect(result.current.messages).toEqual([message]);
  });

  it.each(["failed", "canceled", "succeeded"] as const)("restores %s when completion happened while absent", (status) => {
    const { result } = renderHook(() => useMapDesignRun({ ...options,
      conversation: { ...snapshot, activeRun: null, messages: [{ ...message, runStatus: status }] } }));
    expect(result.current.status).toBe(status);
    expect(result.current.ready).toBe(true);
  });

  it("aborts the old stream on scope change and waits for the new scope snapshot", async () => {
    let signal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      signal = init?.signal;
      return new Response(new ReadableStream());
    });
    const { result, rerender } = renderHook(({ projectId }) =>
      useMapDesignRun({ ...options, projectId, conversation: snapshot }), { initialProps: { projectId: "map-1" } });
    await waitFor(() => expect(result.current.sending).toBe(true));
    rerender({ projectId: "map-2" });
    expect(signal?.aborted).toBe(true);
    expect(result.current.runId).toBeNull();
    expect(result.current.ready).toBe(false);
  });

  it("uses the queue identity for retry receipts and acknowledges accepted requests after unmount", async () => {
    let resolve: (response: Response) => void = () => { throw new Error("not started"); };
    let posted: unknown;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input) !== "/api/runs") return Promise.resolve(json({ ...snapshot, activeRun: null }));
      posted = JSON.parse(String(init?.body));
      return new Promise<Response>((done) => { resolve = done; });
    });
    const { result, unmount } = renderHook(() => useMapDesignRun({ ...options, conversation: { ...snapshot, activeRun: null } }));
    let request: Promise<boolean>;
    await act(async () => { request = result.current.send("Queued", undefined, undefined, undefined, "queue-id"); await Promise.resolve(); });
    unmount();
    resolve(json(run));
    expect(await request!).toBe(true);
    expect(posted).toMatchObject({ clientRequestId: "map-run-queue-id", userMessageId: "map-user-queue-id", assistantMessageId: "map-assistant-queue-id" });
  });
  it("acknowledges an uncertain accepted request after remount and runtime change without reposting it", async () => {
    const acceptedUser: MapDesignMessage = { ...message, id: "map-user-stable-id", role: "user", runtime: undefined, content: "Queued" };
    let accepted = false;
    const posts: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "/api/runs") {
        posts.push(JSON.parse(String(init?.body)));
        accepted = true;
        throw new TypeError("response lost");
      }
      return json({ ...snapshot, activeRun: null, messages: accepted ? [acceptedUser, message] : [] });
    });
    const first = renderHook(() => useMapDesignRun({ ...options, conversation: { ...snapshot, activeRun: null } }));
    await act(async () => { expect(await first.result.current.send("Queued", undefined, undefined, undefined, "stable-id")).toBe(false); });
    first.unmount();
    const second = renderHook(() => useMapDesignRun({ ...options, runtime: { revision: 2, agentId: "codex" },
      conversation: { ...snapshot, activeRun: null, messages: [acceptedUser, message] } }));
    await act(async () => { expect(await second.result.current.send("Queued", undefined, undefined, undefined, "stable-id")).toBe(true); });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ runtimeRevision: 0, clientRequestId: "map-run-stable-id" });
    expect(second.result.current.messages).toEqual([acceptedUser, message]);
  });

  it("retries a definitively rejected queue request with the updated runtime revision", async () => {
    const posts: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "/api/runs") {
        posts.push(JSON.parse(String(init?.body)));
        return posts.length === 1
          ? new Response(JSON.stringify({ error: { code: "RUNTIME_CONFLICT", message: "changed" } }), { status: 409 })
          : json(run);
      }
      if (String(input).endsWith("/events")) return sse([{ type: "run_finished", run: { ...run, status: "succeeded" } }]);
      return json({ ...snapshot, activeRun: null });
    });
    const { result, rerender } = renderHook(({ revision }) => useMapDesignRun({ ...options,
      runtime: { revision, agentId: "codex" }, conversation: { ...snapshot, activeRun: null } }), { initialProps: { revision: 0 } });
    await act(async () => { expect(await result.current.send("Queued", undefined, undefined, undefined, "stable-id")).toBe(false); });
    rerender({ revision: 2 });
    await act(async () => { expect(await result.current.send("Queued", undefined, undefined, undefined, "stable-id")).toBe(true); });
    expect(posts).toEqual([expect.objectContaining({ runtimeRevision: 0 }), expect.objectContaining({ runtimeRevision: 2 })]);
  });

});
