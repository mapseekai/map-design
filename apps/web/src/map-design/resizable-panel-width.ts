export function resizablePanelWidth(group: HTMLElement, percentage: number): number {
  const availableWidth = Array.from(group.children)
    .filter((child): child is HTMLElement => child instanceof HTMLElement && child.getAttribute('data-slot') === 'resizable-panel')
    .reduce((total, panel) => total + panel.offsetWidth, 0);
  return availableWidth * percentage / 100;
}
