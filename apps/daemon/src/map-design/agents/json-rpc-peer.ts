import { Buffer } from 'node:buffer';

export type JsonRpcId = number | string;

export class JsonRpcProtocolError extends Error {
  constructor(message = 'Invalid JSON-RPC frame.') {
    super(message);
    this.name = 'JsonRpcProtocolError';
  }
}

export class JsonRpcRemoteError extends Error {
  constructor() {
    super('The JSON-RPC peer returned an error.');
    this.name = 'JsonRpcRemoteError';
  }
}

export type JsonRpcPeerOptions = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  maxFrameBytes?: number;
  onNotification?: (method: string, params: unknown) => void | Promise<void>;
  onRequest?: (method: string, params: unknown, id: JsonRpcId) => unknown | Promise<unknown>;
  onError?: (error: Error) => void;
};

export interface JsonRpcPeer {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  close(reason?: Error): void;
  readonly closed: boolean;
}

const DEFAULT_MAX_FRAME_BYTES = 1_048_576;

export function createJsonRpcPeer(options: JsonRpcPeerOptions): JsonRpcPeer {
  const maximum = positiveFrameLimit(options.maxFrameBytes);
  const pending = new Map<JsonRpcId, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  let closed = false;

  const removeListeners = (): void => {
    options.input.removeListener('data', onData);
    options.input.removeListener('end', onEnd);
    options.input.removeListener('error', onInputError);
    options.output.removeListener('error', onOutputError);
  };

  const terminate = (reason: Error, report: boolean): void => {
    if (closed) return;
    closed = true;
    removeListeners();
    for (const waiter of pending.values()) waiter.reject(reason);
    pending.clear();
    if (report) options.onError?.(reason);
  };

  const writeFrame = (frame: Record<string, unknown>): void => {
    if (closed) throw new JsonRpcProtocolError('The JSON-RPC peer is closed.');
    let encoded: string;
    try {
      encoded = `${JSON.stringify(frame)}\n`;
    } catch {
      throw new JsonRpcProtocolError('The JSON-RPC frame could not be encoded.');
    }
    if (Buffer.byteLength(encoded) > maximum) {
      const error = new JsonRpcProtocolError('The JSON-RPC frame exceeds the configured limit.');
      terminate(error, true);
      throw error;
    }
    try {
      options.output.write(encoded);
    } catch {
      const error = new JsonRpcProtocolError('The JSON-RPC peer output failed.');
      terminate(error, true);
      throw error;
    }
  };

  const handleResponse = (frame: Record<string, unknown>): void => {
    const id = jsonRpcId(frame.id);
    if (id === null) throw new JsonRpcProtocolError();
    const waiter = pending.get(id);
    if (!waiter) throw new JsonRpcProtocolError('The JSON-RPC response id is unknown.');
    const hasResult = Object.hasOwn(frame, 'result');
    const hasError = Object.hasOwn(frame, 'error');
    if (hasResult === hasError) throw new JsonRpcProtocolError();
    pending.delete(id);
    if (hasError) waiter.reject(new JsonRpcRemoteError());
    else waiter.resolve(frame.result);
  };

  const handleServerRequest = (frame: Record<string, unknown>, method: string, id: JsonRpcId): void => {
    void Promise.resolve(options.onRequest?.(method, frame.params, id))
      .then((result) => {
        if (!closed) writeFrame({ id, result: result ?? null });
      })
      .catch(() => {
        if (!closed) {
          writeFrame({
            id,
            error: { code: -32_000, message: 'The client could not complete the request.' },
          });
        }
      });
  };

  const handleNotification = (frame: Record<string, unknown>, method: string): void => {
    void Promise.resolve(options.onNotification?.(method, frame.params)).catch(() => {
      terminate(new JsonRpcProtocolError('The JSON-RPC notification was invalid.'), true);
    });
  };

  const handleFrame = (value: unknown): void => {
    if (!isRecord(value)) throw new JsonRpcProtocolError();
    if (Object.hasOwn(value, 'jsonrpc') && value.jsonrpc !== '2.0') throw new JsonRpcProtocolError();
    if (Object.hasOwn(value, 'method')) {
      if (typeof value.method !== 'string' || value.method.length === 0) throw new JsonRpcProtocolError();
      if (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error')) throw new JsonRpcProtocolError();
      if (!Object.hasOwn(value, 'id')) {
        handleNotification(value, value.method);
        return;
      }
      const id = jsonRpcId(value.id);
      if (id === null) throw new JsonRpcProtocolError();
      handleServerRequest(value, value.method, id);
      return;
    }
    handleResponse(value);
  };

  function onData(chunk: Buffer | string): void {
    if (closed) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    buffer = buffer.length === 0 ? bytes : Buffer.concat([buffer, bytes]);
    try {
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) {
          if (buffer.length > maximum) throw new JsonRpcProtocolError('The JSON-RPC frame exceeds the configured limit.');
          return;
        }
        if (newline + 1 > maximum) throw new JsonRpcProtocolError('The JSON-RPC frame exceeds the configured limit.');
        const frame = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        const trimmed = frame.length > 0 && frame[frame.length - 1] === 0x0d
          ? frame.subarray(0, frame.length - 1)
          : frame;
        if (trimmed.length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed.toString('utf8'));
        } catch {
          throw new JsonRpcProtocolError();
        }
        handleFrame(parsed);
        if (closed) return;
      }
    } catch (error) {
      terminate(error instanceof Error ? error : new JsonRpcProtocolError(), true);
    }
  }

  function onEnd(): void {
    if (!closed) terminate(new JsonRpcProtocolError('The JSON-RPC peer ended unexpectedly.'), true);
  }

  function onInputError(): void {
    terminate(new JsonRpcProtocolError('The JSON-RPC peer input failed.'), true);
  }

  function onOutputError(): void {
    terminate(new JsonRpcProtocolError('The JSON-RPC peer output failed.'), true);
  }

  options.input.on('data', onData);
  options.input.on('end', onEnd);
  options.input.on('error', onInputError);
  options.output.on('error', onOutputError);

  return {
    request(method, params) {
      if (!method) return Promise.reject(new JsonRpcProtocolError());
      if (closed) return Promise.reject(new JsonRpcProtocolError('The JSON-RPC peer is closed.'));
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          writeFrame({ id, method, params });
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new JsonRpcProtocolError());
        }
      });
    },
    notify(method, params) {
      if (!method) throw new JsonRpcProtocolError();
      writeFrame({ method, params });
    },
    close(reason = new JsonRpcProtocolError('The JSON-RPC peer was closed.')) {
      terminate(reason, false);
    },
    get closed() {
      return closed;
    },
  };
}

function positiveFrameLimit(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? value!
    : DEFAULT_MAX_FRAME_BYTES;
}

function jsonRpcId(value: unknown): JsonRpcId | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
