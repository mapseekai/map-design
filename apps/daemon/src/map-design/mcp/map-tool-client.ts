import {
  MapToolEnvelopeSchema,
  MapToolInputSchemas,
  MapToolOutputSchemas,
  type MapToolEnvelope,
  type MapToolName,
} from '@mapseekai/map-design-contracts';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type MapToolClientErrorKind =
  | 'invalid_input'
  | 'unauthorized'
  | 'transport'
  | 'invalid_response';

export class MapToolClientError extends Error {
  constructor(readonly kind: MapToolClientErrorKind) {
    super(kind);
    this.name = 'MapToolClientError';
  }
}

export interface MapToolHttpClientOptions {
  daemonUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface MapToolHttpClient {
  call(tool: MapToolName, input: unknown): Promise<MapToolEnvelope<unknown>>;
}

export function createMapToolHttpClient(options: MapToolHttpClientOptions): MapToolHttpClient {
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new MapToolClientError('transport');
  }
  const baseUrl = parseBaseUrl(options.daemonUrl);
  return {
    async call(tool, rawInput) {
      const parsedInput = MapToolInputSchemas[tool].safeParse(rawInput);
      if (!parsedInput.success) throw new MapToolClientError('invalid_input');
      const requestBody = JSON.stringify(parsedInput.data);
      if (Buffer.byteLength(requestBody, 'utf8') > MAX_REQUEST_BYTES) {
        throw new MapToolClientError('invalid_input');
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      try {
        let response: Response;
        try {
          response = await request(toolEndpoint(baseUrl, tool), {
            method: 'POST',
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${options.token}`,
              'content-type': 'application/json',
            },
            body: requestBody,
            signal: controller.signal,
          });
        } catch {
          throw new MapToolClientError('transport');
        }
        if (response.status === 401 || response.status === 403) {
          throw new MapToolClientError('unauthorized');
        }
        let body: unknown;
        try {
          body = JSON.parse(await readBoundedResponse(response)) as unknown;
        } catch (error) {
          if (controller.signal.aborted) throw new MapToolClientError('transport');
          if (error instanceof MapToolClientError) throw error;
          throw new MapToolClientError('invalid_response');
        }
        const envelope = MapToolEnvelopeSchema(MapToolOutputSchemas[tool]).safeParse(body);
        if (!envelope.success || (!response.ok && envelope.data.ok)) {
          throw new MapToolClientError('invalid_response');
        }
        return envelope.data;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function parseBaseUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
    return url;
  } catch {
    throw new MapToolClientError('transport');
  }
}

function toolEndpoint(base: URL, tool: MapToolName): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/api/map-design/tools/${tool}`.replace(/\/+/gu, '/');
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new MapToolClientError('invalid_response');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new MapToolClientError('invalid_response');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
