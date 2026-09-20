import { describe, expect, it } from 'vitest';

import {
  isForbiddenAddress,
  isProxyVirtualAddress,
  resolvePinnedTarget,
  validateUpstreamUrl,
  type DnsResolver,
} from '../../../src/map-design/ingestion/network-policy.js';
import { redactUpstreamUrl } from '../../../src/map-design/ingestion/redaction.js';

describe('MapDesign upstream network policy', () => {
  it('recognizes only the narrow IPv4 benchmark proxy range', () => {
    expect(isProxyVirtualAddress('198.18.0.1')).toBe(true);
    expect(isProxyVirtualAddress('198.19.255.255')).toBe(true);
    for (const address of ['198.17.255.255', '198.20.0.0', '127.0.0.1', '10.0.0.1', '192.168.1.1', '::1']) {
      expect(isProxyVirtualAddress(address), address).toBe(false);
    }
  });

  it.each([
    'ftp://example.com/style.json',
    'file:///tmp/style.json',
    'https://user@example.com/style.json',
    'https://example.com/style.json#secret',
    'https://localhost/style.json',
    'https://printer/style.json',
    'https://example.com./style.json',
    'https://printer.local/style.json',
    'https://router.home.arpa/style.json',
  ])('rejects ambiguous or unsafe URL %s', (input) => {
    expect(() => validateUpstreamUrl(new URL(input))).toThrow();
  });

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:8.8.8.8',
    '::ffff:0:127.0.0.1',
    '64:ff9b:1::1',
    '100::1',
    '2001:2::1',
    '2001:db8::1',
    '2002:c000:0201::1',
    '3fff::1',
    '5f00::1',
    'fc00::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
  ])('rejects private or reserved address %s', (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'allows globally routable address %s',
    (address) => {
      expect(isForbiddenAddress(address)).toBe(false);
    },
  );

  it('rejects the whole host when any DNS answer is forbidden', async () => {
    const resolver: DnsResolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];

    await expect(resolvePinnedTarget(new URL('https://example.com/style.json'), resolver)).rejects.toThrow(
      /forbidden/i,
    );
  });

  it('allows only explicitly trusted HTTPS proxy virtual-DNS answers', async () => {
    const resolver: DnsResolver = async () => [{ address: '198.18.0.7', family: 4 }];

    await expect(
      resolvePinnedTarget(
        new URL('https://tiles.example.com/style.json'),
        resolver,
        { allowProxyVirtualAddresses: true },
      ),
    ).resolves.toMatchObject({
      hostname: 'tiles.example.com',
      address: '198.18.0.7',
      family: 4,
    });
    await expect(
      resolvePinnedTarget(new URL('https://tiles.example.com/style.json'), resolver),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      resolvePinnedTarget(
        new URL('http://tiles.example.com/style.json'),
        resolver,
        { allowProxyVirtualAddresses: true },
      ),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      resolvePinnedTarget(
        new URL('https://198.18.0.7/style.json'),
        resolver,
        { allowProxyVirtualAddresses: true },
      ),
    ).rejects.toThrow(/forbidden/i);
  });

  it('resolves every answer and pins one validated public address', async () => {
    const resolver: DnsResolver = async () => [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '1.1.1.1', family: 4 },
    ];

    await expect(resolvePinnedTarget(new URL('https://example.com/style.json'), resolver)).resolves.toMatchObject({
      hostname: 'example.com',
      address: '2606:4700:4700::1111',
      family: 6,
    });
  });

  it('rejects an empty DNS result instead of falling back to system resolution', async () => {
    await expect(
      resolvePinnedTarget(new URL('https://example.com/style.json'), async () => []),
    ).rejects.toThrow(/DNS/i);
  });

  it('redacts credentials, fragments, and every query value from diagnostic URLs', () => {
    const redacted = redactUpstreamUrl(
      new URL('https://user:password@example.com/style.json?name=private&token=secret#fragment'),
    );
    expect(redacted).toBe(
      'https://example.com/style.json?name=%5BREDACTED%5D&token=%5BREDACTED%5D',
    );
  });
});
