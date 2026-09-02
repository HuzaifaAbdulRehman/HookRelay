import { describe, expect, it } from 'vitest';
import { BlockedAddressError, checkAddress, isAllowedAddress } from '../src/delivery/address-guard.js';

describe('checkAddress', () => {
  it.each([
    ['loopback', '127.0.0.1'],
    ['loopback, other octet', '127.99.42.7'],
    ['this network', '0.0.0.0'],
    ['private 10/8', '10.1.2.3'],
    ['private 172.16/12', '172.20.0.1'],
    ['private 192.168/16', '192.168.1.1'],
    ['carrier grade nat', '100.64.0.1'],
    ['aws and gcp metadata', '169.254.169.254'],
    ['ecs task metadata', '169.254.170.2'],
    ['oracle cloud metadata', '192.0.0.192'],
    ['alibaba metadata', '100.100.100.200'],
    ['azure wireserver', '168.63.129.16'],
    ['broadcast', '255.255.255.255'],
    ['multicast', '224.0.0.1'],
    ['reserved', '240.0.0.1'],
  ])('blocks %s', (_label, address) => {
    expect(() => checkAddress(address)).toThrow(BlockedAddressError);
  });

  it.each([
    ['unspecified', '::'],
    ['loopback', '::1'],
    ['link local', 'fe80::1'],
    ['unique local', 'fd00::1'],
    ['aws ipv6 metadata', 'fd00:ec2::254'],
    ['multicast', 'ff02::1'],
    ['documentation', '2001:db8::1'],
  ])('blocks ipv6 %s', (_label, address) => {
    expect(() => checkAddress(address)).toThrow(BlockedAddressError);
  });

  it.each([
    ['ipv4-mapped loopback', '::ffff:127.0.0.1'],
    ['ipv4-mapped metadata', '::ffff:169.254.169.254'],
    ['ipv4-compatible loopback', '::127.0.0.1'],
    ['6to4 wrapping loopback', '2002:7f00:1::1'],
    ['6to4 wrapping metadata', '2002:a9fe:a9fe::1'],
    ['nat64 wrapping loopback', '64:ff9b::7f00:1'],
    ['nat64 wrapping metadata', '64:ff9b::a9fe:a9fe'],
  ])('blocks %s, which range checks alone would miss', (_label, address) => {
    expect(() => checkAddress(address)).toThrow(BlockedAddressError);
  });

  it.each([
    ['a public v4', '93.184.216.34'],
    ['another public v4', '1.1.1.1'],
    ['a public v6', '2606:4700:4700::1111'],
  ])('allows %s', (_label, address) => {
    expect(() => checkAddress(address)).not.toThrow();
  });

  it('rejects anything it cannot parse rather than passing it through', () => {
    for (const value of ['', 'not-an-address', '999.1.1.1', 'localhost']) {
      expect(isAllowedAddress(value)).toBe(false);
    }
  });

  it('names the range that blocked it', () => {
    try {
      checkAddress('169.254.169.254');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BlockedAddressError);
      expect((err as BlockedAddressError).reason).toBe('169.254.0.0/16');
    }
  });
});

describe('encoded forms', () => {
  // The WHATWG URL parser normalises decimal, octal, hex and short forms back to
  // dotted quad, so the guard only ever sees canonical addresses. This asserts
  // that assumption rather than trusting it, because if it ever stopped holding
  // the guard would be looking at the wrong string.
  it.each([
    ['decimal', 'http://2130706433/', '127.0.0.1'],
    ['octal', 'http://0177.0.0.1/', '127.0.0.1'],
    ['hex', 'http://0x7f000001/', '127.0.0.1'],
    ['short form', 'http://127.1/', '127.0.0.1'],
    ['bare zero', 'http://0/', '0.0.0.0'],
  ])('the url parser normalises %s to a canonical address', (_label, url, expected) => {
    const { hostname } = new URL(url);
    expect(hostname).toBe(expected);
    expect(isAllowedAddress(hostname)).toBe(false);
  });
});
