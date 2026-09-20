import path from 'node:path';
import { BINARY_BLOB_KINDS, JSON_BLOB_KINDS, type BinaryBlobKind, type JsonBlobKind, type MapDesignBlobKind } from './types.js';

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function invalid(label: string): never {
  throw new TypeError(`invalid ${label}`);
}

export function assertProjectId(projectId: string): asserts projectId is string {
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId) || projectId === '.' || projectId === '..') {
    invalid('project id');
  }
}

export function assertBlobDigest(digest: string): asserts digest is string {
  if (typeof digest !== 'string' || !DIGEST.test(digest)) invalid('blob digest');
}

export function assertBlobKind(kind: string): asserts kind is MapDesignBlobKind {
  if (![...JSON_BLOB_KINDS, ...BINARY_BLOB_KINDS].includes(kind as MapDesignBlobKind)) invalid('blob kind');
}

export function blobExtension(kind: MapDesignBlobKind): '.json' | '.png' | '.bin' {
  if ((JSON_BLOB_KINDS as readonly string[]).includes(kind)) return '.json';
  return kind === 'previews' ? '.png' : '.bin';
}

export function blobDirectory(dataRoot: string, projectId: string, kind: MapDesignBlobKind): string {
  assertProjectId(projectId);
  assertBlobKind(kind);
  return path.join(dataRoot, 'mapdesign', 'projects', projectId, 'blobs', kind);
}

export function blobPath(dataRoot: string, projectId: string, kind: MapDesignBlobKind, digest: string): string {
  assertBlobDigest(digest);
  return path.join(blobDirectory(dataRoot, projectId, kind), `${digest}${blobExtension(kind)}`);
}

export function isJsonBlobKind(kind: MapDesignBlobKind): kind is JsonBlobKind {
  return (JSON_BLOB_KINDS as readonly string[]).includes(kind);
}

export function isBinaryBlobKind(kind: MapDesignBlobKind): kind is BinaryBlobKind {
  return (BINARY_BLOB_KINDS as readonly string[]).includes(kind);
}
