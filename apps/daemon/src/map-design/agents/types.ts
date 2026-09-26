import type {
  MapAgentCapability,
  MapDesignRunByokProviderSelection,
  PersistedMapAgentEvent,
} from '@mapseekai/contracts';

import type { NativeMapToolDefinition } from '../tools/tool-context.js';
import type { SdkMapToolRuntime } from './sdk-tool-runtime.js';
import type { RunToolCallback } from './tool-callback.js';

export const MAP_RUN_MAX_FRAME_BYTES = 24 * 1024 * 1024;

export type MapRunInput = {
  runId: string;
  projectId: string;
  conversationId: string;
  prompt: string;
  taskKind?: 'cartography';
  resumePrompt: string;
  images?: Array<{ data: string; mimeType: 'image/png' }>;
  cwd: string;
  model: string | null;
  reasoning: string | null;
  serviceTier: string | null;
  byokProvider?: MapDesignRunByokProviderSelection | undefined;
  /** Server-owned immutable selection for this run; never serialized to events. */
  apiProviderSnapshot?: import('@mapseekai/contracts').ByokProviderSelection;
  toolRuntime: SdkMapToolRuntime;
  toolCallback: RunToolCallback;
  signal: AbortSignal;
};

export type MapRunTerminal = {
  status: 'succeeded' | 'failed' | 'canceled';
  error?: { code: string; message: string };
};

export interface MapRunHandle {
  done: Promise<MapRunTerminal>;
  /** Requests cancellation and joins execution cleanup, including on repeated calls. */
  cancel(): Promise<void>;
}

export type MapAgentEvent = PersistedMapAgentEvent;

export interface MapAgentAdapter {
  id: string;
  capabilities: Pick<MapAgentCapability, 'nativeMapTools' | 'publicReasoningSummary'>;
  probeNativeMapTools?(): Promise<boolean>;
  startMapRun(
    input: MapRunInput,
    tools: NativeMapToolDefinition[],
    onEvent: (event: MapAgentEvent) => void,
  ): Promise<MapRunHandle>;
}
