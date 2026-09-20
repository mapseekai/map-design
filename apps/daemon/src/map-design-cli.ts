import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { runMapDesignProjectCli, type MapDesignProjectCliIo } from './tools-map-design-project-cli.js';
import { runMapDesignToolCli, type MapToolCliIo } from './tools-map-design-cli.js';

export const MAP_DESIGN_COMMANDS = ['agents', 'config', 'doctor', 'project', 'run', 'status', 'tool'] as const;
type Command = typeof MAP_DESIGN_COMMANDS[number];
export interface MapDesignCliIo extends MapDesignProjectCliIo, MapToolCliIo {}

export async function runMapDesignCli(argv: readonly string[], io: MapDesignCliIo = {}): Promise<number> {
  const output = io.stdout ?? process.stdout;
  const errors = io.stderr ?? process.stderr;
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    output.write(help());
    return command ? 0 : 2;
  }
  if (!isCommand(command)) return usage(errors, `Unknown md command: ${command}.`);
  if (command === 'tool') return (await runMapDesignToolCli(args, io)).exitCode;
  if (command === 'project') return runMapDesignProjectCli(args, io);
  try {
    const parsed = parse(args);
    const client = new HttpClient(parsed.flags, io);
    if (command === 'status' || command === 'doctor') return await health(client, parsed, output);
    if (command === 'agents') return await agents(client, parsed, output);
    if (command === 'config') return await config(client, parsed, output);
    return await run(client, parsed, output, io);
  } catch (error) {
    if (error instanceof UsageError) return usage(errors, error.message);
    if (error instanceof DaemonHttpError) {
      const payload = { code: error.code, message: error.message, retryable: error.retryable, status: error.status };
      errors.write(`${JSON.stringify(payload)}\n`);
      return error.status === 401 || error.status === 403 ? 4 : 1;
    }
    errors.write('{"code":"DAEMON_REQUEST_FAILED","message":"md request failed.","retryable":true}\n');
    return 1;
  }
}

export class UsageError extends Error {}
export class DaemonHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) { super(message); }
}
function isCommand(value: string): value is Command { return (MAP_DESIGN_COMMANDS as readonly string[]).includes(value); }
function usage(errors: { write(value: string): unknown }, message: string): number { errors.write(`${message}\nRun md --help for usage.\n`); return 2; }
function help(): string { return 'Usage: md <agents|config|doctor|project|run|status|tool> [options]\nmd run start accepts --conversation-id to target a project conversation and requires --runtime-revision.\n'; }

type Parsed = { positional: string[]; flags: Record<string, string | true> };
function parse(args: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const known: Record<string, true> = {
    'daemon-url': true, json: true, 'prompt-file': true, 'project-id': true, 'conversation-id': true,
    'runtime-revision': true,
    'value-json': true, 'byok-provider': true,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const key = value.slice(2);
    if (!known[key]) throw new UsageError(`Unknown option --${key}.`);
    if (Object.hasOwn(flags, key)) throw new UsageError(`Duplicate --${key}.`);
    if (key === 'json') { flags[key] = true; continue; }
    const flagValue = args[++index];
    if (!flagValue || flagValue.startsWith('--')) throw new UsageError(`--${key} requires a value.`);
    flags[key] = flagValue;
  }
  return { positional, flags };
}
function flag(parsed: Parsed, key: string): string | undefined { const value = parsed.flags[key]; return typeof value === 'string' ? value : undefined; }
function requiredFlag(parsed: Parsed, key: string): string { const value = flag(parsed, key); if (!value) throw new UsageError(`--${key} is required.`); return value; }
function position(parsed: Parsed, index: number, name: string): string { const value = parsed.positional[index]; if (!value) throw new UsageError(`${name} is required.`); return value; }
function exact(parsed: Parsed, count: number): void { if (parsed.positional.length !== count) throw new UsageError('Invalid md command arguments.'); }

class HttpClient {
  readonly base: string;
  readonly request: typeof fetch;
  constructor(flags: Record<string, string | true>, io: MapDesignCliIo) {
    const specific = flags['daemon-url'];
    const configured = typeof specific === 'string' ? specific : io.env?.MAP_DESIGN_DAEMON_URL ?? process.env.MAP_DESIGN_DAEMON_URL;
    if (!configured?.trim()) throw new UsageError('MAP_DESIGN_DAEMON_URL or --daemon-url is required.');
    this.base = configured.replace(/\/+$/u, '');
    this.request = io.fetch ?? fetch;
  }
  async send(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(`${this.base}${path}`, init);
    } catch {
      throw new DaemonHttpError(0, 'DAEMON_UNAVAILABLE', 'daemon request failed', true);
    }
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const envelope = body && typeof body === 'object' && 'error' in body && body.error
        && typeof body.error === 'object' ? body.error as Record<string, unknown> : null;
      throw new DaemonHttpError(
        response.status,
        typeof envelope?.code === 'string' ? envelope.code : 'DAEMON_REQUEST_FAILED',
        typeof envelope?.message === 'string' ? envelope.message : `HTTP ${response.status}`,
        typeof envelope?.retryable === 'boolean' ? envelope.retryable : response.status >= 500,
      );
    }
    return body;
  }
}
function emit(output: { write(value: string): unknown }, value: unknown): void { output.write(`${JSON.stringify(value)}\n`); }
async function get(client: HttpClient, parsed: Parsed, output: { write(value: string): unknown }, path: string): Promise<number> { exact(parsed, 0); emit(output, await client.send(path, { method: 'GET' })); return 0; }
async function health(client: HttpClient, parsed: Parsed, output: { write(value: string): unknown }): Promise<number> { return get(client, parsed, output, '/api/health'); }
async function config(client: HttpClient, parsed: Parsed, output: { write(value: string): unknown }): Promise<number> {
  const action = position(parsed, 0, 'config action');
  if (action === 'get') {
    if (parsed.positional.length === 1) {
      emit(output, await client.send('/api/config', { method: 'GET' }));
      return 0;
    }
    exact(parsed, 2);
    const key = position(parsed, 1, 'config key');
    const body = await client.send('/api/config', { method: 'GET' });
    emit(output, body && typeof body === 'object' && 'config' in body
      && body.config && typeof body.config === 'object'
      ? (body.config as Record<string, unknown>)[key] ?? null
      : null);
    return 0;
  }
  if (action !== 'set') throw new UsageError(`Unknown md config action: ${action}.`);
  const key = position(parsed, 1, 'config key');
  const encoded = flag(parsed, 'value-json');
  if (encoded !== undefined) {
    exact(parsed, 2);
    let value: unknown;
    try { value = JSON.parse(encoded); } catch { throw new UsageError('--value-json must be valid JSON.'); }
    emit(output, await client.send('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [key]: value }) }));
    return 0;
  }
  exact(parsed, 3);
  emit(output, await client.send('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [key]: position(parsed, 2, 'config value') }) }));
  return 0;
}
async function agents(client: HttpClient, parsed: Parsed, output: { write(value: string): unknown }): Promise<number> {
  exact(parsed, 1);
  if (position(parsed, 0, 'agents action') !== 'list') throw new UsageError(`Unknown md agents action: ${parsed.positional[0]}.`);
  emit(output, await client.send('/api/agents', { method: 'GET' }));
  return 0;
}
async function run(client: HttpClient, parsed: Parsed, output: { write(value: string): unknown }, io: MapDesignCliIo): Promise<number> {
  const action = position(parsed, 0, 'run action');
  if (action === 'start') {
    exact(parsed, 1);
    const projectId = requiredFlag(parsed, 'project-id');
    const prompt = (await readInput(requiredFlag(parsed, 'prompt-file'), io)).trim();
    if (!prompt) throw new UsageError('--prompt-file must not be empty.');
    const selectedConversationId = flag(parsed, 'conversation-id');
    const aggregate = selectedConversationId === undefined
      ? await client.send(`/api/map-design/projects/${encodeURIComponent(projectId)}`, { method: 'GET' })
      : null;
    const conversationId = selectedConversationId ?? conversationIdFrom(aggregate);
    if (!conversationId) throw new DaemonHttpError(404, 'CONVERSATION_NOT_FOUND', 'project aggregate has no conversation', false);
    const runtimeRevision = parseRuntimeRevision(requiredFlag(parsed, 'runtime-revision'));
    const body: Record<string, unknown> = {
      projectId, conversationId,
      clientRequestId: (io.randomId ?? randomUUID)(),
      userMessageId: (io.randomId ?? randomUUID)(),
      assistantMessageId: (io.randomId ?? randomUUID)(),
      prompt,
      runtimeRevision,
    };
    const byokProvider = flag(parsed, 'byok-provider');
    if (byokProvider) {
      try { body.byokProvider = JSON.parse(byokProvider); } catch { throw new UsageError('--byok-provider must be valid JSON.'); }
    }
    emit(output, await client.send('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return 0;
  }
  const runId = position(parsed, 1, '<run-id>');
  exact(parsed, 2);
  if (action === 'status') { emit(output, await client.send(`/api/runs/${encodeURIComponent(runId)}`, { method: 'GET' })); return 0; }
  if (action === 'cancel') { emit(output, await client.send(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })); return 0; }
  throw new UsageError(`Unknown md run action: ${action}.`);
}
function parseRuntimeRevision(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new UsageError('--runtime-revision must be a non-negative safe integer.');
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) throw new UsageError('--runtime-revision must be a non-negative safe integer.');
  return revision;
}
function conversationIdFrom(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.conversationId === 'string' && record.conversationId) return record.conversationId;
  const aggregate = record.aggregate;
  if (aggregate && typeof aggregate === 'object') {
    const nested = (aggregate as Record<string, unknown>).conversationId;
    if (typeof nested === 'string' && nested) return nested;
  }
  return null;
}
const INPUT_MAX_CHARS = 16_384;
const INPUT_MAX_BYTES = 64 * 1024;
async function readInput(path: string, io: MapDesignCliIo): Promise<string> {
  if (io.readFile && path !== '-') return boundedText([await io.readFile(path)]);
  const chunks = path === '-' ? io.stdin ?? process.stdin : createReadStream(path);
  const decoder = new StringDecoder('utf8');
  const collected: string[] = [];
  let bytes = 0;
  let chars = 0;
  const collect = (text: string): void => {
    bytes += Buffer.byteLength(text);
    chars += text.length;
    if (bytes > INPUT_MAX_BYTES || chars > INPUT_MAX_CHARS) throw new UsageError('--prompt-file exceeds the 16,384 character or 64 KiB limit.');
    collected.push(text);
  };
  for await (const chunk of chunks) collect(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  const trailing = decoder.end();
  if (trailing) collect(trailing);
  return collected.join('');
}
function boundedText(chunks: readonly string[]): string {
  const text = chunks.join('');
  if (text.length > INPUT_MAX_CHARS || Buffer.byteLength(text) > INPUT_MAX_BYTES) throw new UsageError('--prompt-file exceeds the 16,384 character or 64 KiB limit.');
  return text;
}
