import type { LocalAgentInfo } from '@mapseekai/contracts';

export function isSelectableAgent(agent: LocalAgentInfo): boolean {
  return agent.available && agent.enabled !== false && agent.mapDesign.nativeMapTools && agent.mapDesign.reason === undefined;
}
