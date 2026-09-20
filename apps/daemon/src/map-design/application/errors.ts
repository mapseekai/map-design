import { MapToolErrorCodeSchema, mapJsonByteLength, type MapPublicErrorDetails, type MapToolErrorCode } from '@mapseekai/map-design-contracts';

const MAX_DETAILS_BYTES = 64 * 1024;

export class MapDraftError extends Error {
  readonly code: MapToolErrorCode;
  readonly retryable: boolean;
  readonly details?: MapPublicErrorDetails;

  constructor(code: MapToolErrorCode, message: string, options: { retryable?: boolean; details?: MapPublicErrorDetails } = {}) {
    super(message);
    this.name = 'MapDraftError';
    this.code = MapToolErrorCodeSchema.parse(code);
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined && mapJsonByteLength(options.details) <= MAX_DETAILS_BYTES) this.details = options.details;
  }
}

export function isMapDraftError(value: unknown): value is MapDraftError {
  return value instanceof MapDraftError;
}

export function invalidInput(): MapDraftError {
  return new MapDraftError('INVALID_INPUT', 'The map draft request is invalid.');
}
