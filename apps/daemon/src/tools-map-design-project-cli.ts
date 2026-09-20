import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const INPUT_MAX_CHARS = 16_384;
const INPUT_MAX_BYTES = 64 * 1024;

export interface MapDesignProjectCliIo {
  fetch?: typeof fetch;
  stdout?: { write(value: string): unknown };
  stderr?: { write(value: string): unknown };
  stdin?: AsyncIterable<Uint8Array | string>;
  readFile?: (path: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  randomId?: () => string;
}

type ProjectCommand = 'create' | 'list' | 'get' | 'delete' | 'retry-import';
type Parsed = { command: ProjectCommand; positional: string[]; flags: Record<string, string | true> };

export async function runMapDesignProjectCli(args: readonly string[], io: MapDesignProjectCliIo = {}): Promise<number> {
  const output = io.stdout ?? process.stdout;
  const errors = io.stderr ?? process.stderr;
  let parsed: Parsed;
  try {
    parsed = parse(args);
    validate(parsed);
  } catch (error) {
    return usage(errors, error);
  }

  try {
    const request = io.fetch ?? fetch;
    const base = daemonUrl(parsed.flags, io.env);
    const response = await requestFor(parsed, base, io, request);
    const body = await responseBody(response);
    if (!response.ok) {
      const failure = daemonFailure(body, response.status);
      if (parsed.flags.json) errors.write(`${JSON.stringify(failure)}\n`);
      else errors.write(`${failure.message}\n`);
      return response.status === 401 || response.status === 403 ? 4 : 1;
    }
    output.write(`${JSON.stringify(body)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) return usage(errors, error);
    const failure = { code: 'DAEMON_REQUEST_FAILED', message: 'MapDesign request failed.', retryable: true };
    if (parsed.flags.json) errors.write(`${JSON.stringify(failure)}\n`);
    else errors.write(`${failure.message}\n`);
    return 1;
  }
}

async function requestFor(parsed: Parsed, base: string, io: MapDesignProjectCliIo, request: typeof fetch): Promise<Response> {
  const { command, positional, flags } = parsed;
  if (command === 'list') return request(`${base}/api/map-design/projects`, { method: 'GET' });
  const projectId = positional[0];
  if (command === 'get') return request(`${base}/api/map-design/projects/${encodeURIComponent(projectId!)}`, { method: 'GET' });
  if (command === 'delete') return request(`${base}/api/map-design/projects/${encodeURIComponent(projectId!)}`, { method: 'DELETE' });
  if (command === 'retry-import') {
    return request(`${base}/api/map-design/projects/${encodeURIComponent(projectId!)}/retry-import`, jsonPost({ idempotencyKey: nextId(io) }));
  }
  const prompt = (await readInput(flag(flags, 'prompt-file')!, io)).trim();
  if (!prompt) throw new UsageError('--prompt-file must not be empty.');
  const runtime: Record<string, string> = { agentId: flag(flags, 'runtime')! };
  for (const [option, key] of [['model', 'model'], ['reasoning', 'reasoning'], ['service-tier', 'serviceTier']] as const) {
    const value = flag(flags, option);
    if (value) runtime[key] = value;
  }
  return request(`${base}/api/map-design/projects`, jsonPost({
    projectId: nextId(io),
    title: flag(flags, 'name')!,
    runtime,
    source: { url: flag(flags, 'source-url')! },
    designRequirement: prompt,
    idempotencyKey: nextId(io),
  }));
}

class UsageError extends Error {}

function parse(args: readonly string[]): Parsed {
  const [command, ...rest] = args;
  if (!isCommand(command)) throw new UsageError('Usage: md project <create|list|get|delete|retry-import>.');
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  const allowed = allowedFlags(command);
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]!;
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const key = value.slice(2);
    if (!allowed[key]) throw new UsageError(`Unknown option --${key}.`);
    if (Object.hasOwn(flags, key)) throw new UsageError(`Duplicate --${key}.`);
    if (key === 'json') { flags[key] = true; continue; }
    const flagValue = rest[++index];
    if (!flagValue || flagValue.startsWith('--')) throw new UsageError(`--${key} requires a value.`);
    flags[key] = flagValue;
  }
  return { command, positional, flags };
}

function isCommand(value: string | undefined): value is ProjectCommand {
  return value === 'create' || value === 'list' || value === 'get' || value === 'delete' || value === 'retry-import';
}

function allowedFlags(command: ProjectCommand): Record<string, true> {
  if (command === 'create') {
    return {
      'daemon-url': true, json: true, name: true, 'source-url': true,
      runtime: true, model: true, reasoning: true, 'service-tier': true, 'prompt-file': true,
    };
  }
  return { 'daemon-url': true, json: true };
}

function validate(parsed: Parsed): void {
  const expected = parsed.command === 'list' || parsed.command === 'create' ? 0 : 1;
  if (parsed.positional.length !== expected) throw new UsageError('Invalid md project command arguments.');
  if (parsed.command === 'create') {
    for (const option of ['name', 'source-url', 'runtime', 'prompt-file']) {
      if (!flag(parsed.flags, option)) throw new UsageError(`--${option} is required.`);
    }
  }
}

function daemonUrl(flags: Record<string, string | true>, env: NodeJS.ProcessEnv | undefined): string {
  const value = flag(flags, 'daemon-url') ?? env?.MAP_DESIGN_DAEMON_URL ?? process.env.MAP_DESIGN_DAEMON_URL;
  if (!value?.trim()) throw new UsageError('MAP_DESIGN_DAEMON_URL or --daemon-url is required.');
  return value.replace(/\/+$/u, '');
}

function flag(flags: Record<string, string | true>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function nextId(io: MapDesignProjectCliIo): string { return (io.randomId ?? randomUUID)(); }
function jsonPost(body: unknown): RequestInit { return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }; }

async function readInput(path: string, io: MapDesignProjectCliIo): Promise<string> {
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

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

function daemonFailure(body: unknown, status: number): { code: string; message: string; retryable: boolean; status: number } {
  const error = body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object'
    ? body.error as Record<string, unknown> : null;
  return {
    code: typeof error?.code === 'string' ? error.code : 'DAEMON_REQUEST_FAILED',
    message: redact(typeof error?.message === 'string' ? error.message : `HTTP ${status}`),
    retryable: typeof error?.retryable === 'boolean' ? error.retryable : status >= 500,
    status,
  };
}

function redact(message: string): string {
  if (/(?:https?:\/\/|file:\/\/|(?:^|\s)\/(?:Users|home|root|private|tmp|var|etc|opt|usr|Volumes)\/|\b(?:sk|token|secret|password|credential)[_-]?[A-Za-z0-9_-]{8,}\b|\b(?:token|secret|password|credential)\s*[:=])/iu.test(message)) {
    return 'MapDesign request failed.';
  }
  return message.replace(/[\r\n\u0000-\u001f\u007f]/gu, ' ').slice(0, 2_048);
}

function usage(errors: { write(value: string): unknown }, error: unknown): number {
  const message = error instanceof Error ? error.message : 'Invalid md project command.';
  errors.write(`${message}\nRun md project --help for usage.\n`);
  return 2;
}
