import { Buffer } from 'node:buffer';

interface PendingRequest {
  type: string;
  onSuccess?: () => void;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface ReadyWaiter {
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface CommandRpcPeerOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  protocolName: string;
  defaultMaxFrameBytes: number;
  maxFrameBytes?: number;
  createError(message?: string): Error;
  requestId(type: string, sequence: number): string;
  parseReadyFrame?: (frame: Record<string, unknown>) => number | undefined;
  onFrame?: (frame: Record<string, unknown>) => void;
  onError?: () => void;
}

export class CommandRpcPeer {
  private buffer = Buffer.alloc(0);
  private limit: number;
  private sequence = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly readyWaiters: ReadyWaiter[] = [];
  closed = false;

  constructor(private readonly options: CommandRpcPeerOptions) {
    this.limit = positiveLimit(options.maxFrameBytes, options.defaultMaxFrameBytes);
    options.input.on('data', this.onData);
    options.input.on('end', this.onEnd);
    options.input.on('error', this.onEnd);
    options.output.on('error', this.onEnd);
  }

  nextId(type = 'request'): string {
    this.sequence += 1;
    return this.options.requestId(type, this.sequence);
  }

  waitForReady(timeoutMs: number): Promise<void> {
    if (this.closed) return Promise.reject(this.error(`The ${this.options.protocolName} peer is closed.`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(this.error(`The ${this.options.protocolName} ready frame timed out.`)),
        timeoutMs,
      );
      this.readyWaiters.push({ resolve, reject, timer });
    });
  }

  request(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    onSuccess?: () => void,
  ): Promise<unknown> {
    const id = this.nextId(type);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.error(`The ${type} request timed out.`));
      }, timeoutMs);
      this.pending.set(id, { type, resolve, reject, timer, ...(onSuccess ? { onSuccess } : {}) });
      try {
        this.send({ id, type, ...payload });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : this.error());
      }
    });
  }

  send(frame: Record<string, unknown>): void {
    if (this.closed) throw this.error(`The ${this.options.protocolName} peer is closed.`);
    const encoded = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(encoded) > this.limit) {
      throw this.error(`The ${this.options.protocolName} frame exceeds the configured limit.`);
    }
    this.options.output.write(encoded);
  }

  close(): void {
    this.terminate(false);
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.closed) return;
    const bytes = Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);
    try {
      while (true) {
        const newline = this.buffer.indexOf(0x0a);
        if (newline < 0) {
          if (this.buffer.length > this.limit) throw this.frameLimitError();
          return;
        }
        if (newline + 1 > this.limit) throw this.frameLimitError();
        const line = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        if (line.length === 0) continue;
        let frame: unknown;
        try {
          frame = JSON.parse(line.toString('utf8'));
        } catch {
          throw this.error();
        }
        this.handleFrame(frame);
      }
    } catch {
      this.terminate(true);
    }
  };

  private readonly onEnd = (): void => this.terminate(true);

  private handleFrame(value: unknown): void {
    const frame = record(value);
    const type = nonEmptyString(frame?.type);
    if (!frame || !type) throw this.error();

    const readyLimit = this.options.parseReadyFrame?.(frame);
    if (readyLimit !== undefined) {
      this.limit = Math.min(this.limit, readyLimit);
      const waiter = this.readyWaiters.shift();
      if (!waiter) throw this.error(`Duplicate ${this.options.protocolName} ready frame.`);
      clearTimeout(waiter.timer);
      waiter.resolve();
      return;
    }

    if (type === 'response') {
      this.handleResponse(frame);
      return;
    }
    this.options.onFrame?.(frame);
  }

  private handleResponse(frame: Record<string, unknown>): void {
    const id = safeIdentifier(frame.id);
    const pending = id ? this.pending.get(id) : undefined;
    if (!pending) throw this.error(`Unexpected ${this.options.protocolName} response.`);
    this.pending.delete(id!);
    clearTimeout(pending.timer);
    if (frame.command !== pending.type) {
      const error = this.error(`${this.options.protocolName} response command did not match its request.`);
      pending.reject(error);
      throw error;
    }
    if (frame.success === true) {
      try {
        pending.onSuccess?.();
        pending.resolve(frame.data);
      } catch (error) {
        const protocolError = error instanceof Error ? error : this.error();
        pending.reject(protocolError);
        throw protocolError;
      }
      return;
    }
    if (frame.success === false && typeof frame.error === 'string') {
      pending.reject(this.error(frame.error));
      return;
    }
    const error = this.error();
    pending.reject(error);
    throw error;
  }

  private terminate(report: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.options.input.removeListener('data', this.onData);
    this.options.input.removeListener('end', this.onEnd);
    this.options.input.removeListener('error', this.onEnd);
    this.options.output.removeListener('error', this.onEnd);
    const error = this.error(`The ${this.options.protocolName} peer ended unexpectedly.`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.readyWaiters.length = 0;
    if (report) this.options.onError?.();
  }

  private frameLimitError(): Error {
    return this.error(`The ${this.options.protocolName} frame exceeds the configured limit.`);
  }

  private error(message?: string): Error {
    return this.options.createError(message);
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? Math.min(value!, fallback)
    : fallback;
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\r\n\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
