import { describe, expect, it } from 'vitest';

import { toSafeToolSummary } from '../../../src/map-design/tools/safe-tool-summary.js';

describe('safe native map tool summaries', () => {
  it('drops long underscore-delimited generic credentials without rejecting safe identifiers', () => {
    for (const credential of [
      'TOKEN_SUPERSECRET',
      'token_supersecret',
      'sk_0123456789abcdef',
      'secret_0123456789abcdef',
    ]) {
      expect(toSafeToolSummary({ safe: 'ready', [credential]: 'value', exposed: credential })).toEqual({ safe: 'ready' });
    }

    expect(toSafeToolSummary({
      token_count: 2,
      secret_status: 'redacted',
      credential_type: 'oauth',
      api_key_count: 1,
      access_token_count: 3,
      client_secret_status: 'missing',
    })).toEqual({
      token_count: 2,
      secret_status: 'redacted',
      credential_type: 'oauth',
      api_key_count: 1,
      access_token_count: 3,
      client_secret_status: 'missing',
    });
  });

  it('drops compact JWTs and established credential families from keys and values', () => {
    const compactJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtYXAtZGVzaWduIn0.c2lnbmF0dXJlMTIzNDU2';
    const summary = toSafeToolSummary({
      safe: 'ready',
      jwt: compactJwt,
      bearer: `Bearer ${compactJwt}`,
      github: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
      gitlab: 'glpat-0123456789abcdefghijklmnop',
      slack: 'xoxb-0123456789-abcdefghijklmnop',
      google: 'ya29.0123456789abcdefghijklmnop',
      gemini: 'AIza0123456789abcdefghijklmnop',
      [`unsafe-${compactJwt}`]: 'value',
    });

    expect(summary).toEqual({ safe: 'ready' });
    expect(JSON.stringify(summary)).not.toContain('eyJ');
    expect(JSON.stringify(summary)).not.toContain('ghp_');
  });

  it('keeps bounded scalar facts and removes paths, credentials, and complete URLs', () => {
    const summary = toSafeToolSummary({
      layerId: 'roads/main',
      changedLayerCount: 1,
      noOp: false,
      optional: null,
      unixPath: '/Users/alice/private/style.json',
      windowsPath: 'C:\\Users\\alice\\style.json',
      uncPath: '\\\\server\\share\\style.json',
      sourceUrl: 'https://alice:secret@example.test/style.json?token=secret',
      authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
      apiKey: 'sk-abcdefghijklmnopqrstuvwxyz',
    });

    expect(summary).toEqual({
      layerId: 'roads/main',
      changedLayerCount: 1,
      noOp: false,
      optional: null,
    });
    expect(JSON.stringify(summary).length).toBeLessThan(65_536);
  });

  it('drops unsafe keys, non-finite numbers, and oversized values', () => {
    const summary = toSafeToolSummary({
      safe: 'ready',
      '/tmp/private': 'value',
      token: 'short-secret',
      infinity: Number.POSITIVE_INFINITY,
      object: { localPath: '/private/tmp/map.json' },
      oversized: 'x'.repeat(70_000),
    });

    expect(summary).toEqual({ safe: 'ready' });
    expect(JSON.stringify(summary).length).toBeLessThan(65_536);
  });
});
