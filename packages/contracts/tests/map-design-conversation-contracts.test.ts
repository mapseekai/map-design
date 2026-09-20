import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  MapDesignConversationRuntimeResponseSchema,
  MapDesignMessageSchema,
  UpdateMapDesignConversationRuntimeRequestSchema,
  type MapDesignConversationRuntimeChoice,
  type MapDesignMessage,
  type MapDesignRuntimeProvenance,
} from '../src/index.js';

const runtime: MapDesignConversationRuntimeChoice = {
  agentId: 'opencode',
  model: 'openai/gpt-5.6-terra',
  modelOrigin: 'catalog',
  reasoning: 'high',
  revision: 3,
  updatedAt: '2026-09-02T00:00:00.000Z',
};

const assistantRuntime: MapDesignRuntimeProvenance = {
  agentId: 'opencode',
  agentVersion: '1.2.3',
  model: 'openai/gpt-5.6-terra',
  reasoning: 'high',
  serviceTier: 'priority',
  adapter: 'opencode',
};

const userMessage: MapDesignMessage = {
  id: 'user-1',
  conversationId: 'conversation-1',
  role: 'user',
  content: 'Darken the roads.',
  events: [],
  runStatus: 'succeeded',
  startedAt: 1_788_100_000_000,
  endedAt: 1_788_100_002_000,
};

// @ts-expect-error Runtime provenance must remain assistant-only for typed callers.
const invalidUserMessage: MapDesignMessage = { ...userMessage, runtime: assistantRuntime };

describe('MapDesign conversation runtime contracts', () => {
  // Mutation caught: returning a partial or permissive persisted runtime choice to browser clients.
  it('accepts the strict persisted runtime response', () => {
    const response = {
      runtime,
      effectiveRuntime: { ...runtime, model: 'openai/gpt-5.6-luna', reasoning: undefined },
      normalizationNotice: 'The saved runtime was normalized to a safe current choice.',
    };
    expect(MapDesignConversationRuntimeResponseSchema.parse(response)).toEqual(response);
    expect(() => MapDesignConversationRuntimeResponseSchema.parse({ ...response, stale: false })).toThrow();
    expect(() => MapDesignConversationRuntimeResponseSchema.parse({ runtime })).toThrow();
  });

  // Mutation caught: accepting a stale/negative revision or a model identifier that can be parsed as a CLI flag.
  it('strictly validates the compare-and-swap runtime update request', () => {
    const request = {
      expectedRevision: 2,
      runtime: { agentId: 'opencode', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', reasoning: 'high' },
      clientRequestId: 'request-1',
    };

    expect(UpdateMapDesignConversationRuntimeRequestSchema.parse(request)).toEqual(request);
    expect(() => UpdateMapDesignConversationRuntimeRequestSchema.parse({
      ...request,
      runtime: { agentId: 'opencode', model: 'openai/gpt-5.6-terra' },
    })).toThrow();
    expect(() => UpdateMapDesignConversationRuntimeRequestSchema.parse({
      ...request,
      runtime: { agentId: 'opencode', modelOrigin: 'custom' },
    })).toThrow();
    expect(() => UpdateMapDesignConversationRuntimeRequestSchema.parse({
      ...request,
      runtime: { agentId: 'opencode', model: 'provider/custom', modelOrigin: 'ambient' },
    })).toThrow();
    expect(() => UpdateMapDesignConversationRuntimeRequestSchema.parse({
      expectedRevision: 2,
      runtime: { agentId: 'opencode', model: '--dangerous' },
      clientRequestId: 'request-1',
    })).toThrow();
    expect(() => UpdateMapDesignConversationRuntimeRequestSchema.parse({ ...request, expectedRevision: -1 })).toThrow();
    expect(() => UpdateMapDesignConversationRuntimeRequestSchema.parse({
      ...request,
      expectedRevision: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow();
    expect(() => UpdateMapDesignConversationRuntimeRequestSchema.parse({ ...request, unknown: true })).toThrow();
    expect(() => MapDesignConversationRuntimeResponseSchema.parse({
      runtime: { ...runtime, updatedAt: 'tomorrow' },
      effectiveRuntime: runtime,
    })).toThrow();
  });

  // Mutation caught: storing runtime provenance on a non-assistant message or allowing it to exceed the existing public message limit.
  it('allows provenance only on bounded assistant messages', () => {
    const message = {
      id: 'assistant-1',
      conversationId: 'conversation-1',
      role: 'assistant',
      content: 'Updated the road hierarchy.',
      events: [],
      runStatus: 'succeeded',
      startedAt: 1_788_100_000_000,
      endedAt: 1_788_100_002_000,
      runtime: assistantRuntime,
    };

    expect(MapDesignMessageSchema.parse(message)).toEqual(message);
    expect(userMessage.role).toBe('user');
    expect(() => MapDesignMessageSchema.parse({ ...userMessage, runtime: assistantRuntime })).toThrow();
    expect(() => MapDesignMessageSchema.parse({ ...message, role: 'user' })).toThrow();
    expect(() => MapDesignMessageSchema.parse({
      ...message,
      runtime: { ...message.runtime, agentVersion: 'v'.repeat(64_000) },
    })).toThrow();
    expectTypeOf<MapDesignConversationRuntimeChoice['revision']>().toEqualTypeOf<number>();
  });
});
