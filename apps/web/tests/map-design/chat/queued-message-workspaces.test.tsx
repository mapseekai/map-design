// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapDesignRunStatus, MapScreenshot, MapTextAttachment } from "@mapseekai/contracts";
import { WorkspaceTabsProvider } from "../../../src/map-design/WorkspaceTabs";
import { useQueuedMapMessages, type PendingMapMessage } from "../../../src/map-design/chat/useQueuedMapMessages";

afterEach(cleanup);
const screenshot: MapScreenshot = { id: "a".repeat(64), projectId: "a", capturedAt: "2026-01-01T00:00:00Z", draftRevision: 1,
  styleHash: "b".repeat(64), width: 100, height: 100, viewport: { center: [0, 0], zoom: 3, bearing: 0, pitch: 0 } };
const attachment: MapTextAttachment = { id: "c".repeat(64), projectId: "a", fileName: "notes.txt", mediaType: "text/plain",
  byteLength: 10, createdAt: "2026-01-01T00:00:00Z" };
type Queue = ReturnType<typeof useQueuedMapMessages>;
type Options = { sending: boolean; ready: boolean; status: MapDesignRunStatus | "idle"; blocked: boolean; send(message: PendingMapMessage): Promise<boolean> };
function scenario(send: Options["send"]) {
  let current: Queue | undefined;
  let route = "a";
  let conversationId = "one";
  let options: Options = { sending: true, ready: false, status: "running", blocked: false, send };
  function Probe({ projectId }: { projectId: string }) {
    current = useQueuedMapMessages({ ...options, projectId, conversationId });
    return <p>{current.items.map(item => item.prompt).join(",")}</p>;
  }
  function Harness() {
    return <StrictMode><WorkspaceTabsProvider route={route === "settings" ? { kind: "settings" } : { kind: "project", projectId: route }}>
      {route === "settings" ? null : <Probe key={route + conversationId} projectId={route} />}
    </WorkspaceTabsProvider></StrictMode>;
  }
  const view = render(<Harness />);
  return {
    queue() { if (!current) throw new Error("Queue missing"); return current; },
    navigate(next: string, conversation = "one") { route = next; conversationId = conversation; view.rerender(<Harness />); },
    update(next: Partial<Options>) { options = { ...options, ...next }; view.rerender(<Harness />); },
  };
}

describe("queued messages across workspace navigation", () => {
  it("retains FIFO content, screenshot and attachment references in the owning project and conversation", async () => {
    const send = vi.fn(async (_message: PendingMapMessage) => true);
    const test = scenario(send);
    act(() => { test.queue().enqueue("First", [screenshot], [attachment]); test.queue().enqueue("Second"); });
    const original = test.queue().items;
    test.navigate("b");
    expect(test.queue().items).toEqual([]);
    act(() => test.queue().enqueue("Other project"));
    test.navigate("a", "two");
    expect(test.queue().items).toEqual([]);
    test.navigate("settings");
    test.navigate("a");
    expect(test.queue().items).toEqual(original);
    expect(send).not.toHaveBeenCalled();
    test.update({ sending: false, ready: true, status: "succeeded" });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.map(([message]) => message)).toEqual(original);
  });

  it.each(["failed", "canceled"] as const)("keeps a %s queue paused after returning until explicit resume", async status => {
    const send = vi.fn(async (_message: PendingMapMessage) => true);
    const test = scenario(send);
    act(() => test.queue().enqueue("Keep pending"));
    test.update({ sending: false, ready: true, status });
    test.navigate("settings");
    test.navigate("a");
    expect(test.queue().paused).toBe(true);
    expect(test.queue().items).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
    act(() => test.queue().resume());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it("keeps retry identity for unchanged content and renews it for edited content across remount", async () => {
    const send = vi.fn(async (_message: PendingMapMessage) => false);
    const test = scenario(send);
    act(() => test.queue().enqueue("Original prompt"));
    test.update({ sending: false, ready: true, status: "idle" });
    await waitFor(() => expect(test.queue().paused).toBe(true));
    const original = test.queue().items[0];
    if (!original) throw new Error("Pending message missing");
    expect(original.requestId).toEqual(expect.any(String));
    act(() => { test.queue().edit(original.id); test.queue().save(original.id, " Original prompt "); });
    expect(test.queue().items[0]?.requestId).toBe(original.requestId);
    test.navigate("settings");
    test.navigate("a");
    expect(test.queue().items[0]?.requestId).toBe(original.requestId);
    act(() => { test.queue().edit(original.id); test.queue().save(original.id, "Changed prompt"); });
    const edited = test.queue().items[0];
    if (!edited) throw new Error("Edited message missing");
    expect(edited.id).toBe(original.id);
    expect(edited.requestId).not.toBe(original.requestId);
    test.navigate("settings");
    test.navigate("a");
    expect(test.queue().items[0]).toEqual(edited);
    act(() => test.queue().resume());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]?.[0]).toEqual(edited);
  });

  it("holds a retained queue until run discovery completes and pauses a failure discovered after return", () => {
    const send = vi.fn(async (_message: PendingMapMessage) => true);
    const test = scenario(send);
    act(() => test.queue().enqueue("Wait for server"));
    test.navigate("settings");
    test.update({ sending: false, ready: false, status: "idle" });
    test.navigate("a");
    expect(test.queue().items).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
    test.update({ ready: true, status: "failed" });
    expect(test.queue().paused).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("applies acceptance while the workspace stays unmounted and preserves the remaining queue", async () => {
    let finish: (accepted: boolean) => void = () => undefined;
    const send = vi.fn((_message: PendingMapMessage) => new Promise<boolean>(resolve => { finish = resolve; }));
    const test = scenario(send);
    act(() => { test.queue().enqueue("Accepted"); test.queue().enqueue("Next"); });
    test.update({ sending: false, ready: true, status: "idle" });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    test.navigate("settings");
    await act(async () => finish(true));
    test.update({ sending: true, ready: false, status: "running" });
    test.navigate("a");
    expect(test.queue().items.map(item => item.prompt)).toEqual(["Next"]);
    expect(test.queue().submittingId).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("records an in-flight acknowledgement (%s) after unmount and never sends it twice on remount", async accepted => {
    let finish: (accepted: boolean) => void = () => undefined;
    const send = vi.fn((_message: PendingMapMessage) => new Promise<boolean>(resolve => { finish = resolve; }));
    const test = scenario(send);
    act(() => test.queue().enqueue("In flight"));
    test.update({ sending: false, ready: true, status: "idle" });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const id = test.queue().items[0]?.id;
    test.navigate("settings");
    test.navigate("a");
    expect(test.queue().submittingId).toBe(id);
    await act(async () => finish(accepted));
    expect(send).toHaveBeenCalledTimes(1);
    expect(test.queue().items).toHaveLength(accepted ? 0 : 1);
    expect(test.queue().submittingId).toBeNull();
    expect(test.queue().paused).toBe(!accepted);
  });
});
