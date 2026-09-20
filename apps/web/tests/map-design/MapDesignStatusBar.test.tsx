// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MapDesignStatusBar } from '../../src/map-design/components/MapDesignStatusBar';

afterEach(cleanup);

describe('MapDesignStatusBar', () => {
  it('renders projection, scale, draft, sync, and coordinates in one status region', () => {
    render(<MapDesignStatusBar projection="EPSG:3857" scale="1:25,000" draftRevision={4} synced
      coordinates="38.889°N, 77.035°W" />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('EPSG:3857');
    expect(status).toHaveTextContent('1:25,000');
    expect(status).toHaveTextContent('Draft 4');
    expect(status).toHaveTextContent('Synced');
    expect(status).toHaveTextContent('38.889°N, 77.035°W');
  });

  it('announces coordinates only during keyboard map navigation', () => {
    const view = render(<MapDesignStatusBar projection="EPSG:3857" scale="1:25,000" draftRevision={4} synced
      coordinates="38.889°N, 77.035°W" keyboardNavigationActive={false} />);
    expect(screen.getByText('38.889°N, 77.035°W')).toHaveAttribute('aria-live', 'off');

    view.rerender(<MapDesignStatusBar projection="EPSG:3857" scale="1:25,000" draftRevision={4} synced
      coordinates="38.889°N, 77.035°W" keyboardNavigationActive />);
    expect(screen.getByText('38.889°N, 77.035°W')).toHaveAttribute('aria-live', 'polite');
  });
});
