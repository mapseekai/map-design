type JsonRecord = Record<string, unknown>;

type ApiClientErrorShape = {
  message: string;
  code?: string | null;
  details?: unknown;
  retryable?: boolean;
  status?: number;
};

const DEFAULT_INVALID_RESPONSE_MESSAGE = 'The local daemon returned an invalid response.';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(error: ApiClientErrorShape);
  constructor(
    message: string,
    status: number,
    code?: string | null,
    details?: unknown,
    retryable?: boolean,
  );
  constructor(
    messageOrError: string | ApiClientErrorShape,
    status = 0,
    code: string | null = null,
    details: unknown = null,
    retryable = false,
  ) {
    const error = typeof messageOrError === 'string'
      ? { message: messageOrError, status, code, details, retryable }
      : messageOrError;
    super(error.message);
    this.name = 'ApiClientError';
    this.status = error.status ?? 0;
    this.code = error.code ?? null;
    this.details = error.details ?? null;
    this.retryable = error.retryable ?? false;
  }
}

export async function request<T>(
  url: string,
  init: RequestInit,
  parse: (value: unknown) => boolean,
  invalidResponseMessage = DEFAULT_INVALID_RESPONSE_MESSAGE,
): Promise<T> {
  const response = await fetch(url, init);
  let body: unknown;
  try {
    body = await readJson(response);
  } catch (error) {
    if (error instanceof ApiClientError && invalidResponseMessage !== DEFAULT_INVALID_RESPONSE_MESSAGE) {
      throw new ApiClientError(invalidResponseMessage, response.status, 'INVALID_RESPONSE');
    }
    throw error;
  }
  if (!response.ok) {
    const outer = record(body);
    const error = outer ? record(outer.error) : null;
    const message = string(error?.message);
    if (!message && invalidResponseMessage !== DEFAULT_INVALID_RESPONSE_MESSAGE) {
      throw new ApiClientError(invalidResponseMessage, response.status, 'INVALID_RESPONSE');
    }
    throw new ApiClientError(
      message ?? `The local daemon request failed (${response.status}).`,
      response.status,
      string(error?.code),
      error?.details,
      typeof error?.retryable === 'boolean' ? error.retryable : false,
    );
  }
  if (!parse(body)) {
    throw new ApiClientError(invalidResponseMessage, response.status, 'INVALID_RESPONSE');
  }
  return body as T;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiClientError('The local daemon returned invalid JSON.', response.status);
  }
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
