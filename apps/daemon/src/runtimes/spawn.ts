import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { createCommandInvocation } from '@mapseekai/platform';

export function spawnAgentProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean },
): ChildProcessWithoutNullStreams {
  const invocation = createCommandInvocation({ command, args, env: options.env });
  return spawn(invocation.command, invocation.args, {
    ...options,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}
