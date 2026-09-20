import { hash as blake3Hash } from 'blake3-wasm';

const INVALID_JSON_VALUE = 'invalid JSON value';

function invalidJsonValue(): never {
  throw new TypeError(INVALID_JSON_VALUE);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : invalidJsonValue();
  if (typeof value !== 'object') return invalidJsonValue();
  if (ancestors.has(value)) return invalidJsonValue();

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).some((key) =>
        typeof key === 'symbol'
        || (typeof key === 'string' && key !== 'length' && !isArrayIndex(key)),
      )) {
        invalidJsonValue();
      }
      const normalized: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalidJsonValue();
        normalized.push(normalizeJsonValue(descriptor.value, ancestors));
      }
      return normalized;
    }
    if (!isPlainObject(value)) invalidJsonValue();
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) invalidJsonValue();
    const normalized = Object.create(null) as Record<string, unknown>;
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalidJsonValue();
      normalized[key] = normalizeJsonValue(descriptor.value, ancestors);
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

function isArrayIndex(key: string): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value, new Set<object>()));
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function blake3Digest(bytes: Uint8Array): string {
  return blake3Hash(bytes).toString('hex');
}
