// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MapToolActivityCard,
  type MapToolActivity,
} from '../../../src/map-design/chat/MapToolActivityCard';
import { I18nProvider } from '../../../src/i18n';

afterEach(cleanup);

describe('MapToolActivityCard', () => {
  it('renders safe summaries without exposing legacy raw inputs or results', () => {
    const activity = {
      id: 'tool-1',
      name: 'map_inspect',
      summary: { target: 'roads/primary', visibleLayers: 4 },
      result: { status: 'succeeded' as const, summary: { matchedFeatures: 12 } },
      input: { token: 'RAW_INPUT_MUST_NOT_RENDER' },
      output: 'RAW_RESULT_MUST_NOT_RENDER',
    } as MapToolActivity;

    render(<MapToolActivityCard activity={activity} runStatus="succeeded" />);

    const toggle = screen.getByRole('button', { name: /inspect map/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(toggle, { key: ' ' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('roads/primary')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.queryByText(/RAW_INPUT_MUST_NOT_RENDER/)).not.toBeInTheDocument();
    expect(screen.queryByText(/RAW_RESULT_MUST_NOT_RENDER/)).not.toBeInTheDocument();
  });

  it('initializes the current running tool expanded', () => {
    render(<MapToolActivityCard
      activity={{ id: 'tool-1', name: 'map_validate', summary: { scope: 'draft' } }}
      runStatus="running"
      current
    />);

    expect(screen.getByRole('button', { name: /validate map/i })).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders unsupported tool details as non-interactive text', () => {
    render(<MapToolActivityCard
      activity={{
        id: 'tool-unknown',
        name: 'provider/private_tool',
        summary: { operation: 'Completed safely' },
        result: { status: 'succeeded', summary: { changed: true } },
      }}
      runStatus="succeeded"
    />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Tool activity')).toBeInTheDocument();
    expect(screen.queryByText('provider/private_tool')).not.toBeInTheDocument();
    expect(screen.queryByText('Completed safely')).not.toBeInTheDocument();
  });

  it('lets an explicit successful result outrank a failed Run', () => {
    render(<MapToolActivityCard
      activity={{
        id: 'tool-1',
        name: 'map_validate',
        summary: { scope: 'draft' },
        result: { status: 'succeeded', summary: { valid: true } },
      }}
      runStatus="failed"
    />);

    const toggle = screen.getByRole('button', { name: /Validate map.*Completed/i });
    expect(toggle.closest('section')).toHaveAttribute('data-status', 'succeeded');
  });

  it('marks an unresolved canceled tool as canceled rather than succeeded', () => {
    render(<MapToolActivityCard
      activity={{ id: 'tool-1', name: 'map_inspect', summary: { target: 'roads' } }}
      runStatus="canceled"
    />);

    const toggle = screen.getByRole('button', { name: /Inspect map.*Canceled/i });
    expect(toggle.closest('section')).toHaveAttribute('data-status', 'canceled');
    expect(toggle.querySelector('.lucide-ban')).not.toBeNull();
  });

  it('lets an explicit canceled result outrank a failed Run', () => {
    render(<MapToolActivityCard
      activity={{
        id: 'tool-1',
        name: 'map_validate',
        summary: { scope: 'draft' },
        result: { status: 'canceled', summary: { retryable: false } },
      }}
      runStatus="failed"
    />);

    const toggle = screen.getByRole('button', { name: /Validate map.*Canceled/i });
    expect(toggle.closest('section')).toHaveAttribute('data-status', 'canceled');
  });

  it('uses the canceled icon for an unresolved generic tool without exposing its identifier', () => {
    const { container } = render(<MapToolActivityCard
      activity={{ id: 'tool-unknown', name: 'provider/private_tool', summary: {} }}
      runStatus="canceled"
    />);

    const row = container.querySelector('[data-supported="false"]');
    expect(row).toHaveAttribute('data-status', 'canceled');
    expect(row?.querySelector('.lucide-ban')).not.toBeNull();
    expect(screen.queryByText('provider/private_tool')).not.toBeInTheDocument();
  });

  it('renders the synthetic omitted-tools aggregate with localized counts', () => {
    render(<I18nProvider initial="zh-CN">
      <MapToolActivityCard
        activity={{
          id: 'tools-omitted',
          name: 'map_tools',
          summary: { omitted: 3 },
          result: { status: 'failed', summary: { omitted: 3, failures: 1 } },
        }}
        runStatus="failed"
      />
    </I18nProvider>);

    expect(screen.getByText('已省略先前的工具步骤')).toBeInTheDocument();
    expect(screen.getByText('已省略先前的 3 个工具步骤')).toBeInTheDocument();
    expect(screen.getByText('1 个失败')).toBeInTheDocument();
    expect(screen.queryByText('map_tools')).not.toBeInTheDocument();
    expect(screen.queryByText('tools-omitted')).not.toBeInTheDocument();
  });

  it('localizes native map labels and hides unknown host identifiers behind a generic label', () => {
    render(<I18nProvider initial="zh-CN">
      <MapToolActivityCard
        activity={{ id: 'tool-1', name: 'map_inspect', summary: {} }}
        runStatus="running"
        current
      />
      <MapToolActivityCard
        activity={{ id: 'tool-2', name: 'provider/private_tool', summary: {} }}
        runStatus="succeeded"
      />
    </I18nProvider>);

    expect(screen.getByRole('button', { name: /检查地图/ })).toBeInTheDocument();
    expect(screen.getByText('工具活动')).toBeInTheDocument();
    expect(screen.queryByText('provider/private_tool')).not.toBeInTheDocument();
  });
});
