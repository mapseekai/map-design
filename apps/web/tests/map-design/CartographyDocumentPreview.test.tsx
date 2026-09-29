// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as markdown from '../../src/runtime/markdown';
import { I18nProvider } from '../../src/i18n';
import { CartographyDocumentPreview } from '../../src/map-design/components/CartographyDocumentPreview';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('defaults to formatted Markdown while keeping complete frontmatter in Source', () => {
  const source = '---\nname: Atlas\n---\n## Visual identity\n\nUse **clear labels**.\n\n- Water\n- Roads';
  render(<I18nProvider><CartographyDocumentPreview source={source} /></I18nProvider>);
  expect(screen.getByRole('heading', { name: 'Visual identity' })).toBeInTheDocument();
  expect(screen.getByText('clear labels').tagName).toBe('STRONG');
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.queryByText('name: Atlas')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  expect(screen.getByLabelText('Source')).toHaveTextContent('name: Atlas');
});
it('does not inject HTML or fetch linked images', () => {
  const { container } = render(<I18nProvider><CartographyDocumentPreview source={'<script>alert(1)</script>\n\n![Remote](https://example.com/image.png)'} /></I18nProvider>);
  expect(container.querySelectorAll('script, img')).toHaveLength(0);
  expect(screen.getByRole('link', { name: 'Remote' })).toBeInTheDocument();
});
it("renders resolved palette values in prose, inline code and tables while keeping Source unchanged", () => {
  const source = '---\ncolors:\n  water: "#336699"\n---\n## Colors\n\nWater uses {colors.water}; alias `{colors.halo}`.\n\n| Token | Value |\n| --- | --- |\n| Accent | {colors.accent} |\n\nUnknown {colors.missing}.';
  const palette = [
    { name: "water", color: "#336699" },
    { name: "halo", color: "#ffffff" },
    { name: "accent", color: "hsl(20, 40%, 60%)" },
  ];
  render(<I18nProvider><CartographyDocumentPreview source={source} palette={palette} /></I18nProvider>);
  const preview = screen.getByLabelText("Preview specification");
  expect(preview).toHaveTextContent("Water uses #336699");
  expect(preview).toHaveTextContent("#ffffff");
  expect(preview).toHaveTextContent("hsl(20, 40%, 60%)");
  expect(preview).toHaveTextContent("{colors.missing}");
  expect(preview).not.toHaveTextContent("{colors.water}");
  expect(preview.querySelectorAll("[data-ui=md-color-swatch]")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  expect(screen.getByLabelText("Source").textContent).toBe(source);
});
it("does not mount formatted content before the document is opened", () => {
  const source = '## Deferred title\n\n```json\n{"color": "{colors.water}"}\n```';
  const { container } = render(<I18nProvider><CartographyDocumentPreview source={source} initiallyOpen={false} /></I18nProvider>);
  expect(container.querySelector("h2")).toBeNull();
  expect(container.querySelector("[data-ui=md-code-block]")).toBeNull();
  const details = container.querySelector("details");
  if (!details) throw new Error("Expected document disclosure");
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(screen.getByRole("heading", { name: "Deferred title" })).toBeInTheDocument();
});
it('reuses parsed Markdown when the parent rerenders unchanged document props', () => {
  const parse = vi.spyOn(markdown, 'renderMarkdown');
  const palette = [{ name: 'water', color: '#336699' }];
  const source = '## Colors\n\n{colors.water}';
  const { rerender } = render(<CartographyDocumentPreview source={source} palette={palette} />);
  expect(parse).toHaveBeenCalledTimes(1);
  rerender(<CartographyDocumentPreview source={source} palette={palette} />);
  expect(parse).toHaveBeenCalledTimes(1);
  rerender(<CartographyDocumentPreview source={source} palette={palette.map(color => ({ ...color }))} />);
  expect(parse).toHaveBeenCalledTimes(1);
});
it("updates rendered colors when the document palette changes", () => {
  const source = "## Colors\n\n{colors.water}";
  const { rerender } = render(<CartographyDocumentPreview source={source} palette={[{ name: "water", color: "#112233" }]} />);
  expect(screen.getByLabelText("Preview specification")).toHaveTextContent("#112233");
  rerender(<CartographyDocumentPreview source={source} palette={[{ name: "water", color: "#445566" }]} />);
  expect(screen.getByLabelText("Preview specification")).toHaveTextContent("#445566");
});
