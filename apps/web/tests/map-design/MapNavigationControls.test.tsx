// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../src/i18n';
import {
  MapNavigationControls,
  type MapNavigationControlMap,
} from '../../src/map-design/components/MapNavigationControls';

function createMap(zoom = 11): MapNavigationControlMap {
  return {
    flyTo: vi.fn(),
    getZoom: () => zoom,
    resetNorth: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
  };
}

describe('MapNavigationControls', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('calls each retained map navigation operation from native focusable buttons', () => {
    const map = createMap();
    render(<MapNavigationControls map={map} />);

    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    zoomIn.focus();
    expect(zoomIn).toHaveFocus();
    fireEvent.click(zoomIn);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset compass to north' }));

    expect(map.zoomIn).toHaveBeenCalledExactlyOnceWith({ essential: false });
    expect(map.zoomOut).toHaveBeenCalledExactlyOnceWith({ essential: false });
    expect(map.resetNorth).toHaveBeenCalledExactlyOnceWith({ essential: false });
  });

  it('flies to a successful geolocation without zooming out and announces completion', () => {
    const map = createMap(16);
    const getCurrentPosition = vi.fn((success: PositionCallback) => {
      success({ coords: { latitude: 48.137, longitude: 11.575 } } as GeolocationPosition);
    });
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
    render(<MapNavigationControls map={map} />);

    fireEvent.click(screen.getByRole('button', { name: 'Locate me' }));

    expect(getCurrentPosition).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      expect.any(Function),
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 10_000 },
    );
    expect(map.flyTo).toHaveBeenCalledExactlyOnceWith({
      center: [11.575, 48.137],
      essential: false,
      zoom: 16,
    });
    expect(screen.getByText('Map centered on your location.')).toHaveAttribute('aria-live', 'polite');
  });

  it('uses a useful local zoom and a zero-duration flight for reduced motion', () => {
    const map = createMap(7);
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (success: PositionCallback) => {
          success({ coords: { latitude: -33.8688, longitude: 151.2093 } } as GeolocationPosition);
        },
      },
    });
    render(<MapNavigationControls map={map} />);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Locate me' }));

    expect(map.zoomIn).toHaveBeenCalledExactlyOnceWith({ duration: 0, essential: false });
    expect(map.flyTo).toHaveBeenCalledExactlyOnceWith({
      center: [151.2093, -33.8688],
      duration: 0,
      essential: false,
      zoom: 14,
    });
  });

  it('prevents repeated requests while geolocation is pending', () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
    render(<MapNavigationControls map={createMap()} />);
    const locate = screen.getByRole('button', { name: 'Locate me' });
    fireEvent.click(locate);
    expect(locate).toBeDisabled();
    fireEvent.click(locate);
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('announces a safe geolocation error and never moves the map', () => {
    const map = createMap();
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (_success: PositionCallback, error: PositionErrorCallback) => {
          error({ code: 1, message: 'precise browser disclosure' } as GeolocationPositionError);
        },
      },
    });
    render(<MapNavigationControls map={map} />);

    fireEvent.click(screen.getByRole('button', { name: 'Locate me' }));

    expect(map.flyTo).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Your location could not be accessed.');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('precise browser disclosure')).not.toBeInTheDocument();
  });

  it('disables location when the browser API is unavailable and exposes the explanation', () => {
    const map = createMap();
    vi.stubGlobal('navigator', {});
    render(<MapNavigationControls map={map} />);

    const locate = screen.getByRole('button', { name: 'Locate me' });
    expect(locate).toBeDisabled();
    expect(locate).toHaveAccessibleDescription('Location is unavailable in this browser.');
  });

  it('localizes the control group and button names', () => {
    render(<I18nProvider initial="de"><MapNavigationControls map={createMap()} /></I18nProvider>);

    expect(screen.getByRole('group', { name: 'Kartennavigation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Vergrößern' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mich orten' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kompass nach Norden ausrichten' })).toBeInTheDocument();
  });

  it('ignores a late geolocation result after unmounting', () => {
    const map = createMap();
    let succeed: PositionCallback | undefined;
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (success: PositionCallback) => { succeed = success; },
      },
    });
    const view = render(<MapNavigationControls map={map} />);
    fireEvent.click(screen.getByRole('button', { name: 'Locate me' }));

    view.unmount();
    succeed?.({ coords: { latitude: 1, longitude: 2 } } as GeolocationPosition);

    expect(map.flyTo).not.toHaveBeenCalled();
  });
});
