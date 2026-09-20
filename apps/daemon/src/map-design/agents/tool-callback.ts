import type { ToolTokenGrant } from '../../tool-tokens.js';

export const RUN_TOOL_CALLBACK_RUN_HEADER = 'x-map-design-run-id';
export const RUN_TOOL_CALLBACK_PROJECT_HEADER = 'x-map-design-project-id';
export const RUN_TOOL_CALLBACK_CONVERSATION_HEADER = 'x-map-design-conversation-id';
export const RUN_TOOL_CALLBACK_AGENT_HEADER = 'x-map-design-agent-id';
export const RUN_TOOL_CALLBACK_TOOL_USE_HEADER = 'x-map-design-tool-use-id';

export interface RunToolCallback {
  url: string;
  token: string;
  close(): void;
}

export interface RunToolCallbackGrant {
  daemonUrl: string;
  grant: ToolTokenGrant;
  close(): void;
}

export function createRunToolCallback(input: RunToolCallbackGrant): RunToolCallback {
  const base = loopbackDaemonUrl(input.daemonUrl);
  if (!input.grant.token || !input.grant.runId || !input.grant.projectId
    || !input.grant.conversationId || !input.grant.agentId) {
    throw new TypeError('The Run tool callback grant is invalid.');
  }
  const url = new URL('/api/map-design/tools', base).toString().replace(/\/$/u, '');
  let closed = false;
  return {
    url,
    token: input.grant.token,
    close() {
      if (closed) return;
      closed = true;
      input.close();
    },
  };
}

function loopbackDaemonUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('The Run tool callback URL is invalid.');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', '::1', '[::1]', 'localhost'].includes(hostname)
    || url.username
    || url.password
  ) {
    throw new TypeError('The Run tool callback URL must use daemon loopback transport.');
  }
  return url;
}
