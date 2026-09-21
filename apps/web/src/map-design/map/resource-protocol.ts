import type { AddProtocolAction, GetResourceResponse, RequestParameters } from 'maplibre-gl';

export const MAP_DESIGN_RESOURCE_PROTOCOL = 'map-design-resource';
const RESOURCE_PATH = /^\/api\/map-design\/(?:projects|source-previews)\/[^/]+\/resources\/[^/]+(?:\/.*)?$/;

/** MapLibre uses error.status to handle missing tiles and parent-tile fallback. */
export class MapResourceRequestError extends Error {
  constructor(readonly status: number, readonly retryAfter?: string) {
    super(`MapDesign resource request failed (${status}).`);
    this.name = 'MapResourceRequestError';
  }
}

export interface MapDesignResourceProtocolOptions {
  origin?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
}

export function assertMapDesignGatewayUrl(value: string, origin = browserOrigin()): URL {
  const url = new URL(value, origin);
  if (url.origin !== origin || url.username || url.password || !RESOURCE_PATH.test(url.pathname)) {
    throw new TypeError('MapDesign resources must use the same-origin project resource gateway.');
  }
  return url;
}

export function createMapDesignResourceProtocol(options: MapDesignResourceProtocolOptions = {}): AddProtocolAction {
  const origin = options.origin ?? browserOrigin();
  const fetcher = options.fetch ?? globalThis.fetch;
  return async (request: RequestParameters, abortController: AbortController): Promise<GetResourceResponse<unknown>> => {
    const raw = stripProtocol(request.url, MAP_DESIGN_RESOURCE_PROTOCOL);
    const url = assertMapDesignGatewayUrl(raw, origin);
    const response = await fetcher(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: options.headers,
      signal: abortController.signal,
    });
    if (!response.ok) throw new MapResourceRequestError(response.status, response.headers.get('retry-after') ?? undefined);
    const data = request.type === 'json'
      ? await response.json()
      : request.type === 'arrayBuffer' || request.type === 'image'
        ? await response.arrayBuffer()
        : await response.text();
    return {
      data,
      cacheControl: response.headers.get('cache-control') ?? undefined,
      expires: response.headers.get('expires') ?? undefined,
      etag: response.headers.get('etag') ?? undefined,
    };
  };
}

export function stripProtocol(value: string, scheme: string): string {
  const prefix = `${scheme}://`;
  if (!value.startsWith(prefix)) throw new TypeError(`Expected ${scheme} protocol URL.`);
  return value.slice(prefix.length);
}

function browserOrigin(): string {
  if (typeof window === 'undefined') throw new TypeError('A browser origin is required for MapDesign resources.');
  return window.location.origin;
}
