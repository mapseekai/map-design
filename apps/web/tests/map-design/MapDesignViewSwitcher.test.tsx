// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MapDesignViewSwitcher } from '../../src/map-design/components/MapDesignViewSwitcher';

describe('MapDesignViewSwitcher', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('selects the requested labelled mobile surface', () => {
    let view: ReturnType<typeof render>;
    const onViewChange = (next: 'chat' | 'map') => {
      view.rerender(<MapDesignViewSwitcher view={next} chatPanelId="chat" mapPanelId="map" onViewChange={onViewChange} />);
    };
    view = render(<MapDesignViewSwitcher view="chat" chatPanelId="chat" mapPanelId="map" onViewChange={onViewChange} />);

    const map = screen.getByRole('tab', { name: 'Map' });
    expect(map).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(map);
    expect(screen.getByRole('tab', { name: 'Map' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'false');
  });

  it('uses roving Arrow, Home, and End keys to focus and activate a view', () => {
    let view: ReturnType<typeof render>;
    const onViewChange = (next: 'chat' | 'map') => {
      view.rerender(<MapDesignViewSwitcher view={next} chatPanelId="chat" mapPanelId="map" onViewChange={onViewChange} />);
    };
    view = render(<MapDesignViewSwitcher view="chat" chatPanelId="chat" mapPanelId="map" onViewChange={onViewChange} />);

    const chat = screen.getByRole('tab', { name: 'Chat' });
    chat.focus();
    fireEvent.keyDown(chat, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Map' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Map' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Map' }), { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Chat' }), { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Map' })).toHaveFocus();
  });
});
