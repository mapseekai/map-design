// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "../../src/i18n";
import { RecentMapProjects } from "../../src/map-design/components/RecentMapProjects";
import { useMapDesignProjects } from "../../src/map-design/hooks/useMapDesignProjects";

const project = { projectId: "p", title: "Map", lifecycle: "failed", sourceKind: "style", draftRevision: 0,
  committedRevision: null, validationStatus: "unknown", updatedAt: "2026-09-22T00:00:00Z" } as const;
let loadFails = false;
beforeEach(() => {
  loadFails = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    if (loadFails || init?.method) return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Raw server detail" } }), { status: 500 });
    return new Response(JSON.stringify({ projects: [project] }));
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function Projects() {
  const projects = useMapDesignProjects();
  const { setLocale } = useI18n();
  return <><button onClick={() => setLocale("zh-CN")}>Chinese</button>
    <button onClick={() => projects.remove("p")}>Remove</button><button onClick={() => projects.retry("p")}>Retry</button>
    <RecentMapProjects {...projects} onOpenProject={vi.fn()} onDeleteProject={projects.remove} onRetryProject={projects.retry} /></>;
}
it.each([["Remove", "无法删除项目，请重试。"], ["Retry", "无法重试导入，请重试。"]])("localizes a rejected %s when the locale changes", async (action, expected) => {
  render(<I18nProvider initial="en"><Projects /></I18nProvider>);
  await screen.findByText("Map");
  fireEvent.click(screen.getByRole("button", { name: action }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Chinese" }));
  expect(screen.getByRole("alert")).toHaveTextContent(expected);
  expect(screen.getByRole("alert")).not.toHaveTextContent("Raw server detail");
});
it("localizes a project-list failure without displaying server prose", async () => {
  loadFails = true;
  render(<I18nProvider initial="zh-CN"><Projects /></I18nProvider>);
  expect(await screen.findByRole("alert")).toHaveTextContent("无法加载项目，请重试。");
});
