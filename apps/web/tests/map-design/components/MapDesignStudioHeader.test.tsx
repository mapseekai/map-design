// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MapDesignStudioHeader } from '../../../src/map-design/components/MapDesignStudioHeader';
afterEach(cleanup);
it('switches between preview and code independently from the inspector tabs', () => {
  const change = vi.fn();
  render(<MapDesignStudioHeader title="Test map" draftRevision={1} mode="map" fullscreen={false}
    inspectorOpen={false} inspectorId="inspector" onModeChange={vi.fn()} onToggleFullscreen={vi.fn()}
    viewMode="preview" onViewModeChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: 'Code' }));
  expect(change).toHaveBeenCalledWith('code');
  expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true');
});
it('keeps comment, edit and screenshot actions before layers inside the header', () => {
  render(<MapDesignStudioHeader title="Test map" draftRevision={1} mode="map" fullscreen={false}
    inspectorOpen={false} inspectorId="inspector" onModeChange={vi.fn()} onToggleFullscreen={vi.fn()}
    actions={<><button>Comments</button><button>Edit style</button><button>Screenshot</button></>} />);
  const buttons = [...screen.getByRole('banner').querySelectorAll('button')].map((button) => button.textContent);
  expect(buttons.slice(buttons.indexOf('Layers') - 3, buttons.indexOf('Layers'))).toEqual(['Comments', 'Edit style', 'Screenshot']);
});
