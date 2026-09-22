import { mergeProxyAwareEnv, resolveSystemProxyEnv } from '@mapseekai/platform';
import { EnvHttpProxyAgent } from 'undici';

let dispatcher: EnvHttpProxyAgent | undefined;

/** Model requests use the configured proxy without changing daemon-wide fetch. */
export const apiFetch: typeof fetch = (input, init) => {
  if (!dispatcher) {
    const environment = mergeProxyAwareEnv(process.platform, resolveSystemProxyEnv(), process.env);
    dispatcher = new EnvHttpProxyAgent({
      httpProxy: environment.HTTP_PROXY ?? environment.ALL_PROXY ?? '',
      httpsProxy: environment.HTTPS_PROXY ?? environment.HTTP_PROXY ?? environment.ALL_PROXY ?? '',
      noProxy: environment.NO_PROXY ?? '',
    });
  }
  const requestInit: RequestInit = { ...init };
  Object.assign(requestInit, { dispatcher });
  return fetch(input, requestInit);
};
