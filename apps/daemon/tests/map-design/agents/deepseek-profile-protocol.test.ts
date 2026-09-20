import { describe, expect, it, vi } from 'vitest';

import {
  DEEPSEEK_PROFILE_TOKEN_ENV,
  createDeepSeekProfileExecuteCommand,
  createDeepSeekProfileFrameStream,
  parseDeepSeekProfileRuntimeFrame,
} from '../../../src/map-design/agents/deepseek-profile-protocol.js';

const CAPABILITIES = {
  session_resume: true,
  session_cancel: true,
  structured_events: true,
  native_host_tools: true,
  authenticated_callback: true,
} as const;

function readyFrame(): Record<string, unknown> {
  return {
    v: 1,
    type: 'ready',
    runtime: 'map-design',
    protocol_version: 1,
    plugin_version: '1.0.0',
    capabilities: CAPABILITIES,
  };
}

describe('DeepSeek Harness MapDesign profile protocol', () => {
  it('builds the versioned host-tool execute command without an MCP map-tool field', () => {
    const command = createDeepSeekProfileExecuteCommand({
      requestId: 'run-1',
      cwd: '/safe/project',
      prompt: 'Validate the map.',
      model: 'deepseek-official/deepseek-chat',
      reasoningEffort: 'high',
      resumeSessionId: 'session-1',
      tools: [{
        name: 'map_validate',
        description: 'Validate the current map.',
        inputSchema: { type: 'object', additionalProperties: false },
      }],
      callbackUrl: 'http://127.0.0.1:8787/api/map-design/tools',
    });

    expect(command).toEqual({
      v: 1,
      type: 'execute',
      request_id: 'run-1',
      cwd: '/safe/project',
      prompt: 'Validate the map.',
      resume_session_id: 'session-1',
      model: { provider: 'deepseek-official', id: 'deepseek-chat' },
      reasoning_effort: 'high',
      host_tools: [{
        name: 'map_validate',
        description: 'Validate the current map.',
        inputSchema: { type: 'object', additionalProperties: false },
      }],
      callback: {
        url: 'http://127.0.0.1:8787/api/map-design/tools',
        tokenEnv: DEEPSEEK_PROFILE_TOKEN_ENV,
      },
    });
    expect(command).not.toHaveProperty('mcp_servers');
  });

  it('accepts a byte-bounded composed prompt larger than the public request field', () => {
    const prompt = 'x'.repeat(524_288);
    const command = createDeepSeekProfileExecuteCommand({
      requestId: 'run-large',
      cwd: '/safe/project',
      prompt,
      tools: [{
        name: 'map_validate',
        description: 'Validate the current map.',
        inputSchema: { type: 'object' },
      }],
      callbackUrl: 'http://127.0.0.1:8787/api/map-design/tools',
    });

    expect(Buffer.byteLength(command.prompt, 'utf8')).toBe(524_288);
    expect(command.prompt).toBe(prompt);
  });

  it('rejects a composed prompt above the UTF-8 transport byte limit', () => {
    const prompt = '界'.repeat(174_763);
    expect(Buffer.byteLength(prompt, 'utf8')).toBe(524_289);

    expect(() => createDeepSeekProfileExecuteCommand({
      requestId: 'run-oversized',
      cwd: '/safe/project',
      prompt,
      tools: [{
        name: 'map_validate',
        description: 'Validate the current map.',
        inputSchema: { type: 'object' },
      }],
      callbackUrl: 'http://127.0.0.1:8787/api/map-design/tools',
    })).toThrow('prompt');
  });

  it.each([
    [{ ...readyFrame(), v: 2 }, 'version'],
    [{ ...readyFrame(), type: 'future_frame' }, 'type'],
    [{ ...readyFrame(), runtime: 'unsupported-runtime' }, 'runtime'],
    [{ ...readyFrame(), capabilities: { ...CAPABILITIES, native_host_tools: false } }, 'capabilities'],
  ])('rejects an unsupported or incomplete identity frame (%s)', (frame, expected) => {
    expect(() => parseDeepSeekProfileRuntimeFrame(frame)).toThrow(expected);
  });

  it('parses split JSONL chunks and preserves correlated structured frames', () => {
    const frames: unknown[] = [];
    const errors: unknown[] = [];
    const stream = createDeepSeekProfileFrameStream({
      onFrame: (frame) => frames.push(frame),
      onError: (error) => errors.push(error),
    });
    const session = JSON.stringify({
      v: 1,
      type: 'session',
      request_id: 'run-1',
      session_id: 'session-1',
      resumed: false,
    });

    stream.feed(`${JSON.stringify(readyFrame())}\n${session.slice(0, 17)}`);
    stream.feed(`${session.slice(17)}\n`);
    stream.end();

    expect(errors).toEqual([]);
    expect(frames).toEqual([
      readyFrame(),
      {
        v: 1,
        type: 'session',
        request_id: 'run-1',
        session_id: 'session-1',
        resumed: false,
      },
    ]);
  });

  it('fails once when a frame exceeds the configured byte limit', () => {
    const onFrame = vi.fn();
    const onError = vi.fn();
    const stream = createDeepSeekProfileFrameStream({ onFrame, onError, maxFrameBytes: 128 });

    stream.feed(`${JSON.stringify({ ...readyFrame(), padding: 'x'.repeat(256) })}\n`);
    stream.feed(`${JSON.stringify(readyFrame())}\n`);
    stream.end();

    expect(onFrame).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'DSH_PROFILE_FRAME_TOO_LARGE' }));
  });

  it('rejects a final frame that is not newline terminated', () => {
    const onFrame = vi.fn();
    const onError = vi.fn();
    const stream = createDeepSeekProfileFrameStream({ onFrame, onError });

    stream.feed(JSON.stringify(readyFrame()));
    stream.end();

    expect(onFrame).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'DSH_PROFILE_TRUNCATED_FRAME' }));
  });

  it('retains strict rejection for one oversized text frame', () => {
    expect(() => parseDeepSeekProfileRuntimeFrame({
      v: 1,
      type: 'text',
      request_id: 'run-1',
      content: 'x'.repeat(65_537),
    })).toThrow('content');
  });
});
