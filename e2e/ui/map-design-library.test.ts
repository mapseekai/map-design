import { expect, test } from "@/playwright/suite";

// Exercise the library through the real daemon with local input, independent of
// public tile servers and model credentials.
test("[P1] imports a style, reviews and downloads a specification, applies it and deletes it", async ({ page }) => {
  test.setTimeout(120_000);
  const name = `Library acceptance ${crypto.randomUUID()}`;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/cartographies", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Add specification", exact: true }).click();
  await page.getByRole("tab", { name: "Create from style", exact: true }).click();
  await page.getByRole("textbox", { name: "Specification name", exact: true }).fill(name);
  await page.locator('input[type="file"]').setInputFiles({
    name: "style.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ version: 8, sources: {}, layers: [
      { id: "background", type: "background", paint: { "background-color": "#123456" } },
    ] })),
  });
  await page.getByRole("textbox", { name: "Description", exact: true }).fill("Local style import acceptance");
  await page.getByRole("button", { name: "Generate draft", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "CARTOGRAPHY.md", exact: true })).toHaveValue(new RegExp(name));
  for (const filename of ["CARTOGRAPHY.md", "INIT_REPORT.md", "INIT_REPORT.json"]) {
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: `Download ${filename}`, exact: true }).click();
    expect((await download).suggestedFilename()).toBe(filename);
  }
  await page.getByRole("button", { name: "Save to library", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.getByRole("region", { name, exact: true })).toContainText("#123456");
  await page.getByRole("button", { name: "Sample map", exact: true }).click();
  await expect(page.getByRole("region", { name: "Sample map", exact: true }).getByRole("region", { name: "Map", exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("CARTOGRAPHY.md");
  await page.getByRole("link", { name: "Use in workbench →", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Map design system", exact: true })).toContainText(name);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("combobox", { name: "Map design system", exact: true })).toContainText(name);
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Design specifications", exact: true }).click();
  await page.getByRole("button", { name: `Preview specification: ${name}`, exact: true }).click();
  await page.getByRole("button", { name: `Delete: ${name}`, exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Delete: ${name}`, exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: `Preview specification: ${name}`, exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("[P1] mobile map resource errors leave the wrapped toolbar reachable", async ({ page, toolsDev }) => {
  test.setTimeout(120_000);
  const { createAndOpenReadyMapProject } = await import("@/playwright/map-design-project");
  const projectId = await createAndOpenReadyMapProject(page, toolsDev.daemonUrl!);
  await page.route(url => url.hostname === 'demotiles.maplibre.org' || url.pathname.startsWith(`/api/map-design/projects/${projectId}/resources/`), route => route.fulfill({
    status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "RESOURCE_ERROR" } }),
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Map", exact: true }).click();
  const canvas = page.getByRole("region", { name: "Map canvas", exact: true });
  await expect(canvas.getByRole("alert")).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(async () => canvas.locator("header").evaluate(header => {
      const bounds = header.getBoundingClientRect();
      return [...header.querySelectorAll("button")].every(button => {
        const rect = button.getBoundingClientRect();
        return rect.left >= bounds.left && rect.right <= bounds.right && rect.bottom <= bounds.bottom;
      });
    })).toBe(true);
    const header = await canvas.locator("header").boundingBox();
    const alert = await canvas.getByRole("alert").boundingBox();
    expect(alert!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
    await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
    await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
    await page.getByRole("button", { name: "Layers", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Map inspector", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close inspector", exact: true }).click();
  }
});
