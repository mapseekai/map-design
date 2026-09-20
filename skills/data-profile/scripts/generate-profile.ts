#!/usr/bin/env node

import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

import {atomicWrite} from '../src/atomic-write.js';
import {generateProfile, type GenerateOptions} from '../src/generate.js';
import {stableJson} from '../src/stable-json.js';

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

const cliArgumentOptions = {
  style: {type: 'string'},
  tilejson: {type: 'string'},
  'source-id': {type: 'string'},
  'tile-template': {type: 'string'},
  bbox: {type: 'string'},
  zooms: {type: 'string'},
  'max-requests': {type: 'string'},
  'allow-private-network': {type: 'boolean'},
  'observed-at': {type: 'string'},
  output: {type: 'string'},
} as const;

function parseCliArguments(args: string[]) {
  return parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: cliArgumentOptions,
  });
}

function isoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return Number.isFinite(new Date(value).getTime());
}

function numberList(value: string, length?: number): number[] {
  const tokens = value.split(',');
  if (
    tokens.length === 0 ||
    (length !== undefined && tokens.length !== length) ||
    tokens.some((token) => token.trim() === '')
  ) {
    throw new CliUsageError('A numeric CLI list is invalid.');
  }
  const numbers = tokens.map((token) => Number(token));
  if (numbers.some((number) => !Number.isFinite(number))) {
    throw new CliUsageError('A numeric CLI list is invalid.');
  }
  return numbers;
}

function invocationDirectory(): string {
  const initialDirectory = process.env.INIT_CWD?.trim();
  return resolve(
    initialDirectory === undefined || initialDirectory === '' ? process.cwd() : initialDirectory,
  );
}

function parseOptions(
  args: string[],
  interactive: boolean,
): {options: GenerateOptions; output: string} {
  let parsed: ReturnType<typeof parseCliArguments>;
  try {
    parsed = parseCliArguments(args);
  } catch {
    throw new CliUsageError('CLI arguments are invalid.');
  }
  const {values} = parsed;

  if (values.style === undefined && values.tilejson === undefined && values['tile-template'] === undefined) {
    throw new CliUsageError('At least one discovery input is required.');
  }
  const observedAt = values['observed-at'] ?? (interactive ? new Date().toISOString() : undefined);
  if (observedAt === undefined || !isoTimestamp(observedAt)) {
    throw new CliUsageError('A valid --observed-at ISO timestamp is required for non-interactive runs.');
  }

  const options: GenerateOptions = {observedAt};
  if (values.style !== undefined) options.stylePath = values.style;
  if (values.tilejson !== undefined) options.tileJsonPath = values.tilejson;
  if (values['source-id'] !== undefined) options.sourceId = values['source-id'];
  if (values['tile-template'] !== undefined) options.tileTemplate = values['tile-template'];
  if (values.bbox !== undefined) {
    const bounds = numberList(values.bbox, 4);
    if (
      bounds[0]! < -180 ||
      bounds[0]! > 180 ||
      bounds[2]! < -180 ||
      bounds[2]! > 180 ||
      bounds[1]! < -90 ||
      bounds[1]! > 90 ||
      bounds[3]! < -90 ||
      bounds[3]! > 90
    ) {
      throw new CliUsageError('CLI bbox coordinates are out of range.');
    }
    options.bounds = [bounds[0]!, bounds[1]!, bounds[2]!, bounds[3]!];
  }
  if (values.zooms !== undefined) {
    const zooms = numberList(values.zooms);
    if (zooms.some((zoom) => !Number.isInteger(zoom) || zoom < 0 || zoom > 24)) {
      throw new CliUsageError('CLI zooms must be integers between 0 and 24.');
    }
    options.zooms = zooms;
  }
  if (values['max-requests'] !== undefined) {
    const maxRequestsToken = values['max-requests'];
    if (maxRequestsToken.trim() === '') {
      throw new CliUsageError('--max-requests must be a positive integer.');
    }
    const maxRequests = Number(maxRequestsToken);
    if (!Number.isFinite(maxRequests) || !Number.isSafeInteger(maxRequests) || maxRequests <= 0) {
      throw new CliUsageError('--max-requests must be a positive integer.');
    }
    options.maxRequests = maxRequests;
  }
  if (values['allow-private-network'] === true) options.allowPrivateNetwork = true;
  return {options, output: values.output ?? 'DATA_PROFILE.json'};
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const forwardedArgs = args[0] === '--' ? args.slice(1) : args;
  process.chdir(invocationDirectory());
  const {options, output} = parseOptions(forwardedArgs, process.stdin.isTTY === true);
  const serialized = stableJson(await generateProfile(options));
  await atomicWrite(output, serialized);
  process.stdout.write('Profile written successfully.\n');
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write('Profile generation failed.\n');
    process.exitCode = error instanceof CliUsageError ? 2 : 1;
  });
}
