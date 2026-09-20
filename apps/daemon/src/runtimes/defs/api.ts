import type { RuntimeAgentDef } from '../types.js';

export const API_AGENT_ID = 'api';
/** Built into the daemon; this definition must never be launched as a subprocess. */
export const apiAgentDef: RuntimeAgentDef = {
  id: API_AGENT_ID,
  name: 'API Model',
  bin: 'api-model',
  versionArgs: [],
  fallbackModels: [{ id: 'default', label: 'Configured API model' }],
  supportsCustomModel: true,
  mapDesign: { nativeToolAdapter: 'ai-sdk', publicReasoningSummary: true },
  streamFormat: 'ai-sdk',
  buildArgs: () => { throw new Error('API models execute inside the daemon.'); },
};
