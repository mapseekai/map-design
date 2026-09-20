export function redactUpstreamUrl(input: URL): string {
  const redacted = new URL(input.href);
  redacted.username = '';
  redacted.password = '';
  redacted.hash = '';
  for (const key of [...redacted.searchParams.keys()]) {
    redacted.searchParams.set(key, '[REDACTED]');
  }
  return redacted.href;
}

export function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Upstream request failed';
  return error.message.replace(/https?:\/\/[^\s"'<>]+/giu, (value) => {
    try {
      return redactUpstreamUrl(new URL(value));
    } catch {
      return '[REDACTED URL]';
    }
  });
}
