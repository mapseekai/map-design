import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  MapToolEnvelopeSchema,
  MapToolInputSchemas,
  MapToolOutputSchemas,
  type MapToolEnvelope,
  type MapToolName,
} from '@mapseekai/map-design-contracts';

import {
  createMapToolHttpClient,
  MapToolClientError,
  type MapToolHttpClientOptions,
} from './map-tool-client.js';
import { nativeMapToolDefinitions } from '../tools/model-tool-definitions.js';

const READ_ONLY = new Set<MapToolName>([
  'map_get_context',
  'map_inspect',
  'map_search_layers',
  'map_validate',
]);
const DESTRUCTIVE = new Set<MapToolName>(['map_discard_draft']);

export function createMapDesignMcpServer(options: MapToolHttpClientOptions): McpServer {
  const client = createMapToolHttpClient(options);
  const server = new McpServer({ name: 'mapdesign-mcp-server', version: '1.0.0' });
  for (const definition of nativeMapToolDefinitions()) {
    const name = definition.name;
    const envelopeSchema = MapToolEnvelopeSchema(MapToolOutputSchemas[name]);
    const successShape = envelopeSchema.options[0].shape;
    const errorShape = envelopeSchema.options[1].shape;
    server.registerTool(
      name,
      {
        title: name,
        description: definition.description,
        inputSchema: MapToolInputSchemas[name],
        // MCP v1.29 normalizes tool output declarations as object schemas.
        // The HTTP client performs the authoritative discriminated-union
        // validation; this object shape lets the SDK validate the structured
        // success payload it returns to the ACP client.
        outputSchema: {
          ok: successShape.ok.or(errorShape.ok),
          data: successShape.data.optional(),
          error: errorShape.error.optional(),
          meta: successShape.meta,
        },
        annotations: {
          readOnlyHint: READ_ONLY.has(name),
          destructiveHint: DESTRUCTIVE.has(name),
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input: unknown) => {
        let envelope: MapToolEnvelope<unknown>;
        try {
          envelope = await client.call(name, input);
        } catch (error) {
          envelope = clientErrorEnvelope(error);
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
          structuredContent: envelope,
          ...(envelope.ok ? {} : { isError: true }),
        };
      },
    );
  }
  return server;
}

function clientErrorEnvelope(error: unknown): MapToolEnvelope<never> {
  const kind = error instanceof MapToolClientError ? error.kind : 'transport';
  const unauthorized = kind === 'unauthorized';
  const invalidInput = kind === 'invalid_input';
  return {
    ok: false,
    error: {
      code: unauthorized ? 'RUN_NOT_AUTHORIZED' : invalidInput ? 'INVALID_INPUT' : 'INTERNAL',
      message: unauthorized
        ? 'The MapDesign run is not authorized.'
        : invalidInput
          ? 'The MapDesign tool input is invalid.'
          : 'The MapDesign tool request failed.',
      retryable: false,
    },
    meta: { requestId: 'map-mcp', projectId: 'unknown-project', runId: 'unknown-run' },
  };
}
