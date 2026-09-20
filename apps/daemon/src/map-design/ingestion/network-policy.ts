import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { redactUpstreamUrl } from './redaction.js';

export interface PinnedTarget {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface ResolvePinnedTargetOptions {
  readonly allowProxyVirtualAddresses?: boolean;
}

export type DnsResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export class NetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkPolicyError';
  }
}

const IPV4_FORBIDDEN: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc01fc400, 24],
  [0xc034c100, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc0af3000, 24],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

const IPV6_FORBIDDEN: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0, 0, 0, 0, 0, 0, 0, 0], 128],
  [[0, 0, 0, 0, 0, 0, 0, 1], 128],
  [[0, 0, 0, 0, 0, 0xffff, 0, 0], 96],
  [[0, 0, 0, 0, 0xffff, 0, 0, 0], 96],
  [[0x0064, 0xff9b, 0x0001, 0, 0, 0, 0, 0], 48],
  [[0x0100, 0, 0, 0, 0, 0, 0, 0], 64],
  [[0x2001, 0, 0, 0, 0, 0, 0, 0], 23],
  [[0x2001, 0x0db8, 0, 0, 0, 0, 0, 0], 32],
  [[0x2002, 0, 0, 0, 0, 0, 0, 0], 16],
  [[0x3fff, 0, 0, 0, 0, 0, 0, 0], 20],
  [[0x5f00, 0, 0, 0, 0, 0, 0, 0], 16],
  [[0xfc00, 0, 0, 0, 0, 0, 0, 0], 7],
  [[0xfe80, 0, 0, 0, 0, 0, 0, 0], 10],
  [[0xfec0, 0, 0, 0, 0, 0, 0, 0], 10],
  [[0xff00, 0, 0, 0, 0, 0, 0, 0], 8],
];

function ipv4Number(address: string): number | null {
  const octets = address.split('.');
  if (octets.length !== 4) return null;
  let value = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/u.test(octet)) return null;
    const parsed = Number(octet);
    if (parsed > 255) return null;
    value = ((value << 8) | parsed) >>> 0;
  }
  return value;
}

function ipv4InCidr(value: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (network & mask) >>> 0;
}

export function isProxyVirtualAddress(address: string): boolean {
  const value = ipv4Number(address);
  return value !== null && ipv4InCidr(value, 0xc6120000, 15);
}

function expandIpv6(address: string): number[] | null {
  const zoneIndex = address.indexOf('%');
  if (zoneIndex !== -1) return null;
  let normalized = address.toLowerCase();
  const ipv4Tail = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  if (ipv4Tail) {
    const ipv4 = ipv4Number(ipv4Tail);
    if (ipv4 === null) return null;
    normalized = `${normalized.slice(0, -ipv4Tail.length)}${(ipv4 >>> 16).toString(16)}:${(
      ipv4 & 0xffff
    ).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const pieces = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (pieces.length !== 8) return null;
  const words: number[] = [];
  for (const piece of pieces) {
    if (!/^[0-9a-f]{1,4}$/u.test(piece)) return null;
    words.push(Number.parseInt(piece, 16));
  }
  return words;
}

function ipv6InCidr(value: readonly number[], network: readonly number[], prefix: number): boolean {
  let bits = prefix;
  for (let index = 0; index < 8 && bits > 0; index += 1) {
    const width = Math.min(16, bits);
    const mask = width === 16 ? 0xffff : (0xffff << (16 - width)) & 0xffff;
    if (((value[index] ?? 0) & mask) !== ((network[index] ?? 0) & mask)) return false;
    bits -= width;
  }
  return true;
}

export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return value === null || IPV4_FORBIDDEN.some(([network, prefix]) => ipv4InCidr(value, network, prefix));
  }
  if (family !== 6) return true;
  const words = expandIpv6(address);
  if (!words) return true;

  const mappedIpv4 =
    words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
      ? (((words[6] ?? 0) << 16) | (words[7] ?? 0)) >>> 0
      : null;
  if (mappedIpv4 !== null) return true;
  return IPV6_FORBIDDEN.some(([network, prefix]) => ipv6InCidr(words, network, prefix));
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return hostname.toLowerCase();
}

export function validateUpstreamUrl(input: URL): URL {
  const url = new URL(input.href);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetworkPolicyError('Only HTTP(S) upstream URLs are permitted');
  }
  if (url.username || url.password) {
    throw new NetworkPolicyError('Upstream URL credentials are forbidden');
  }
  if (url.hash) throw new NetworkPolicyError('Upstream URL fragments are forbidden');
  const hostname = normalizedHostname(url);
  if (!hostname || hostname.endsWith('.') || hostname.includes('%')) {
    throw new NetworkPolicyError(`Ambiguous upstream hostname: ${redactUpstreamUrl(url)}`);
  }
  if (isIP(hostname) === 0) {
    const specialUseHostname = [
      'localhost',
      '.localhost',
      '.local',
      '.home.arpa',
      '.internal',
      '.invalid',
      '.test',
      '.example',
      '.onion',
    ].some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix));
    if (!hostname.includes('.') || specialUseHostname) {
      throw new NetworkPolicyError(`Ambiguous upstream hostname: ${redactUpstreamUrl(url)}`);
    }
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname)) {
      throw new NetworkPolicyError(`Ambiguous upstream hostname: ${redactUpstreamUrl(url)}`);
    }
  }
  return url;
}

export const systemDnsResolver: DnsResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.flatMap((answer) =>
    answer.family === 4 || answer.family === 6
      ? [{ address: answer.address, family: answer.family }]
      : [],
  );
};

export async function resolvePinnedTarget(
  input: URL,
  resolver: DnsResolver = systemDnsResolver,
  options: ResolvePinnedTargetOptions = {},
): Promise<PinnedTarget> {
  const url = validateUpstreamUrl(input);
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  const answers: readonly ResolvedAddress[] =
    literalFamily === 4 || literalFamily === 6
      ? [{ address: hostname, family: literalFamily }]
      : await resolver(hostname);
  if (answers.length === 0) throw new NetworkPolicyError('DNS resolution returned no addresses');

  for (const answer of answers) {
    if (answer.family !== 4 && answer.family !== 6) {
      throw new NetworkPolicyError('DNS returned an unsupported address family');
    }
    if (isIP(answer.address) !== answer.family) {
      throw new NetworkPolicyError('DNS returned a malformed address');
    }
    const allowedProxyVirtualAddress = options.allowProxyVirtualAddresses === true
      && url.protocol === 'https:'
      && literalFamily === 0
      && isProxyVirtualAddress(answer.address);
    if (isForbiddenAddress(answer.address) && !allowedProxyVirtualAddress) {
      throw new NetworkPolicyError('DNS returned a forbidden private or reserved address');
    }
  }

  const selected = answers[0];
  if (!selected) throw new NetworkPolicyError('DNS resolution returned no addresses');
  return { url, hostname, address: selected.address, family: selected.family };
}
