import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import {
  MapToolInputSchemas,
  MapToolNameSchema,
  type MapToolName,
} from '@mapseekai/map-design-contracts';
import { createMapToolHttpClient, MapToolClientError } from './map-design/mcp/map-tool-client.js';

export interface MapToolCliIo {
  fetch?: typeof fetch;
  stdout?: { write(value: string): unknown };
  stderr?: { write(value: string): unknown };
  stdin?: AsyncIterable<Uint8Array | string>;
  readFile?: (path: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
}

export async function runMapDesignToolCli(
  args: readonly string[],
  io: MapToolCliIo = {},
): Promise<{ exitCode: number }> {
  const output = io.stdout ?? process.stdout;
  const env = io.env ?? process.env;

  let tool: MapToolName;
  let inputPath: string;
  try {
    const parsed = parseArgs(args);
    tool = parsed.tool;
    inputPath = parsed.inputPath;
  } catch (error) {
    writeEnvelope(output, cliFailure('INVALID_INPUT', errorMessage(error)));
    return { exitCode: 2 };
  }

  const daemonUrl = env.MAP_DESIGN_DAEMON_URL?.trim();
  const token = env.MAP_DESIGN_TOOL_TOKEN?.trim();
  if (!daemonUrl || !token) {
    writeEnvelope(output, cliFailure('RUN_NOT_AUTHORIZED', 'The MapDesign run is not authorized.'));
    return { exitCode: 4 };
  }

  let input: unknown;
  try {
    const rawInput = await readInput(inputPath, io);
    input = MapToolInputSchemas[tool].parse(JSON.parse(rawInput) as unknown);
  } catch {
    writeEnvelope(output, cliFailure('INVALID_INPUT', 'The MapDesign tool input is invalid.'));
    return { exitCode: 2 };
  }

  let envelope: unknown;
  try {
    envelope = await createMapToolHttpClient({
      daemonUrl,
      token,
      ...(io.fetch ? { fetch: io.fetch } : {}),
    }).call(tool, input);
  } catch (error) {
    const kind = error instanceof MapToolClientError ? error.kind : 'transport';
    if (kind === 'unauthorized') {
      writeEnvelope(output, cliFailure('RUN_NOT_AUTHORIZED', 'The MapDesign run is not authorized.'));
      return { exitCode: 4 };
    }
    writeEnvelope(output, cliFailure('INTERNAL', kind === 'invalid_response'
      ? 'The daemon returned an invalid MapDesign tool envelope.'
      : 'MapDesign tool request failed.'));
    return { exitCode: 1 };
  }

  writeEnvelope(output, envelope);
  return { exitCode: (envelope as { ok?: unknown }).ok === true ? 0 : 1 };
}

function parseArgs(args: readonly string[]): { tool: MapToolName; inputPath: string } {
  const parsedTool = MapToolNameSchema.safeParse(args[0]);
  if (!parsedTool.success) throw new Error('Usage: md tool <tool> --input <json-file|-> [--json]');
  const hasJson = args.length === 4 && args[3] === '--json';
  if ((args.length !== 3 && !hasJson) || args[1] !== '--input' || !args[2]) {
    throw new Error('Usage: md tool <tool> --input <json-file|-> [--json]');
  }
  return { tool: parsedTool.data, inputPath: args[2] };
}

const MAP_DIFF_MAX_BYTES = 1_048_576;

async function readInput(path: string, io: MapToolCliIo): Promise<string> {
  if (path !== '-' && io.readFile) return boundedText([await io.readFile(path)]);

  const chunks = path === '-' ? io.stdin ?? process.stdin : createReadStream(path);
  const decoder = new StringDecoder('utf8');
  const collected: string[] = [];
  let bytes = 0;
  for await (const chunk of chunks) {
    const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    bytes += size;
    if (bytes > MAP_DIFF_MAX_BYTES) throw new Error('tool input exceeds 1 MiB');
    collected.push(typeof chunk === 'string'
      ? chunk
      : decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
  }
  collected.push(decoder.end());
  return collected.join('');
}

function boundedText(chunks: readonly string[]): string {
  let bytes = 0;
  for (const chunk of chunks) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAP_DIFF_MAX_BYTES) throw new Error('tool input exceeds 1 MiB');
  }
  return chunks.join('');
}

function cliFailure(code: string, message: string) {
  return {
    ok: false,
    error: { code, message: redact(message), retryable: false },
    meta: { requestId: 'map-cli', projectId: 'unknown-project', runId: 'unknown-run' },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(message: string): string {
  if (/(?:https?:\/\/|file:\/\/|(?:^|\s)\/(?:Users|home|root|private|tmp|var|etc|opt|usr|Volumes)\/|\bsk-[A-Za-z0-9_-]{8,}\b|\b(?:token|secret|password|credential)\s*[:=])/iu.test(message)) {
    return 'MapDesign tool request failed.';
  }
  return message.replace(/[\r\n\u0000-\u001f\u007f]/gu, ' ').slice(0, 2_048);
}

function writeEnvelope(output: { write(value: string): unknown }, envelope: unknown): void {
  output.write(`${JSON.stringify(envelope)}\n`);
}
