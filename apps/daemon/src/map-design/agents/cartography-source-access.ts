import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { readCartographySource } from './cartography-source-reader.js';
import type { MapNativeToolResult } from '../tools/tool-context.js';
import type { SdkMapToolRuntime } from './sdk-tool-runtime.js';
import {
  RUN_TOOL_CALLBACK_AGENT_HEADER, RUN_TOOL_CALLBACK_CONVERSATION_HEADER,
  RUN_TOOL_CALLBACK_PROJECT_HEADER, RUN_TOOL_CALLBACK_RUN_HEADER, RUN_TOOL_CALLBACK_TOOL_USE_HEADER,
  type RunToolCallback,
} from './tool-callback.js';

export async function createCartographySourceAccess(scope: {
  readonly runId: string; readonly projectId: string; readonly conversationId: string; readonly agentId: string;
  readonly sources: ReadonlyArray<{ readonly fileName: string; readonly content: string }>;
  readonly signal: AbortSignal;
}): Promise<{ readonly toolRuntime: SdkMapToolRuntime; readonly toolCallback: RunToolCallback }> {
  let closed = false;
  let calls = 0;
  const failure = (toolUseId: string, code: string, message: string): MapNativeToolResult =>
    ({ ok: false, toolUseId, error: { code, message, retryable: false } });
  const toolRuntime: SdkMapToolRuntime = {
    execute: async call => {
      if (closed || scope.signal.aborted || call.signal.aborted) return failure(call.toolUseId, 'CANCELED', 'Source access has ended.');
      if (call.runId !== scope.runId || call.projectId !== scope.projectId || call.conversationId !== scope.conversationId
        || call.agentId !== scope.agentId || call.name !== 'read_cartography_source') {
        return failure(call.toolUseId, 'RUN_NOT_AUTHORIZED', 'Only uploaded sources for this edit may be read.');
      }
      if (++calls > 1024) return failure(call.toolUseId, 'TOOL_CALL_LIMIT', 'The source read limit was reached.');
      const result = readCartographySource(scope.sources, call.input);
      return result.ok ? { ok: true, toolUseId: call.toolUseId,
        summary: { fileName: result.output.fileName, offset: result.output.offset }, modelContent: JSON.stringify(result.output) }
        : failure(call.toolUseId, result.code, result.message);
    },
    closeRun: runId => { if (runId === scope.runId) close(); },
  };
  const token = randomUUID();
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    if (request.method !== 'POST' || request.url !== '/read_cartography_source') {
      response.writeHead(404).end('{}'); return;
    }
    if (request.headers.authorization !== `Bearer ${token}` || request.headers.origin
      || request.headers[RUN_TOOL_CALLBACK_RUN_HEADER] !== scope.runId
      || request.headers[RUN_TOOL_CALLBACK_PROJECT_HEADER] !== scope.projectId
      || request.headers[RUN_TOOL_CALLBACK_CONVERSATION_HEADER] !== scope.conversationId
      || request.headers[RUN_TOOL_CALLBACK_AGENT_HEADER] !== scope.agentId) {
      response.writeHead(403).end('{}'); return;
    }
    const toolUseId = request.headers[RUN_TOOL_CALLBACK_TOOL_USE_HEADER];
    if (typeof toolUseId !== 'string' || !toolUseId || toolUseId.length > 256) {
      response.writeHead(400).end('{}'); return;
    }
    try {
      const body = await readBody(request);
      if (body === null) { response.writeHead(413).end('{}'); return; }
      const input: unknown = JSON.parse(body);
      const result = await toolRuntime.execute({ ...scope, toolUseId, name: 'read_cartography_source', input });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof SyntaxError ? 400 : 500).end('{}');
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') { close(); throw new TypeError('Source callback address is unavailable.'); }
  scope.signal.addEventListener('abort', close, { once: true });
  if (scope.signal.aborted) close();
  return { toolRuntime, toolCallback: { url: `http://127.0.0.1:${address.port}`, token, close } };

  function close(): void {
    if (closed) return;
    closed = true;
    scope.signal.removeEventListener('abort', close);
    server.close();
    server.closeAllConnections();
  }
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += bytes.length;
    if (length > 4096) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
