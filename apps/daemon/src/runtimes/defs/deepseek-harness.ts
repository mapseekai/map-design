import { DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeAgentDef, RuntimeModelOption } from '../types.js';

const DSH_VERSION_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;

export function parseDeepSeekHarnessVersion(raw: string): string | null {
  return DSH_VERSION_RE.exec(raw.trim())?.[1] ?? null;
}

export function parseDeepSeekHarnessModels(stdout: string): RuntimeModelOption[] | null {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) return null;
  let value: unknown;
  try {
    value = JSON.parse(lines[0] ?? '') as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (
    frame.v !== 1 ||
    frame.type !== 'models' ||
    frame.runtime !== 'map-design' ||
    !Array.isArray(frame.models)
  ) return null;

  const models: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  const seen = new Set<string>([DEFAULT_MODEL_OPTION.id]);
  for (const candidate of frame.models) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const model = candidate as Record<string, unknown>;
    if (
      typeof model.provider !== 'string' || model.provider.length === 0 ||
      typeof model.provider_name !== 'string' || model.provider_name.length === 0 ||
      typeof model.id !== 'string' || model.id.length === 0 ||
      typeof model.name !== 'string' || model.name.length === 0
    ) return null;
    const id = `${model.provider}/${model.id}`;
    if (!/^(?!-)[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(id)) return null;
    if (seen.has(id)) continue;
    seen.add(id);
    let reasoningOptions: RuntimeModelOption[] | undefined;
    if (model.reasoning_options !== undefined) {
      if (!Array.isArray(model.reasoning_options)) return null;
      reasoningOptions = [];
      const seenReasoning = new Set<string>();
      for (const candidateReasoning of model.reasoning_options) {
        if (!candidateReasoning || typeof candidateReasoning !== 'object' || Array.isArray(candidateReasoning)) return null;
        const reasoning = candidateReasoning as Record<string, unknown>;
        if (
          typeof reasoning.id !== 'string' || reasoning.id.length === 0 ||
          typeof reasoning.name !== 'string' || reasoning.name.length === 0 ||
          (reasoning.default !== undefined && typeof reasoning.default !== 'boolean')
        ) return null;
        if (seenReasoning.has(reasoning.id)) continue;
        seenReasoning.add(reasoning.id);
        reasoningOptions.push({
          id: reasoning.id,
          label: reasoning.name,
          ...(reasoning.default === true ? { default: true } : {}),
        });
      }
    }
    models.push({
      id,
      label: `${model.name} · ${model.provider_name}`,
      ...(reasoningOptions && reasoningOptions.length > 0 ? { reasoningOptions } : {}),
    });
  }
  return models.length > 1 ? models : null;
}

export const deepseekHarnessAgentDef = {
  id: 'deepseek-harness',
  name: 'DeepSeek Harness',
  bin: 'dsh',
  inheritedEnvKeys: [
    'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
  ],
  versionArgs: ['--version'],
  parseVersion: parseDeepSeekHarnessVersion,
  listModels: {
    args: ['--profile', 'map-design', '--models'],
    parse: parseDeepSeekHarnessModels,
    timeoutMs: 10_000,
  },
  fallbackModels: [DEFAULT_MODEL_OPTION],
  buildArgs: () => ['--profile', 'map-design', '--stdio'],
  promptViaStdin: true,
  streamFormat: 'dsh-profile-jsonl',
  capturesSessionIdFromStream: true,
  supportsCustomModel: false,
  mapDesign: {
    nativeToolAdapter: 'deepseek-profile',
    publicReasoningSummary: true,
  },
} satisfies RuntimeAgentDef;
