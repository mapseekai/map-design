import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, type LanguageModel } from 'ai';
import type { MapDesignRunByokProviderSelection } from '@mapseekai/contracts';

export class ApiModelConfigurationError extends Error {
  constructor() { super('Configure an OpenAI-compatible or Anthropic API, API key and model in Settings.'); }
}

export function createApiModel(provider: (MapDesignRunByokProviderSelection & { model?: string | undefined }) | undefined, modelOverride?: string | null, fetchImplementation: typeof fetch = fetch): LanguageModel {
  if (!provider || !['openai', 'anthropic'].includes(provider.protocol)) throw new ApiModelConfigurationError();
  const model = (modelOverride && modelOverride !== 'default' ? modelOverride : provider.model)?.trim();
  const apiKey = provider.apiKey.trim();
  if (!model || model === 'default' || (!apiKey && provider.requiresApiKey !== false)) throw new ApiModelConfigurationError();
  let url: URL;
  try {
    url = new URL(provider.baseUrl?.trim() || (provider.protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'));
  } catch { throw new ApiModelConfigurationError(); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ApiModelConfigurationError();
  const baseURL = url.href.replace(/\/+$/, '').replace(/\/(chat\/completions|responses|messages)$/, '');
  // Do not forward a configured API credential through redirects.
  const safeFetch: typeof fetch = (input, init) => fetchImplementation(input, { ...init, redirect: 'error' });
  const settings = { baseURL, apiKey, fetch: safeFetch };
  if (provider.protocol === 'anthropic') return createAnthropic(settings)(model);
  if (provider.apiFormat === 'responses') return createOpenAI(settings).responses(model);
  return createOpenAICompatible({ ...settings, name: 'map-design-api' }).chatModel(model);
}

export function apiModelFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ApiModelConfigurationError) return { code: 'API_CONFIGURATION_REQUIRED', message: error.message };
  if (APICallError.isInstance(error) && (error.statusCode === 401 || error.statusCode === 403)) {
    return { code: 'API_AUTH_FAILED', message: 'The model API rejected authentication. Check the saved API key and endpoint.' };
  }
  if (APICallError.isInstance(error) && error.statusCode === 429) return { code: 'API_RATE_LIMITED', message: 'The model API rate limit was reached. Try again later.' };
  return { code: 'API_REQUEST_FAILED', message: 'The model API request failed. Check the endpoint, response format and model configuration.' };
}
