// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useMapDesignLayoutPreferences } from '../../src/map-design/hooks/useMapDesignLayoutPreferences';

afterEach(() => {
  window.localStorage.clear();
});

describe('useMapDesignLayoutPreferences', () => {
  it('uses documented defaults when no workspace preference has been stored', () => {
    const { result } = renderHook(() => useMapDesignLayoutPreferences());

    expect(result.current.chatWidth).toBe(380);
    expect(result.current.inspectorWidth).toBe(320);
    expect(result.current.chatCollapsed).toBe(false);
    expect(result.current.inspectorPinned).toBe(false);
  });

  it('clamps persisted widths and restores collapse state', () => {
    window.localStorage.setItem('map-design:workspace:v1:chat-width', '999');
    window.localStorage.setItem('map-design:workspace:v1:chat-collapsed', 'true');
    window.localStorage.setItem('map-design:workspace:v1:inspector-width', '1');
    window.localStorage.setItem('map-design:workspace:v1:inspector-pinned', 'true');

    const { result } = renderHook(() => useMapDesignLayoutPreferences());

    expect(result.current.chatWidth).toBe(520);
    expect(result.current.chatCollapsed).toBe(true);
    expect(result.current.inspectorWidth).toBe(280);
    expect(result.current.inspectorPinned).toBe(true);
  });
});
