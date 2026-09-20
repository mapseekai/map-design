import {gunzipSync} from 'node:zlib';

import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';

import type {Evidence, FieldType, GeometryType} from './types.js';

type Category = string | number | boolean | null;

const MAX_CATEGORIES = 256;
export const DEFAULT_DECODED_BYTE_LIMIT = 5 * 1024 * 1024;
const SENSITIVE_FIELD_WORDS = new Set([
  'authorization',
  'authorizations',
  'auth',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'password',
  'passwords',
  'passwd',
  'passwds',
  'passphrase',
  'passphrases',
  'pwd',
  'pwds',
  'secret',
  'secrets',
  'session',
  'sessions',
  'token',
  'tokens',
  'apikey',
  'apikeys',
  'apitoken',
  'apitokens',
]);

export interface FieldObservation {
  types: FieldType[];
  categories: Category[];
  minimum?: number;
  maximum?: number;
  presentCount: number;
  missingCount: number;
  missingObserved: boolean;
  nullObserved: boolean;
  categoriesTruncated?: boolean;
  sensitiveValuesRedacted?: boolean;
}

export interface TileObservation {
  layers: Record<
    string,
    {
      geometries: GeometryType[];
      featureCount: number;
      stableIdObserved: boolean;
      fields: Record<string, FieldObservation>;
    }
  >;
}

export class TileDecodeError extends Error {
  readonly code:
    | 'tile-decode-failed'
    | 'tile-decoded-too-large'
    | 'tile-unsafe-64-bit-value';
  readonly evidence: Evidence;
  readonly cause: unknown;

  constructor(
    message: string,
    evidence: Evidence,
    cause: unknown,
    code:
      | 'tile-decode-failed'
      | 'tile-decoded-too-large'
      | 'tile-unsafe-64-bit-value' = 'tile-decode-failed',
  ) {
    super(message);
    this.name = 'TileDecodeError';
    this.code = code;
    this.evidence = evidence;
    this.cause = cause;
  }
}

class DecodedTileTooLargeError extends Error {
  constructor() {
    super('Decoded tile output exceeded its configured byte limit.');
    this.name = 'DecodedTileTooLargeError';
  }
}

class Unsafe64BitValueError extends Error {
  constructor() {
    super('An MVT integer value cannot be represented safely as a JavaScript number.');
    this.name = 'Unsafe64BitValueError';
  }
}

function record<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function fieldType(value: unknown): FieldType {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) return 'json';
  return 'unknown';
}

function category(value: unknown): Category | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sensitiveFieldName(fieldName: string): boolean {
  const words = fieldName
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean);
  if (words.some((word) => SENSITIVE_FIELD_WORDS.has(word))) return true;
  return words.some(
    (word, index) =>
      word === 'api' && /^(?:keys?|tokens?)$/.test(words[index + 1] ?? ''),
  );
}

function obviousCredentialScalar(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const scalar = value.trim();
  return (
    /^(?:basic|bearer|digest|negotiate|aws4-hmac-sha256)\s+\S+/i.test(scalar) ||
    /^(?:api[-_ ]?key|authorization|cookie|credential|password|secret|session(?:id)?|token)\s*[:=]\s*\S+/i.test(
      scalar,
    ) ||
    /^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(scalar) ||
    /^[A-Za-z\d_-]{10,}\.[A-Za-z\d_-]{10,}\.[A-Za-z\d_-]{8,}$/.test(scalar) ||
    /^(?:sk-[A-Za-z\d_-]{16,}|gh[pousr]_[A-Za-z\d]{20,}|AKIA[A-Z\d]{16})$/.test(scalar) ||
    /^[a-z][a-z\d+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i.test(scalar)
  );
}

function geometryType(type: number): GeometryType {
  if (type === 1) return 'point';
  if (type === 2) return 'line';
  if (type === 3) return 'polygon';
  return 'unknown';
}

function includesCategory(categories: Category[], value: Category): boolean {
  return categories.some((categoryValue) => Object.is(categoryValue, value));
}

function appendCategory(field: FieldObservation, value: Category): void {
  if (includesCategory(field.categories, value)) return;
  if (field.categories.length >= MAX_CATEGORIES) {
    field.categoriesTruncated = true;
    return;
  }
  field.categories.push(value);
}

function appendType(field: FieldObservation, type: FieldType): void {
  if (!field.types.includes(type)) field.types.push(type);
}

function observeInto(field: FieldObservation, value: unknown, fieldName = ''): void {
  appendType(field, fieldType(value));
  field.presentCount += 1;
  if (value === null) field.nullObserved = true;

  const sensitive = sensitiveFieldName(fieldName) || obviousCredentialScalar(value);
  if (sensitive) {
    field.sensitiveValuesRedacted = true;
    return;
  }

  const observedCategory = category(value);
  if (observedCategory !== undefined) appendCategory(field, observedCategory);

  if (typeof value === 'number' && Number.isFinite(value)) {
    field.minimum = field.minimum === undefined ? value : Math.min(field.minimum, value);
    field.maximum = field.maximum === undefined ? value : Math.max(field.maximum, value);
  }
}

export function observeValue(value: unknown, fieldName = ''): FieldObservation {
  const observation: FieldObservation = {
    types: [],
    categories: [],
    presentCount: 0,
    missingCount: 0,
    missingObserved: false,
    nullObserved: false,
  };
  observeInto(observation, value, fieldName);
  return observation;
}

function invalidPbf(): never {
  throw new Error('PBF contains a truncated or invalid wire value.');
}

function readUnsignedVarint(
  bytes: Uint8Array,
  offset: number,
): {value: bigint; offset: number} {
  let value = 0n;
  for (let index = 0; index < 10; index += 1) {
    if (offset >= bytes.length) invalidPbf();
    const byte = bytes[offset]!;
    offset += 1;
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if (byte < 0x80) {
      if (index === 9 && byte > 1) invalidPbf();
      return {value, offset};
    }
  }
  return invalidPbf();
}

function readBoundedVarint(bytes: Uint8Array, offset: number): {value: number; offset: number} {
  const result = readUnsignedVarint(bytes, offset);
  if (result.value > BigInt(Number.MAX_SAFE_INTEGER)) invalidPbf();
  return {value: Number(result.value), offset: result.offset};
}

function uint32(value: bigint): number {
  if (value > 0xffff_ffffn) invalidPbf();
  return Number(value);
}

function validatePackedUint32(bytes: Uint8Array): number[] {
  const values: number[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const result = readUnsignedVarint(bytes, offset);
    values.push(uint32(result.value));
    offset = result.offset;
  }
  return values;
}

function requireWireType(actual: number, expected: number): void {
  if (actual !== expected) invalidPbf();
}

function requirePayload(payload: Uint8Array | undefined): Uint8Array {
  if (!payload) invalidPbf();
  return payload;
}

function validateMessage(
  bytes: Uint8Array,
  validateField: (
    field: number,
    wireType: number,
    payload: Uint8Array | undefined,
    scalar: bigint | undefined,
  ) => void,
): void {
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readBoundedVarint(bytes, offset);
    offset = tag.offset;
    const field = Math.floor(tag.value / 8);
    const wireType = tag.value & 7;
    if (field === 0) invalidPbf();

    if (wireType === 0) {
      const scalar = readUnsignedVarint(bytes, offset);
      offset = scalar.offset;
      validateField(field, wireType, undefined, scalar.value);
      continue;
    }
    if (wireType === 1 || wireType === 5) {
      const end = offset + (wireType === 1 ? 8 : 4);
      if (end > bytes.length) invalidPbf();
      offset = end;
      validateField(field, wireType, undefined, undefined);
      continue;
    }
    if (wireType !== 2) invalidPbf();

    const length = readBoundedVarint(bytes, offset);
    offset = length.offset;
    const end = offset + length.value;
    if (!Number.isSafeInteger(end) || end > bytes.length) invalidPbf();
    const payload = bytes.subarray(offset, end);
    offset = end;
    validateField(field, wireType, payload, undefined);
  }
}

function requireScalar(value: bigint | undefined): bigint {
  if (value === undefined) invalidPbf();
  return value;
}

function requiredString(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) invalidPbf();
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return invalidPbf();
  }
}

interface ValidatedFeature {
  tags: number[];
  type: number;
  geometry: number[];
}

function validateFeature(bytes: Uint8Array): ValidatedFeature {
  const tags: number[] = [];
  const geometry: number[] = [];
  let type: number | undefined;

  validateMessage(bytes, (field, wireType, payload, scalar) => {
    if (field === 1) {
      requireWireType(wireType, 0);
      return;
    }
    if (field === 2) {
      requireWireType(wireType, 2);
      tags.push(...validatePackedUint32(requirePayload(payload)));
      return;
    }
    if (field === 3) {
      requireWireType(wireType, 0);
      if (type !== undefined) invalidPbf();
      type = uint32(requireScalar(scalar));
      return;
    }
    if (field === 4) {
      requireWireType(wireType, 2);
      geometry.push(...validatePackedUint32(requirePayload(payload)));
    }
  });

  if (type === undefined || type < 1 || type > 3) invalidPbf();
  if (tags.length % 2 !== 0 || geometry.length === 0) invalidPbf();
  return {tags, type, geometry};
}

interface ValidatedValue {
  exactInteger?: number;
}

const UINT64_LIMIT = 1n << 64n;
const INT64_SIGN = 1n << 63n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

function safeInteger(value: bigint): number {
  if (value < MIN_SAFE_BIGINT || value > MAX_SAFE_BIGINT) {
    throw new Unsafe64BitValueError();
  }
  return Number(value);
}

function signedInt64(raw: bigint): bigint {
  return raw >= INT64_SIGN ? raw - UINT64_LIMIT : raw;
}

function signedZigZag64(raw: bigint): bigint {
  return raw % 2n === 0n ? raw / 2n : -(raw + 1n) / 2n;
}

function validateValue(bytes: Uint8Array): ValidatedValue {
  let variants = 0;
  let exactInteger: number | undefined;
  validateMessage(bytes, (field, wireType, _payload, scalar) => {
    if (field === 1) {
      requireWireType(wireType, 2);
      variants += 1;
    } else if (field === 2) {
      requireWireType(wireType, 5);
      variants += 1;
    } else if (field === 3) {
      requireWireType(wireType, 1);
      variants += 1;
    } else if (field >= 4 && field <= 7) {
      requireWireType(wireType, 0);
      variants += 1;
      if (field === 4) exactInteger = safeInteger(signedInt64(requireScalar(scalar)));
      else if (field === 5) exactInteger = safeInteger(requireScalar(scalar));
      else if (field === 6) exactInteger = safeInteger(signedZigZag64(requireScalar(scalar)));
    }
  });
  if (variants !== 1) invalidPbf();
  return exactInteger === undefined ? {} : {exactInteger};
}

function zigZag(value: number): number {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

interface GeometryState {
  offset: number;
  x: number;
  y: number;
}

function geometryCommand(
  geometry: number[],
  state: GeometryState,
): {id: number; count: number} {
  if (state.offset >= geometry.length) invalidPbf();
  const command = geometry[state.offset++]!;
  const id = command % 8;
  const count = Math.floor(command / 8);
  if (count === 0 || (id !== 1 && id !== 2 && id !== 7)) invalidPbf();
  return {id, count};
}

function geometryParameters(
  geometry: number[],
  state: GeometryState,
  count: number,
  rejectZeroDelta = false,
): void {
  if (count > Math.floor((geometry.length - state.offset) / 2)) invalidPbf();
  for (let index = 0; index < count; index += 1) {
    const encodedX = geometry[state.offset++]!;
    const encodedY = geometry[state.offset++]!;
    const deltaX = zigZag(encodedX);
    const deltaY = zigZag(encodedY);
    if (rejectZeroDelta && deltaX === 0 && deltaY === 0) invalidPbf();
    state.x += deltaX;
    state.y += deltaY;
    if (!Number.isSafeInteger(state.x) || !Number.isSafeInteger(state.y)) invalidPbf();
  }
}

function validateGeometry(type: number, geometry: number[]): void {
  const state: GeometryState = {offset: 0, x: 0, y: 0};

  if (type === 1) {
    const move = geometryCommand(geometry, state);
    if (move.id !== 1) invalidPbf();
    geometryParameters(geometry, state, move.count);
    if (state.offset !== geometry.length) invalidPbf();
    return;
  }

  while (state.offset < geometry.length) {
    const move = geometryCommand(geometry, state);
    if (move.id !== 1 || move.count !== 1) invalidPbf();
    geometryParameters(geometry, state, move.count);

    const line = geometryCommand(geometry, state);
    if (line.id !== 2 || line.count < (type === 3 ? 2 : 1)) invalidPbf();
    geometryParameters(geometry, state, line.count, true);

    if (type === 3) {
      const close = geometryCommand(geometry, state);
      if (close.id !== 7 || close.count !== 1) invalidPbf();
    }
  }
}

interface ValidatedLayer {
  integerProperties: Array<Record<string, number>>;
  name: string;
}

function validateLayer(bytes: Uint8Array): ValidatedLayer {
  const features: ValidatedFeature[] = [];
  let name: string | undefined;
  let version: number | undefined;
  let extent = 4096;
  let extentSeen = false;
  const keys: string[] = [];
  const values: ValidatedValue[] = [];

  validateMessage(bytes, (field, wireType, payload, scalar) => {
    if (field === 1) {
      requireWireType(wireType, 2);
      if (name !== undefined) invalidPbf();
      name = requiredString(requirePayload(payload));
      return;
    }
    if (field === 2) {
      requireWireType(wireType, 2);
      features.push(validateFeature(requirePayload(payload)));
      return;
    }
    if (field === 3) {
      requireWireType(wireType, 2);
      keys.push(requiredString(requirePayload(payload)));
      return;
    }
    if (field === 4) {
      requireWireType(wireType, 2);
      values.push(validateValue(requirePayload(payload)));
      return;
    }
    if (field === 5) {
      requireWireType(wireType, 0);
      if (extentSeen) invalidPbf();
      extentSeen = true;
      extent = uint32(requireScalar(scalar));
      return;
    }
    if (field === 15) {
      requireWireType(wireType, 0);
      if (version !== undefined) invalidPbf();
      version = uint32(requireScalar(scalar));
    }
  });

  if (name === undefined || version === undefined || (version !== 1 && version !== 2)) {
    invalidPbf();
  }
  if (extent === 0) invalidPbf();

  for (const feature of features) {
    for (let index = 0; index < feature.tags.length; index += 2) {
      if (feature.tags[index]! >= keys.length || feature.tags[index + 1]! >= values.length) {
        invalidPbf();
      }
    }
    validateGeometry(feature.type, feature.geometry);
  }
  const integerProperties = features.map((feature) => {
    const properties = record<number>();
    for (let index = 0; index < feature.tags.length; index += 2) {
      const key = keys[feature.tags[index]!]!;
      const value = values[feature.tags[index + 1]!]!;
      if (value.exactInteger !== undefined) properties[key] = value.exactInteger;
      else delete properties[key];
    }
    return properties;
  });
  return {name, integerProperties};
}

function validateTile(bytes: Uint8Array): Record<string, Array<Record<string, number>>> {
  const layerNames = new Set<string>();
  const integerProperties = record<Array<Record<string, number>>>();
  validateMessage(bytes, (field, wireType, payload) => {
    if (field === 3) {
      requireWireType(wireType, 2);
      const layer = validateLayer(requirePayload(payload));
      if (layerNames.has(layer.name)) invalidPbf();
      layerNames.add(layer.name);
      integerProperties[layer.name] = layer.integerProperties;
    }
  });
  return integerProperties;
}

function decodedTileBytes(bytes: Uint8Array, decodedByteLimit: number): Uint8Array {
  if (!Number.isSafeInteger(decodedByteLimit) || decodedByteLimit < 0) {
    throw new RangeError('The decoded MVT byte limit must be a non-negative safe integer.');
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      return gunzipSync(bytes, {maxOutputLength: decodedByteLimit});
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ERR_BUFFER_TOO_LARGE'
      ) {
        throw new DecodedTileTooLargeError();
      }
      throw error;
    }
  }
  if (bytes.byteLength > decodedByteLimit) throw new DecodedTileTooLargeError();
  return bytes;
}

function parseTile(bytes: Uint8Array, decodedByteLimit: number): {
  integerProperties: Record<string, Array<Record<string, number>>>;
  tile: VectorTile;
} {
  const source = decodedTileBytes(bytes, decodedByteLimit);
  const integerProperties = validateTile(source);
  return {integerProperties, tile: new VectorTile(new PbfReader(source))};
}

/**
 * Observes the fields represented in one PBF/MVT tile without inferring
 * values for properties absent from an individual feature.
 */
export function decodeMvt(
  bytes: Uint8Array,
  evidence: Evidence,
  decodedByteLimit = DEFAULT_DECODED_BYTE_LIMIT,
): TileObservation {
  try {
    const {integerProperties, tile} = parseTile(bytes, decodedByteLimit);
    const layers = record<TileObservation['layers'][string]>();

    for (const [layerName, layer] of Object.entries(tile.layers)) {
      const fields = record<FieldObservation>();
      const geometries: GeometryType[] = [];
      let stableIdObserved = false;

      for (let index = 0; index < layer.length; index += 1) {
        const feature = layer.feature(index);
        const geometry = geometryType(feature.type);
        if (!geometries.includes(geometry)) geometries.push(geometry);
        if (feature.id !== undefined) stableIdObserved = true;

        for (const [fieldName, decodedValue] of Object.entries(feature.properties)) {
          const exactValues = integerProperties[layerName]?.[index];
          const value = exactValues && Object.hasOwn(exactValues, fieldName)
            ? exactValues[fieldName]
            : decodedValue;
          const field = fields[fieldName] ?? observeValue(value, fieldName);
          if (fields[fieldName] !== undefined) observeInto(field, value, fieldName);
          fields[fieldName] = field;
        }
      }

      for (const field of Object.values(fields)) {
        field.missingCount = layer.length - field.presentCount;
        field.missingObserved = field.missingCount > 0;
      }

      layers[layerName] = {
        geometries: geometries.sort(),
        featureCount: layer.length,
        stableIdObserved,
        fields,
      };
    }

    return {layers};
  } catch (error) {
    if (error instanceof TileDecodeError) throw error;
    if (error instanceof DecodedTileTooLargeError) {
      throw new TileDecodeError(
        'Decoded MVT tile output exceeded the configured byte limit.',
        evidence,
        error,
        'tile-decoded-too-large',
      );
    }
    if (error instanceof Unsafe64BitValueError) {
      throw new TileDecodeError(
        'An MVT integer value exceeded the JavaScript safe integer range.',
        evidence,
        error,
        'tile-unsafe-64-bit-value',
      );
    }
    throw new TileDecodeError('Unable to decode MVT tile bytes.', evidence, error);
  }
}
