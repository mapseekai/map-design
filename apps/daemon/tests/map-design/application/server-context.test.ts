import { describe, expect, it } from 'vitest';
import { shouldAllowMapDesignProxyVirtualAddresses } from '../../../src/server-context.js';

describe('shouldAllowMapDesignProxyVirtualAddresses', () => {
  const interfaces = (address: string, internal = false) => ({
    utun1024: [{ address, internal }],
  });

  it('accepts a valid OS-only proxy when no process proxy is configured', () => {
    expect(shouldAllowMapDesignProxyVirtualAddresses({}, {
      HTTPS_PROXY: 'http://127.0.0.1:7897',
    }, {})).toBe(true);
  });

  it('keeps an explicit process environment proxy ahead of the OS proxy', () => {
    expect(shouldAllowMapDesignProxyVirtualAddresses({
      HTTPS_PROXY: 'not a proxy url',
    }, {
      HTTPS_PROXY: 'http://127.0.0.1:7897',
    }, {})).toBe(false);
  });

  it('detects a non-internal TUN interface in the narrow proxy virtual range', () => {
    expect(shouldAllowMapDesignProxyVirtualAddresses({}, {}, interfaces('198.18.0.1'))).toBe(true);
  });

  it.each([
    ['internal benchmark interface', interfaces('198.18.0.1', true)],
    ['RFC1918 interface', interfaces('192.168.1.20')],
    ['loopback interface', interfaces('127.0.0.1')],
    ['ordinary public interface', interfaces('203.0.113.20')],
  ])('does not enable proxy virtual addresses for %s', (_name, snapshot) => {
    expect(shouldAllowMapDesignProxyVirtualAddresses({}, {}, snapshot)).toBe(false);
  });
});
