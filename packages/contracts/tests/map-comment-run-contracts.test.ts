import { expect, it } from 'vitest';
import { StartMapDesignRunRequestSchema } from '../src/api/runs';

const request = { projectId: 'p', conversationId: 'c', prompt: 'Apply comments', runtimeRevision: 0,
  clientRequestId: 'r', userMessageId: 'u', assistantMessageId: 'a' };
it('accepts versioned comment references without accepting client-defined targeting authority', () => {
  const commentRefs = [{ id: 'comment', version: 1 }];
  expect(StartMapDesignRunRequestSchema.parse({ ...request, commentRefs })).toMatchObject({ commentRefs });
  for (const invalid of [[], [commentRefs[0], commentRefs[0]], [{ id: 'x', version: -1 }], [{ id: 'x', version: 1, target: 'everything' }]]) {
    expect(StartMapDesignRunRequestSchema.safeParse({ ...request, commentRefs: invalid }).success).toBe(false);
  }
});
