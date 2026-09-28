import type { ByokProviderSelection } from '@mapseekai/contracts';

export function apiOutputBudget(
  provider: { readonly protocol: ByokProviderSelection['protocol']; readonly baseUrl?: string | undefined; readonly model?: string | undefined } | undefined,
  budget: { readonly configured: number | undefined; readonly fallback: number },
  reasoning: string | null,
): number {
  if (budget.configured !== undefined) return budget.configured;
  const url = URL.parse(provider?.baseUrl ?? '');
  const officialDeepSeek = provider?.protocol === 'openai' && url?.origin === 'https://api.deepseek.com';
  const thinkingModel = provider?.model === 'deepseek-flash' || provider?.model === 'deepseek-v4-pro';
  // DeepSeek thinking defaults to 64K output tokens, including reasoning (API docs, September 2026).
  return officialDeepSeek && thinkingModel && reasoning !== 'none' ? Math.max(budget.fallback, 65_536) : budget.fallback;
}
