import { Agent } from 'undici';
import type { LookupFunction } from 'node:net';
import type { PinnedTarget } from './network-policy.js';
import type { PinnedDispatchRequest, PinnedRequestDispatcher, RawPinnedResponse } from './pinned-transport.js';

type Entry = { agent: Agent; users: number; timer?: ReturnType<typeof setTimeout> };

/** Reuse only the SAME validated authority, IP, family and TLS name. */
export class PooledPinnedDispatcher implements PinnedRequestDispatcher {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  constructor(private readonly maxPools = 32, private readonly idleMs = 30_000) {}

  async request(target: PinnedTarget, request: PinnedDispatchRequest): Promise<RawPinnedResponse> {
    if (this.closed) throw new Error('Map transport is closed.');
    const key = JSON.stringify([target.url.origin, target.address, target.family, request.connectTimeoutMs]);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxPools) {
        const idle = [...this.entries].find(([, value]) => value.users === 0);
        if (!idle) throw new Error('Map connection pool is busy.');
        this.retire(idle[0], idle[1]);
      }
      const lookup = ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      }) as unknown as LookupFunction;
      entry = { users: 0, agent: new Agent({ connections: 6, pipelining: 1,
        connect: { timeout: request.connectTimeoutMs, lookup, servername: target.hostname },
      }) };
      this.entries.set(key, entry);
    }
    const current = entry;
    clearTimeout(current.timer);
    current.users++;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      current.users--;
      if (current.users === 0 && this.entries.get(key) === current) {
        current.timer = setTimeout(() => this.retire(key, current), this.idleMs);
        current.timer.unref();
      }
    };
    try {
      const response = await current.agent.request({ origin: target.url.origin,
        path: `${target.url.pathname}${target.url.search}`, method: 'GET', headers: request.headers,
        signal: request.signal, headersTimeout: request.headersTimeoutMs, bodyTimeout: request.bodyTimeoutMs,
      });
      return { statusCode: response.statusCode, headers: response.headers, body: response.body,
        close: release, destroy: release };
    } catch (error) { await release(); throw error; }
  }

  private retire(key: string, entry: Entry): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    clearTimeout(entry.timer);
    void entry.agent.close().catch(() => entry.agent.destroy()).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) clearTimeout(entry.timer);
    await Promise.all(entries.map((entry) => entry.agent.destroy()));
  }
}
