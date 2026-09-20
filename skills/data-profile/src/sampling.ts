import {lookup} from 'node:dns/promises';
import {createReadStream} from 'node:fs';
import {request as requestHttp, type IncomingMessage} from 'node:http';
import {request as requestHttps} from 'node:https';
import {isIP, type LookupFunction} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {decodeMvt, TileDecodeError, type TileObservation} from './mvt.js';
import {sanitizeReference} from './sanitize.js';
import type {Evidence, SamplingSummary, UnresolvedItem} from './types.js';

const MEBIBYTE = 1024 * 1024;
const MAX_REDIRECTS = 3;

export interface SamplerOptions {
  template: string;
  bounds: [number, number, number, number];
  zooms: number[];
  concurrency: number;
  maxRequests: number;
  maxNonEmpty: number;
  stableStop: number;
  timeoutMs: number;
  retries: number;
  maxResponseBytes: number;
  maxTotalBytes: number;
  allowPrivateNetwork: boolean;
}

export interface TileCoordinate {
  z: number;
  x: number;
  y: number;
}

export type TileFetcher = (
  coordinate: TileCoordinate,
  signal: AbortSignal,
) => Promise<Uint8Array>;

export interface SamplingResult {
  observations: Array<{coordinate: TileCoordinate; observation: TileObservation}>;
  summary: SamplingSummary;
  unresolved: UnresolvedItem[];
}

export const DEFAULT_SAMPLER_OPTIONS = {
  concurrency: 4,
  maxRequests: 40,
  maxNonEmpty: 30,
  stableStop: 8,
  timeoutMs: 10_000,
  retries: 2,
  maxResponseBytes: 5 * MEBIBYTE,
  maxTotalBytes: 50 * MEBIBYTE,
  allowPrivateNetwork: false,
} as const;

class SamplingError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly budgetExhausted: boolean;

  constructor(code: string, retryable = false, budgetExhausted = false) {
    super(code);
    this.name = 'SamplingError';
    this.code = code;
    this.retryable = retryable;
    this.budgetExhausted = budgetExhausted;
  }
}

interface CandidateState {
  coordinate: TileCoordinate;
  attempts: number;
}

interface AttemptResult {
  state: CandidateState;
  bytes?: Uint8Array;
  error?: unknown;
}

interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

type TakeRequest = (coordinate: TileCoordinate) => boolean;

function finiteInteger(value: number, fallback: number, minimum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
}

function normalizedOptions(options: SamplerOptions): SamplerOptions {
  return {
    ...options,
    concurrency: finiteInteger(options.concurrency, DEFAULT_SAMPLER_OPTIONS.concurrency, 1),
    maxRequests: finiteInteger(options.maxRequests, DEFAULT_SAMPLER_OPTIONS.maxRequests, 0),
    maxNonEmpty: finiteInteger(options.maxNonEmpty, DEFAULT_SAMPLER_OPTIONS.maxNonEmpty, 0),
    stableStop: finiteInteger(options.stableStop, DEFAULT_SAMPLER_OPTIONS.stableStop, 1),
    timeoutMs: finiteInteger(options.timeoutMs, DEFAULT_SAMPLER_OPTIONS.timeoutMs, 1),
    retries: finiteInteger(options.retries, DEFAULT_SAMPLER_OPTIONS.retries, 0),
    maxResponseBytes: finiteInteger(
      options.maxResponseBytes,
      DEFAULT_SAMPLER_OPTIONS.maxResponseBytes,
      0,
    ),
    maxTotalBytes: finiteInteger(
      options.maxTotalBytes,
      DEFAULT_SAMPLER_OPTIONS.maxTotalBytes,
      0,
    ),
    allowPrivateNetwork: options.allowPrivateNetwork === true,
  };
}

function coordinateKey(coordinate: TileCoordinate): string {
  return `${coordinate.z}/${coordinate.x}/${coordinate.y}`;
}

function inset(value: number, direction: 1 | -1): number {
  return value + direction * Number.EPSILON * Math.max(1, Math.abs(value));
}

function tileCoordinate(longitude: number, inputLatitude: number, zoom: number): TileCoordinate {
  const scale = 2 ** zoom;
  const x = Math.floor(((longitude + 180) / 360) * scale);
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, inputLatitude));
  const y = Math.floor(
    ((1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2) * scale,
  );
  return {
    z: zoom,
    x: Math.max(0, Math.min(scale - 1, x)),
    y: Math.max(0, Math.min(scale - 1, y)),
  };
}

/** Returns deterministic center, inset-corner, and quarter-point tile candidates. */
export function tileCandidates(
  bounds: [number, number, number, number],
  zooms: number[],
): TileCoordinate[] {
  const [west, south, east, north] = bounds;
  const longitudeSpan = east - west;
  const latitudeSpan = north - south;
  const westInset = inset(west, 1);
  const eastInset = inset(east, -1);
  const southInset = inset(south, 1);
  const northInset = inset(north, -1);
  const points: Array<[number, number]> = [
    [west + longitudeSpan / 2, south + latitudeSpan / 2],
    [westInset, southInset],
    [westInset, northInset],
    [eastInset, southInset],
    [eastInset, northInset],
    [west + longitudeSpan / 4, south + latitudeSpan / 4],
    [west + longitudeSpan / 4, south + (latitudeSpan * 3) / 4],
    [west + (longitudeSpan * 3) / 4, south + latitudeSpan / 4],
    [west + (longitudeSpan * 3) / 4, south + (latitudeSpan * 3) / 4],
  ];
  const candidates = new Map<string, TileCoordinate>();
  const sortedZooms = [...new Set(zooms)]
    .filter((zoom) => Number.isInteger(zoom) && zoom >= 0 && zoom <= 30)
    .sort((left, right) => left - right);

  for (const zoom of sortedZooms) {
    for (const [longitude, latitude] of points) {
      const coordinate = tileCoordinate(longitude, latitude, zoom);
      candidates.set(coordinateKey(coordinate), coordinate);
    }
  }

  return [...candidates.values()].sort(
    (left, right) => left.z - right.z || left.x - right.x || left.y - right.y,
  );
}

function interpolate(template: string, coordinate: TileCoordinate): string {
  return template
    .replaceAll('{z}', String(coordinate.z))
    .replaceAll('{x}', String(coordinate.x))
    .replaceAll('{y}', String(coordinate.y));
}

function evidence(input: string, coordinate?: TileCoordinate): Evidence {
  return {
    kind: 'tile-sampled',
    input,
    location: coordinate ? `#/tiles/${coordinate.z}/${coordinate.x}/${coordinate.y}` : '#/tiles',
  };
}

function unresolvedItem(
  input: string,
  code: string,
  message: string,
  coordinate?: TileCoordinate,
): UnresolvedItem {
  const itemEvidence = evidence(input, coordinate);
  return {
    code,
    location: itemEvidence.location,
    message,
    evidence: [itemEvidence],
  };
}

function ipv4Parts(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const numbers = parts.map(Number);
  return numbers.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? numbers
    : undefined;
}

function blockedIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [first, second] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second! >= 64 && second! <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168)
  );
}

function ipv6Value(address: string): bigint | undefined {
  let normalized = address.toLowerCase().split('%', 1)[0]!;
  const dotted = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const parts = ipv4Parts(dotted);
    if (!parts) return undefined;
    const first = ((parts[0]! << 8) | parts[1]!).toString(16);
    const second = ((parts[2]! << 8) | parts[3]!).toString(16);
    normalized = `${normalized.slice(0, -dotted.length)}${first}:${second}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] === '' ? [] : halves[0]!.split(':');
  const right = halves.length === 1 || halves[1] === '' ? [] : halves[1]!.split(':');
  const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
  const words = [...left, ...Array.from({length: omitted}, () => '0'), ...right];
  if (omitted < 0 || words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) {
    return undefined;
  }
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}

function blockedIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%', 1)[0]!;
  if (blockedIpv4(normalized)) return true;
  const value = ipv6Value(normalized);
  if (value === undefined) return false;
  if ((value >> 32n) === 0xffffn) {
    const mapped = Number(value & 0xffff_ffffn);
    return blockedIpv4(
      `${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`,
    );
  }
  return value === 0n || value === 1n || value >> 121n === 126n || value >> 118n === 1018n;
}

async function resolveRemoteTarget(
  url: URL,
  allowPrivateNetwork: boolean,
  signal: AbortSignal,
): Promise<PinnedAddress> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SamplingError('tile-template-not-inspectable');
  }
  if (url.username !== '' || url.password !== '') {
    throw new SamplingError('tile-template-credentials-rejected');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (!allowPrivateNetwork && blockedIp(hostname)) {
      throw new SamplingError('tile-private-network-blocked');
    }
    return {address: hostname, family: literalFamily as 4 | 6};
  }

  let addresses: Array<{address: string; family: number}>;
  try {
    addresses = await abortable(lookup(hostname, {all: true, verbatim: true}), signal);
  } catch {
    throw new SamplingError(signal.aborted ? 'tile-fetch-timeout' : 'tile-host-unresolved', true);
  }
  if (addresses.length === 0) throw new SamplingError('tile-host-unresolved', true);
  if (!allowPrivateNetwork && addresses.some(({address}) => blockedIp(address))) {
    throw new SamplingError('tile-private-network-blocked');
  }
  const pinned = [...addresses]
    .filter((address): address is PinnedAddress => address.family === 4 || address.family === 6)
    .sort((left, right) => left.family - right.family || left.address.localeCompare(right.address))[0];
  if (!pinned) throw new SamplingError('tile-host-unresolved', true);
  return pinned;
}

function discardResponse(response: IncomingMessage): void {
  response.destroy();
}

function contentLength(response: IncomingMessage): number | undefined {
  const raw = response.headers['content-length'];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) throw new SamplingError('tile-content-length-invalid');
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new SamplingError('tile-content-length-invalid');
  }
  return length;
}

async function readResponse(
  response: IncomingMessage,
  maxResponseBytes: number,
  claimBytes: (length: number) => boolean,
): Promise<Uint8Array> {
  let declaredLength: number | undefined;
  try {
    declaredLength = contentLength(response);
  } catch (error) {
    discardResponse(response);
    throw error;
  }
  if (declaredLength !== undefined && declaredLength > maxResponseBytes) {
    discardResponse(response);
    throw new SamplingError('tile-response-too-large');
  }

  const chunks: Uint8Array[] = [];
  let responseBytes = 0;
  try {
    for await (const chunk of response) {
      const value = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Uint8Array);
      responseBytes += value.byteLength;
      if (responseBytes > maxResponseBytes) {
        throw new SamplingError('tile-response-too-large');
      }
      if (!claimBytes(value.byteLength)) {
        throw new SamplingError('tile-total-bytes-exceeded', false, true);
      }
      chunks.push(value);
    }
  } catch (error) {
    discardResponse(response);
    throw error;
  }

  const bytes = new Uint8Array(responseBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function pinnedLookup(address: PinnedAddress): LookupFunction {
  return ((_hostname, options: {all?: boolean}, callback) => {
    if (options.all === true) {
      const done = callback as (
        error: NodeJS.ErrnoException | null,
        addresses: PinnedAddress[],
      ) => void;
      done(null, [{address: address.address, family: address.family}]);
      return;
    }
    const done = callback as (
      error: NodeJS.ErrnoException | null,
      address: string,
      family: number,
    ) => void;
    done(null, address.address, address.family);
  }) as LookupFunction;
}

function requestPinned(
  url: URL,
  address: PinnedAddress,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolveResponse, rejectRequest) => {
    const request = url.protocol === 'https:' ? requestHttps : requestHttp;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const outgoing = request(
      url,
      {
        method: 'GET',
        signal,
        agent: false,
        family: address.family,
        lookup: pinnedLookup(address),
        ...(url.protocol === 'https:' && isIP(hostname) === 0 ? {servername: hostname} : {}),
      },
      resolveResponse,
    );
    outgoing.once('error', rejectRequest);
    outgoing.end();
  });
}

async function fetchRemote(
  initialUrl: URL,
  options: SamplerOptions,
  signal: AbortSignal,
  claimBytes: (length: number) => boolean,
  takeRequest: TakeRequest,
  coordinate: TileCoordinate,
): Promise<Uint8Array> {
  let url = initialUrl;
  for (let redirectCount = 0; ; redirectCount += 1) {
    const address = await resolveRemoteTarget(url, options.allowPrivateNetwork, signal);
    if (!takeRequest(coordinate)) {
      throw new SamplingError('sampling-budget-exhausted', false, true);
    }
    let response: IncomingMessage;
    try {
      response = await requestPinned(url, address, signal);
    } catch {
      throw new SamplingError(signal.aborted ? 'tile-fetch-timeout' : 'tile-fetch-failed', true);
    }

    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      const locationHeader = response.headers.location;
      const location = Array.isArray(locationHeader) ? undefined : locationHeader;
      discardResponse(response);
      if (!location) throw new SamplingError('tile-redirect-location-missing');
      if (redirectCount >= MAX_REDIRECTS) throw new SamplingError('tile-redirect-limit');
      try {
        url = new URL(location, url);
      } catch {
        throw new SamplingError('tile-redirect-invalid');
      }
      continue;
    }
    if (status < 200 || status >= 300) {
      discardResponse(response);
      const retryable = status === 408 || status === 429 || status >= 500;
      throw new SamplingError('tile-http-error', retryable);
    }
    return readResponse(response, options.maxResponseBytes, claimBytes);
  }
}

async function readLocal(
  template: string,
  coordinate: TileCoordinate,
  signal: AbortSignal,
  maxResponseBytes: number,
  claimBytes: (length: number) => boolean,
): Promise<Uint8Array> {
  const interpolated = interpolate(template, coordinate);
  const path = interpolated.startsWith('file://')
    ? fileURLToPath(new URL(interpolated))
    : resolve(interpolated);
  const chunks: Uint8Array[] = [];
  let responseBytes = 0;
  try {
    for await (const chunk of createReadStream(path, {signal})) {
      const bytes = chunk as Uint8Array;
      responseBytes += bytes.byteLength;
      if (responseBytes > maxResponseBytes) {
        throw new SamplingError('tile-response-too-large');
      }
      if (!claimBytes(bytes.byteLength)) {
        throw new SamplingError('tile-total-bytes-exceeded', false, true);
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof SamplingError) throw error;
    throw new SamplingError(signal.aborted ? 'tile-fetch-timeout' : 'tile-file-read-failed');
  }

  const result = new Uint8Array(responseBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function defaultFetcher(
  options: SamplerOptions,
  claimBytes: (length: number) => boolean,
  takeRequest: TakeRequest,
): TileFetcher {
  if (sanitizeReference(options.template).explicitLocalTemplate) {
    return (coordinate, signal) => {
      if (!takeRequest(coordinate)) {
        throw new SamplingError('sampling-budget-exhausted', false, true);
      }
      return readLocal(
        options.template,
        coordinate,
        signal,
        options.maxResponseBytes,
        claimBytes,
      );
    };
  }
  if (/^https?:\/\//i.test(options.template)) {
    return (coordinate, signal) => {
      let url: URL;
      try {
        url = new URL(interpolate(options.template, coordinate));
      } catch {
        throw new SamplingError('tile-template-not-inspectable');
      }
      return fetchRemote(url, options, signal, claimBytes, takeRequest, coordinate);
    };
  }
  throw new SamplingError('tile-template-not-inspectable');
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => rejectPromise(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    operation.then(resolvePromise, rejectPromise).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

function structureParts(observation: TileObservation): string[] {
  const parts: string[] = [];
  for (const layerName of Object.keys(observation.layers).sort()) {
    const layer = observation.layers[layerName]!;
    parts.push(`layer:${layerName}`);
    for (const geometry of layer.geometries) parts.push(`geometry:${layerName}:${geometry}`);
    if (layer.stableIdObserved) parts.push(`stable-id:${layerName}`);
    for (const fieldName of Object.keys(layer.fields).sort()) {
      parts.push(`field:${layerName}:${fieldName}`);
      for (const type of layer.fields[fieldName]!.types) {
        parts.push(`type:${layerName}:${fieldName}:${type}`);
      }
    }
  }
  return parts;
}

function isNonEmpty(observation: TileObservation): boolean {
  return Object.values(observation.layers).some((layer) => layer.featureCount > 0);
}

function errorDetails(error: unknown): {
  code: string;
  retryable: boolean;
  budgetExhausted: boolean;
} {
  if (error instanceof SamplingError) {
    return {
      code: error.code,
      retryable: error.retryable,
      budgetExhausted: error.budgetExhausted,
    };
  }
  return {code: 'tile-fetch-failed', retryable: true, budgetExhausted: false};
}

/** Samples MVT candidates within explicit request, byte, retry, and stability bounds. */
export async function sampleTiles(
  inputOptions: SamplerOptions,
  injectedFetcher?: TileFetcher,
): Promise<SamplingResult> {
  const options = normalizedOptions(inputOptions);
  const retainedTemplate = sanitizeReference(options.template).value;
  const observations: SamplingResult['observations'] = [];
  const unresolved: UnresolvedItem[] = [];
  const candidates = tileCandidates(options.bounds, options.zooms);
  const summary: SamplingSummary = {
    requested: 0,
    decoded: 0,
    empty: 0,
    failed: 0,
    bytes: 0,
    coordinates: [],
    stopReason: 'candidates-exhausted',
  };
  let budgetExhausted = options.maxRequests === 0 || options.maxTotalBytes === 0;
  let nonEmpty = 0;
  let stableCount = 0;
  const knownStructure = new Set<string>();
  const requestedCoordinates = new Set<string>();
  let fetcher: TileFetcher;

  const claimBytes = (length: number, includeRejectedChunk = false): boolean => {
    if (length > options.maxTotalBytes - summary.bytes) {
      if (includeRejectedChunk) summary.bytes += length;
      budgetExhausted = true;
      return false;
    }
    summary.bytes += length;
    return true;
  };

  const takeRequest: TakeRequest = (coordinate) => {
    if (summary.requested >= options.maxRequests) {
      budgetExhausted = true;
      return false;
    }
    summary.requested += 1;
    const key = coordinateKey(coordinate);
    if (!requestedCoordinates.has(key)) {
      requestedCoordinates.add(key);
      summary.coordinates.push(coordinate);
    }
    return true;
  };

  try {
    fetcher = injectedFetcher ?? defaultFetcher(
      options,
      (length) => claimBytes(length, true),
      takeRequest,
    );
  } catch (error) {
    const details = errorDetails(error);
    unresolved.push(
      unresolvedItem(
        retainedTemplate,
        details.code,
        'The tile template cannot be fetched under the sampling safety policy.',
      ),
    );
    return {observations, summary, unresolved};
  }

  if (options.maxNonEmpty === 0) {
    summary.stopReason = 'non-empty-limit';
    return {observations, summary, unresolved};
  }

  let candidateIndex = 0;
  let retryQueue: CandidateState[] = [];
  let stopped = false;
  let requestBudgetPreventedWork = false;
  const batchLimit = injectedFetcher ? options.concurrency : 1;

  while (!stopped && !budgetExhausted && summary.requested < options.maxRequests) {
    const batch: CandidateState[] = [];
    while (batch.length < batchLimit && summary.requested < options.maxRequests) {
      const state = retryQueue.shift() ??
        (candidateIndex < candidates.length
          ? {coordinate: candidates[candidateIndex++]!, attempts: 0}
          : undefined);
      if (!state) break;
      state.attempts += 1;
      batch.push(state);
    }
    if (batch.length === 0) break;

    const results = await Promise.all(
      batch.map(async (state): Promise<AttemptResult> => {
        const signal = AbortSignal.timeout(options.timeoutMs);
        try {
          if (injectedFetcher && !takeRequest(state.coordinate)) {
            throw new SamplingError('sampling-budget-exhausted', false, true);
          }
          const bytes = await abortable(fetcher(state.coordinate, signal), signal);
          return {state, bytes};
        } catch (error) {
          return {
            state,
            error:
              signal.aborted && !(error instanceof SamplingError)
                ? new SamplingError('tile-fetch-timeout', true)
                : error,
          };
        }
      }),
    );

    const nextRetries: CandidateState[] = [];
    for (const result of results) {
      if (stopped) continue;
      if (result.error === undefined && injectedFetcher) {
        if (result.bytes!.byteLength > options.maxResponseBytes) {
          result.error = new SamplingError('tile-response-too-large');
        } else if (!claimBytes(result.bytes!.byteLength)) {
          result.error = new SamplingError('tile-total-bytes-exceeded', false, true);
        }
      }
      if (result.error !== undefined) {
        const details = errorDetails(result.error);
        if (details.budgetExhausted) budgetExhausted = true;
        const retryAllowed =
          details.retryable &&
          !details.budgetExhausted &&
          result.state.attempts <= options.retries;
        if (retryAllowed) {
          if (summary.requested < options.maxRequests) {
            nextRetries.push(result.state);
            continue;
          }
          requestBudgetPreventedWork = true;
        }
        summary.failed += 1;
        unresolved.push(
          unresolvedItem(
            retainedTemplate,
            details.code,
            'A tile could not be sampled within the configured safety and retry bounds.',
            result.state.coordinate,
          ),
        );
        continue;
      }

      try {
        const observation = decodeMvt(
          result.bytes!,
          evidence(retainedTemplate, result.state.coordinate),
          options.maxResponseBytes,
        );
        summary.decoded += 1;
        observations.push({coordinate: result.state.coordinate, observation});
        if (!isNonEmpty(observation)) {
          summary.empty += 1;
          stableCount = 0;
          continue;
        }

        nonEmpty += 1;
        let addedStructure = false;
        for (const part of structureParts(observation)) {
          if (!knownStructure.has(part)) {
            knownStructure.add(part);
            addedStructure = true;
          }
        }
        stableCount = addedStructure ? 0 : stableCount + 1;
        if (nonEmpty >= options.maxNonEmpty) {
          summary.stopReason = 'non-empty-limit';
          stopped = true;
        } else if (stableCount >= options.stableStop) {
          summary.stopReason = 'structure-stable';
          stopped = true;
        }
      } catch (error) {
        summary.failed += 1;
        const decodeCode = error instanceof TileDecodeError ? error.code : 'tile-decode-failed';
        unresolved.push(
          unresolvedItem(
            retainedTemplate,
            decodeCode,
            decodeCode === 'tile-decoded-too-large'
              ? 'Decoded tile output exceeded the configured per-response byte budget.'
              : decodeCode === 'tile-unsafe-64-bit-value'
                ? 'A tile integer value exceeded the JavaScript safe integer range and the tile was not observed.'
                : 'Fetched bytes could not be decoded as an MVT tile.',
            result.state.coordinate,
          ),
        );
      }
    }
    retryQueue = [...nextRetries, ...retryQueue];
  }

  if (!stopped) {
    const requestBudgetExhausted =
      summary.requested >= options.maxRequests &&
      (requestBudgetPreventedWork || candidateIndex < candidates.length || retryQueue.length > 0);
    if (budgetExhausted || requestBudgetExhausted) {
      summary.stopReason = 'budget-exhausted';
      unresolved.push(
        unresolvedItem(
          retainedTemplate,
          'sampling-budget-exhausted',
          'Sampling stopped at the configured request or total-byte budget.',
        ),
      );
    } else {
      summary.stopReason = 'candidates-exhausted';
    }
  }

  return {observations, summary, unresolved};
}
