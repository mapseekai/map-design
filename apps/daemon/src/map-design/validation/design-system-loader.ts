import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { parseMapDesignSystemDocument, type MapDesignRules } from '@mapseekai/map-design-contracts';

import { blake3Digest } from '../storage/canonical-json.js';

export type { MapDesignRules } from '@mapseekai/map-design-contracts';

export interface LoadedMapDesignSystem {
  id: string;
  digest: string;
  humanGuidance: string;
  rules: MapDesignRules;
}

export interface LoadMapDesignSystemInput {
  projectRoot: string;
  designSystemId: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function loadMapDesignSystem(input: LoadMapDesignSystemInput): Promise<LoadedMapDesignSystem> {
  if (!SAFE_ID.test(input.designSystemId) || input.designSystemId === '.' || input.designSystemId === '..') {
    throw new TypeError('invalid design system id');
  }
  const root = path.resolve(input.projectRoot);
  const file = path.resolve(root, 'design-systems', input.designSystemId, 'MAP_DESIGN.md');
  if (!file.startsWith(`${root}${path.sep}`)) throw new TypeError('invalid design system id');

  let bytes: Buffer;
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
    if (!realFile.startsWith(`${realRoot}${path.sep}`)) {
      throw new TypeError('design system file is outside configured root');
    }
    bytes = await readFile(realFile);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('could not read map design system');
  }

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError('could not read map design system');
  }
  const { humanGuidance, rules } = parseMapDesignSystemDocument(content);
  return {
    id: input.designSystemId,
    digest: blake3Digest(new Uint8Array(bytes)),
    humanGuidance,
    rules,
  };
}
