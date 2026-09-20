#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createMapDesignMcpServer } from './map-design/mcp/server.js';

export async function runMapDesignMcpCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const daemonUrl = env.MAP_DESIGN_DAEMON_URL?.trim();
  const token = env.MAP_DESIGN_TOOL_TOKEN?.trim();
  if (!daemonUrl || !token) throw new Error('MapDesign MCP authorization is unavailable.');
  const server = createMapDesignMcpServer({ daemonUrl, token });
  await server.connect(new StdioServerTransport());
}

void runMapDesignMcpCli().catch(() => {
  process.stderr.write('MapDesign MCP server failed to start.\n');
  process.exitCode = 1;
});
