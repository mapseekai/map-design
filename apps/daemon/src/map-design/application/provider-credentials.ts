import type { ByokProviderSelection } from '@mapseekai/contracts';

interface CredentialTarget {
  readonly protocol: string;
  readonly baseUrl?: string;
  readonly requiresApiKey?: boolean;
}

function endpointIdentity(value: string | undefined): string {
  const endpoint = value?.trim() ?? '';
  if (!endpoint) return '';
  try {
    const url = new URL(endpoint);
    url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
    return url.href;
  }
  catch (error) {
    if (error instanceof TypeError) return endpoint;
    throw error;
  }
}

/** Null means the endpoint change requires explicit credential re-entry. */
export function apiKeyForProviderUpdate(
  previous: ByokProviderSelection | undefined,
  target: CredentialTarget,
  suppliedKey: string | undefined,
): string | null {
  const key = suppliedKey?.trim();
  if (key && key !== '[REDACTED]') return key;
  const retained = previous?.apiKey ?? '';
  const targetChanged = previous?.protocol !== target.protocol
    || endpointIdentity(previous?.baseUrl) !== endpointIdentity(target.baseUrl);
  if (target.requiresApiKey === false) return previous?.requiresApiKey === false && !targetChanged ? retained : '';
  if (retained.trim() && targetChanged) return null;
  return retained;
}
