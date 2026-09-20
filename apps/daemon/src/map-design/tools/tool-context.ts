import type { SafeToolSummary } from '@mapseekai/contracts';
import type { MapToolEnvelope, MapToolName } from '@mapseekai/map-design-contracts';

export interface MapToolCallContext {
  requestId: string;
  projectId: string;
  runId: string;
  signal: AbortSignal;
}

export type MapToolHandler = (
  context: MapToolCallContext,
  input: unknown,
) => Promise<MapToolEnvelope<unknown>>;

export type NativeMapToolDefinition = {
  name: MapToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type MapNativeToolCallContext = {
  runId: string;
  projectId: string;
  conversationId: string;
  toolUseId: string;
  signal: AbortSignal;
};

export type MapNativeToolResult =
  | { ok: true; toolUseId: string; summary: SafeToolSummary; modelContent?: string }
  | {
      ok: false;
      toolUseId: string;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        details?: SafeToolSummary;
      };
    };

export interface MapDesignNativeToolRegistry {
  definitions(): readonly NativeMapToolDefinition[];
  call(
    context: MapNativeToolCallContext,
    name: MapToolName,
    input: unknown,
  ): Promise<MapNativeToolResult>;
}
