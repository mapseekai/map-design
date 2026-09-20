// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MapDesignTitlebarContext, TitlebarControl, TitlebarProject } from '../../../src/map-design/components/MapDesignTitlebar';

afterEach(cleanup);
it('moves controls into the titlebar without losing their click behavior', () => {
  const controls = document.createElement('div');
  const title = document.createElement('div');
  document.body.append(controls, title);
  const click = vi.fn();
  try {
    const view = render(<MapDesignTitlebarContext.Provider value={{ controls, title }}>
      <TitlebarControl><button onClick={click}>Collapse</button></TitlebarControl><TitlebarProject title="Map project" />
    </MapDesignTitlebarContext.Provider>);
    expect(controls).toContainElement(screen.getByRole('button', { name: 'Collapse' }));
    expect(view.container).not.toContainElement(screen.getByRole('button', { name: 'Collapse' }));
    expect(title).toHaveTextContent('Map project');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(click).toHaveBeenCalledOnce();
    view.unmount(); expect(controls).toBeEmptyDOMElement(); expect(title).toBeEmptyDOMElement();
  } finally { controls.remove(); title.remove(); }
});

it('keeps controls local when the titlebar is unavailable on a narrow screen', () => {
  const view = render(<TitlebarControl><button>Expand</button></TitlebarControl>);
  expect(view.container).toContainElement(screen.getByRole('button', { name: 'Expand' }));
});
