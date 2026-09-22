import { protocol } from "electron";

const MAP_DESIGN_SCHEME = "map-design";
const MAP_DESIGN_ENTRY_URL = `${MAP_DESIGN_SCHEME}://app/`;
type MapDesignProtocolTarget = string | null;
type ProtocolFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

protocol.registerSchemesAsPrivileged([{ privileges: { corsEnabled: true, secure: true, standard: true, stream: true, supportFetchAPI: true }, scheme: MAP_DESIGN_SCHEME }]);

function targetUrl(webUrl: MapDesignProtocolTarget, requestUrl: string): string | null {
  if (webUrl == null || webUrl.length === 0) return null;
  try {
    const target = new URL(webUrl);
    const request = new URL(requestUrl);
    target.pathname = request.pathname;
    target.search = request.search;
    return target.toString();
  } catch { return null; }
}

function proxiedHeaders(headers: Headers): Headers {
  const result = new Headers(headers);
  result.delete("content-encoding");
  result.delete("content-length");
  result.delete("transfer-encoding");
  result.set("access-control-allow-origin", "*");
  return result;
}

export async function handleMapDesignRequest(request: Request, webUrl: MapDesignProtocolTarget, fetchImpl: ProtocolFetch = fetch): Promise<Response> {
  const target = targetUrl(webUrl, request.url);
  if (target == null) return new Response(JSON.stringify({ error: "MAP_DESIGN_WEB_UNAVAILABLE" }), { status: 503 });
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    const upstream = await fetchImpl(new Request(target, {
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      // @ts-expect-error Node/Electron requires duplex for streaming request bodies.
      duplex: "half",
      headers: request.headers,
      method: request.method,
      signal: controller.signal,
    }));
    if (upstream.body == null) return new Response(null, { headers: proxiedHeaders(upstream.headers), status: upstream.status, statusText: upstream.statusText });
    const reader = upstream.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const next = await reader.read();
          if (next.done) stream.close();
          else stream.enqueue(next.value);
        } catch (error) { stream.error(error); }
      },
      async cancel() {
        abort();
        await reader.cancel().catch(() => undefined);
      },
    });
    return new Response(body, { headers: proxiedHeaders(upstream.headers), status: upstream.status, statusText: upstream.statusText });
  } catch (error) {
    return new Response(JSON.stringify({ error: "MAP_DESIGN_PROXY_FAILED", message: error instanceof Error ? error.message : String(error) }), { status: 502 });
  }
}

export function packagedEntryUrl(): string { return MAP_DESIGN_ENTRY_URL; }

export function registerMapDesignProtocol(resolveWebUrl: () => MapDesignProtocolTarget): void {
  // Use Node's HTTP stack: net.fetch rejects the custom-scheme Origin on module and font requests.
  protocol.handle(MAP_DESIGN_SCHEME, async (request) => await handleMapDesignRequest(request, resolveWebUrl()));
}
