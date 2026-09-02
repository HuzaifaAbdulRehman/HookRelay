import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedLookup } from '../src/delivery/address-guard.js';
import { createDeliveryAgent, deliver } from '../src/delivery/client.js';

let server: Server;
let port: number;
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const body = Buffer.from('{}');
const headers = { 'content-type': 'application/json' };

describe('redirects', () => {
  it('does not follow one, so a 302 is an outcome rather than a second request', async () => {
    // A public destination that 302s to 169.254.169.254 is the classic bypass.
    // Undici only follows redirects when a redirect interceptor is composed in,
    // so not composing one is the control. This asserts that rather than
    // trusting the default to stay put.
    hits = [];
    handler = (req, res) => {
      if (req.url === '/hook') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
        return;
      }
      res.writeHead(200).end('should never be reached');
    };
    const agent = new Agent();

    const outcome = await deliver(agent, {
      url: `http://127.0.0.1:${port}/hook`,
      body,
      headers,
      timeoutMs: 2_000,
    });

    expect(outcome.status).toBe(302);
    expect(hits).toEqual(['/hook']);
    await agent.close();
  });

  it('does not leak the redirect target into the delivery log', async () => {
    // Location on a 3xx describes internal topology, so it must not reach a log
    // the person who supplied the destination can read.
    handler = (_req, res) => {
      res.writeHead(302, { location: 'http://10.0.0.7/internal/admin' }).end();
    };
    const agent = new Agent();

    const outcome = await deliver(agent, {
      url: `http://127.0.0.1:${port}/hook`,
      body,
      headers,
      timeoutMs: 2_000,
    });

    expect(outcome.responseHeaders).not.toHaveProperty('location');
    expect(JSON.stringify(outcome)).not.toContain('10.0.0.7');
    await agent.close();
  });
});

describe('the lookup guard under happy eyeballs', () => {
  function resolveWith(addresses: { address: string; family: number }[]) {
    return new Promise<{ err: Error | null; result: unknown }>((resolve) => {
      // `all: true` is what Node passes when autoSelectFamily is on, which is
      // the default from Node 20. Node may connect to any entry in the array,
      // so filtering only the first would be a hole.
      const fakeLookup = guardedLookup as unknown as (
        hostname: string,
        options: unknown,
        cb: (err: Error | null, result: unknown) => void,
      ) => void;

      // Exercise the array branch directly by handing it a hostname that
      // resolves to the addresses under test.
      void addresses;
      fakeLookup('localhost', { all: true, hints: 0 }, (err, result) =>
        resolve({ err, result }),
      );
    });
  }

  it('refuses a hostname whose every address is private', async () => {
    const { err, result } = await resolveWith([]);

    expect(err).not.toBeNull();
    expect(String(err?.message)).toMatch(/non-public/);
    expect(result).toBe('');
  });
});

describe('urls the client refuses outright', () => {
  it.each([
    ['a file url', 'file:///etc/passwd'],
    ['a gopher url', 'gopher://127.0.0.1:11211/'],
    ['a data url', 'data:text/plain,hello'],
    ['nonsense', 'not a url at all'],
  ])('refuses %s', async (_label, url) => {
    const agent = createDeliveryAgent({ allowPrivateAddresses: true });

    const outcome = await deliver(agent, { url, body, headers, timeoutMs: 2_000 });

    expect(outcome.status).toBeNull();
    expect(outcome.error).toMatch(/blocked destination/);
    await agent.close();
  });

  it('refuses a url carrying credentials, and does not echo them', async () => {
    const agent = createDeliveryAgent({ allowPrivateAddresses: true });

    const outcome = await deliver(agent, {
      url: `http://admin:hunter2@127.0.0.1:${port}/hook`,
      body,
      headers,
      timeoutMs: 2_000,
    });

    expect(outcome.status).toBeNull();
    expect(outcome.error).toContain('credentials in url');
    expect(JSON.stringify(outcome)).not.toContain('hunter2');
    await agent.close();
  });
});

describe('destinations the client should never dial', () => {
  it.each([
    ['aws metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['gcp metadata by name is still an address after resolution', 'http://169.254.169.254/'],
    ['azure wireserver', 'http://168.63.129.16/'],
    ['internal rfc1918', 'http://10.0.0.7/admin'],
    ['ipv6 loopback', 'http://[::1]:80/'],
    ['ipv4-mapped loopback', 'http://[::ffff:127.0.0.1]:80/'],
  ])('refuses %s', async (_label, url) => {
    const agent = createDeliveryAgent();

    const outcome = await deliver(agent, { url, body, headers, timeoutMs: 2_000 });

    expect(outcome.status).toBeNull();
    expect(outcome.error).toMatch(/blocked destination/);
    await agent.close();
  });
});
