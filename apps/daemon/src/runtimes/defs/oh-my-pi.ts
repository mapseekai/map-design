import { DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeAgentDef, RuntimeModelOption } from '../types.js';

const ANSI_ESCAPE_RE = /\u001B\[[0-?]*[ -/]*[@-~]/gu;

export function parseOhMyPiModels(stdout: string): RuntimeModelOption[] | null {
  const text = String(stdout || '').replace(ANSI_ESCAPE_RE, '');
  const json = parseOhMyPiJsonModels(text);
  if (json) return json;

  const models: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  const seen = new Set<string>([DEFAULT_MODEL_OPTION.id]);
  let provider: string | null = null;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const providerMatch = /^([^\s│┌├└]+)\s+\(\d+\)$/u.exec(line);
    if (providerMatch?.[1]) {
      provider = providerMatch[1];
      continue;
    }
    if (!provider || !line.startsWith('│')) continue;
    const cells = line.split('│').slice(1, -1).map((cell) => cell.trim());
    const modelId = cells[0];
    if (!modelId || modelId === 'model') continue;
    const id = `${provider}/${modelId}`;
    if (!isSafeModelId(id) || seen.has(id)) continue;
    seen.add(id);
    const thinking = cells[3];
    const reasoningOptions = thinking && thinking !== '-' && thinking !== 'yes'
      ? thinking.split(',').map((value) => value.trim()).filter(isSafeOptionId)
      : [];
    models.push({
      id,
      label: id,
      ...(reasoningOptions.length > 0
        ? { reasoningOptions: reasoningOptions.map((option) => ({ id: option, label: option })) }
        : {}),
    });
  }
  return models.length > 1 ? models : null;
}

function parseOhMyPiJsonModels(stdout: string): RuntimeModelOption[] | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rawModels = (value as { models?: unknown }).models;
  if (!Array.isArray(rawModels)) return null;
  const models: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  const seen = new Set<string>([DEFAULT_MODEL_OPTION.id]);
  for (const candidate of rawModels) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const model = candidate as Record<string, unknown>;
    const provider = typeof model.provider === 'string' ? model.provider.trim() : '';
    const modelId = typeof model.id === 'string' ? model.id.trim() : '';
    const selector = typeof model.selector === 'string' ? model.selector.trim() : `${provider}/${modelId}`;
    if (!provider || !modelId || !isSafeModelId(selector)) return null;
    if (seen.has(selector)) continue;
    seen.add(selector);
    const label = typeof model.name === 'string' && model.name.trim() ? model.name.trim() : selector;
    const efforts = Array.isArray(model.thinking)
      ? model.thinking.filter((effort): effort is string => typeof effort === 'string' && isSafeOptionId(effort))
      : [];
    models.push({
      id: selector,
      label,
      ...(efforts.length > 0
        ? { reasoningOptions: efforts.map((effort) => ({ id: effort, label: effort })) }
        : {}),
    });
  }
  return models.length > 1 ? models : null;
}

function isSafeModelId(value: string): boolean {
  return value.length <= 256 && /^(?!-)[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value);
}

function isSafeOptionId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && isSafeModelId(value);
}

export const ohMyPiAgentDef = {
  id: 'oh-my-pi',
  name: 'Oh My Pi',
  bin: 'omp',
  inheritedEnvKeys: [
    'ANTHROPIC_API_KEY', 'CEREBRAS_API_KEY', 'COHERE_API_KEY', 'DEEPSEEK_API_KEY',
    'FIREWORKS_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY',
    'MISTRAL_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'PERPLEXITY_API_KEY',
    'TOGETHER_API_KEY', 'XAI_API_KEY',
  ],
  versionArgs: ['--version'],
  listModels: {
    args: ['models', 'ls'],
    parse: parseOhMyPiModels,
    timeoutMs: 15_000,
  },
  fallbackModels: [DEFAULT_MODEL_OPTION],
  buildArgs: () => ['--mode', 'rpc'],
  promptViaStdin: true,
  streamFormat: 'omp-rpc',
  mapDesign: {
    nativeToolAdapter: 'omp-rpc',
    publicReasoningSummary: true,
  },
} satisfies RuntimeAgentDef;
