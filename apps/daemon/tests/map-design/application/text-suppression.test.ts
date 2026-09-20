import { describe, expect, it } from 'vitest';
import {
  createDsmlArtifactTextSuppressor,
  createToolCallTextSuppressor,
} from '../../../src/agent-protocol/acp/text-suppression.js';

describe('ACP text suppressors', () => {
  it('flushes an ordinary incomplete tag instead of dropping it', () => {
    const suppressor = createDsmlArtifactTextSuppressor();

    expect(suppressor.strip('<')).toBe('');
    expect(suppressor.flush()).toBe('<');
  });

  it('does not hold ordinary tag prefixes while awaiting a suppressed artifact', () => {
    const suppressor = createDsmlArtifactTextSuppressor();

    expect(suppressor.strip('<question')).toBe('<question');
    expect(suppressor.strip('-form>Continue')).toBe('-form>Continue');
  });

  it('recognizes tool-call opening tags split across chunks', () => {
    const suppressor = createToolCallTextSuppressor();

    expect(suppressor.strip('Before <to')).toBe('Before ');
    expect(suppressor.strip('ol_call>hidden</tool_call>After')).toBe('After');
  });

  it.each([
    { open: '<tool_call>', close: '</tool_call>', make: createToolCallTextSuppressor },
    { open: '<edit>', close: '</edit>', make: createToolCallTextSuppressor },
    { open: '<artifact>', close: '</artifact>', make: createDsmlArtifactTextSuppressor },
  ] as const)('buffers every split position of $close while suppressing', ({ open, close, make }) => {
    for (let split = 1; split < close.length; split += 1) {
      const suppressor = make();
      expect(suppressor.strip(`${open}hidden${close.slice(0, split)}`)).toBe('');
      expect(suppressor.strip(`${close.slice(split)}After`)).toBe('After');
    }
  });

  it('buffers only permitted whitespace after a split edit opening tag', () => {
    const suppressor = createToolCallTextSuppressor();

    expect(suppressor.strip('<edit ')).toBe('');
    expect(suppressor.strip('>hidden</edit>After')).toBe('After');

    expect(suppressor.strip('<edit x')).toBe('<edit x');
    expect(suppressor.strip('< y')).toBe('< y');
  });
});
