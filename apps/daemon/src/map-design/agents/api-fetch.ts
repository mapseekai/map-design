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
  // Node and the installed undici package carry different Dispatcher typings,
  // but share the runtime dispatch contract used by Node's built-in fetch.
  return fetch(input, { ...init, dispatcher: dispatcher as unknown as NonNullable<RequestInit['dispatcher']> });
};
