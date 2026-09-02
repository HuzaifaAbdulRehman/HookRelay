import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export class BlockedAddressError extends Error {
  constructor(
    readonly address: string,
    readonly reason: string,
  ) {
    super(`blocked destination ${address} (${reason})`);
    this.name = 'BlockedAddressError';
  }
}

/** IANA special-purpose ranges, plus one that is globally routable and still must not be reached. */
const V4_DENY: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
  // Azure WireServer. Globally routable and in no RFC range, so every
  // classifier-based filter calls it public. It has to be named.
  ['168.63.129.16', 32],
];

const V6_DENY: ReadonlyArray<readonly [string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['::ffff:0:0', 96],
  ['::ffff:0:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

const v4Deny = V4_DENY.map(([net, bits]) => [ipaddr.IPv4.parse(net), bits] as const);
const v6Deny = V6_DENY.map(([net, bits]) => [ipaddr.IPv6.parse(net), bits] as const);

/**
 * Throws unless the address is one we are willing to open a socket to.
 *
 * IPv6 can carry an IPv4 address inside it three different ways, and range
 * membership alone does not catch them: `2002:7f00:1::1` and `64:ff9b::7f00:1`
 * both wrap 127.0.0.1 and both look like ordinary unicast to a classifier. Each
 * embedding is unwrapped and re-checked as IPv4.
 */
export function checkAddress(raw: string): void {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(raw);
  } catch {
    throw new BlockedAddressError(raw, 'unparseable address');
  }

  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;

    if (v6.isIPv4MappedAddress()) {
      checkAddress(v6.toIPv4Address().toString());
      return;
    }

    const parts = v6.parts;
    if (parts[0] === 0x2002) {
      const [, a, b] = parts;
      checkAddress(new ipaddr.IPv4([a! >> 8, a! & 0xff, b! >> 8, b! & 0xff]).toString());
    }
    if (
      parts[0] === 0x0064 &&
      parts[1] === 0xff9b &&
      !parts[2] &&
      !parts[3] &&
      !parts[4] &&
      !parts[5]
    ) {
      const [, , , , , , a, b] = parts;
      checkAddress(new ipaddr.IPv4([a! >> 8, a! & 0xff, b! >> 8, b! & 0xff]).toString());
    }

    for (const [net, bits] of v6Deny) {
      if (v6.match(net, bits)) throw new BlockedAddressError(raw, `${net.toString()}/${bits}`);
    }
    return;
  }

  const v4 = parsed as ipaddr.IPv4;
  for (const [net, bits] of v4Deny) {
    if (v4.match(net, bits)) throw new BlockedAddressError(raw, `${net.toString()}/${bits}`);
  }
}

export function isAllowedAddress(raw: string): boolean {
  try {
    checkAddress(raw);
    return true;
  } catch {
    return false;
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * DNS lookup that refuses to hand back an address we will not connect to.
 *
 * Node 24 has Happy Eyeballs on by default, so this is called with `all: true`
 * and receives every resolved address. Node may connect to any of them, so
 * checking only the first is a hole: `localhost` resolves to `[::1, 127.0.0.1]`
 * and a first-entry check on a hostname that resolves to a public address plus
 * a private one lets the private one through.
 */
export function guardedLookup(
  hostname: string,
  options: Parameters<typeof dnsLookup>[1],
  callback: LookupCallback,
): void {
  dnsLookup(hostname, { ...(options as object), verbatim: true }, (err, address, family) => {
    if (err) {
      callback(err, '');
      return;
    }

    if (Array.isArray(address)) {
      const safe = address.filter((entry) => isAllowedAddress(entry.address));
      if (safe.length === 0) {
        callback(
          new BlockedAddressError(hostname, 'every resolved address is non-public') as NodeJS.ErrnoException,
          '',
        );
        return;
      }
      callback(null, safe);
      return;
    }

    try {
      checkAddress(address as string);
    } catch (blocked) {
      callback(blocked as NodeJS.ErrnoException, '');
      return;
    }
    callback(null, address as string, family);
  });
}

/** Literal addresses skip DNS entirely, so `guardedLookup` never sees them. */
export function checkLiteralHost(hostname: string): void {
  if (isIP(hostname) !== 0) checkAddress(hostname);
}
