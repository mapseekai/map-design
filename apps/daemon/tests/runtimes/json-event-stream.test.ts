import { describe, expect, it } from 'vitest';
import { createJsonEventStreamHandler } from '../../src/runtimes/json-event-stream.js';

describe('Codex public reasoning summaries', () => {
  it('emits only the unseen suffix as public thought_summary_delta events', () => {
    const events: Array<Record<string, unknown>> = [];
    const parser = createJsonEventStreamHandler('codex', (event) => events.push(event));
    parser.feed('{"type":"item.started","item":{"id":"reason-1","type":"reasoning","text":"Inspecting"}}\n');
    parser.feed('{"type":"item.updated","item":{"id":"reason-1","type":"reasoning","text":"Inspecting layers"}}\n');
    parser.flush();

    expect(events).toEqual([
      { type: 'thought_summary_delta', delta: 'Inspecting' },
      { type: 'thought_summary_delta', delta: ' layers' },
    ]);
  });

  it('does not promote non-reasoning items', () => {
    const events: Array<Record<string, unknown>> = [];
    const parser = createJsonEventStreamHandler('codex', (event) => events.push(event));
    parser.feed('{"type":"item.completed","item":{"id":"raw-1","type":"agent_message","text":"Visible answer"}}\n');
    parser.flush();
    expect(events.some((event) => event.type === 'thought_summary_delta')).toBe(false);
  });
});

describe('Codex observable work items', () => {
  it('maps an MCP tool lifecycle to public tool events without exposing arguments or output', () => {
    const events: Array<Record<string, unknown>> = [];
    const parser = createJsonEventStreamHandler('codex', (event) => events.push(event));
    parser.feed(`${JSON.stringify({
      type: 'item.started',
      item: {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'map-design',
        tool: 'map_inspect',
        arguments: { target: { kind: 'root' }, privatePath: '/Users/example/private' },
        status: 'in_progress',
      },
    })}\n`);
    parser.feed(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'map-design',
        tool: 'map_inspect',
        arguments: { target: { kind: 'root' }, privatePath: '/Users/example/private' },
        result: { content: [{ type: 'text', text: 'private result' }] },
        error: null,
        status: 'completed',
      },
    })}\n`);
    parser.flush();

    expect(events).toEqual([
      { type: 'tool_use', id: 'mcp-1', name: 'map-design/map_inspect', input: null },
      { type: 'tool_result', toolUseId: 'mcp-1', content: 'Tool completed.', isError: false },
    ]);
  });

  it('maps a failed MCP item to a generic failed tool result', () => {
    const events: Array<Record<string, unknown>> = [];
    const parser = createJsonEventStreamHandler('codex', (event) => events.push(event));
    parser.feed(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'mcp-2',
        type: 'mcp_tool_call',
        server: 'map-design',
        tool: 'map_validate',
        arguments: { token: 'secret-value' },
        result: null,
        error: { message: 'credential leaked from provider' },
        status: 'failed',
      },
    })}\n`);
    parser.flush();

    expect(events).toEqual([
      { type: 'tool_use', id: 'mcp-2', name: 'map-design/map_validate', input: null },
      { type: 'tool_result', toolUseId: 'mcp-2', content: 'Tool failed.', isError: true },
    ]);
  });

  it('emits one terminal result when Codex repeats an item.completed event', () => {
    const events: Array<Record<string, unknown>> = [];
    const parser = createJsonEventStreamHandler('codex', (event) => events.push(event));
    const completed = `${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'mcp-repeat',
        type: 'mcp_tool_call',
        server: 'map-design',
        tool: 'map_inspect',
        arguments: {},
        result: { content: [] },
        error: null,
        status: 'completed',
      },
    })}\n`;
    parser.feed(completed);
    parser.feed(completed);
    parser.flush();

    expect(events).toEqual([
      { type: 'tool_use', id: 'mcp-repeat', name: 'map-design/map_inspect', input: null },
      { type: 'tool_result', toolUseId: 'mcp-repeat', content: 'Tool completed.', isError: false },
    ]);
  });

  it.each([
    [
      'file_change',
      { id: 'file-1', type: 'file_change', changes: [{ path: '/private/file', kind: 'update' }], status: 'completed' },
      'File changes',
    ],
    [
      'web_search',
      { id: 'search-1', type: 'web_search', query: 'private query', action: { type: 'search' } },
      'Web search',
    ],
  ] as const)('maps a completed %s item to a generic public step', (_kind, item, name) => {
    const events: Array<Record<string, unknown>> = [];
    const parser = createJsonEventStreamHandler('codex', (event) => events.push(event));
    parser.feed(`${JSON.stringify({ type: 'item.completed', item })}\n`);
    parser.flush();

    expect(events).toEqual([
      { type: 'tool_use', id: item.id, name, input: null },
      { type: 'tool_result', toolUseId: item.id, content: 'Tool completed.', isError: false },
    ]);
  });
});
