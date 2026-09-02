import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeliveryAgent, deliver } from '../src/delivery/client.js';

let server: Server;
let port: number;
let handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void;

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const body = Buffer.from('{"hello":"world"}');
const headers = { 'content-type': 'application/json' };

/** Unguarded, so the response-handling tests can reach a loopback server on purpose. */
function plainAgent(): Agent {
  return new Agent();
}

describe('the guard refuses to open the socket', () => {
  it('blocks a literal loopback address', async () => {
    const agent = createDeliveryAgent();

    const outcome = await deliver(agent, {
      url: `http://127.0.0.1:${port}/hook`,
      body,
      headers,
      timeoutMs: 2_000,
    });

    expect(outcome.status).toBeNull();
    expect(outcome.error).toContain('127.0.0.0/8');
    await agent.close();
  });

  it('blocks a hostname that resolves to loopback', async () => {
    // This is the DNS rebinding case in miniature. The name is public-looking
    // and the address behind it is not, and only a connect-time check sees that.
    const agent = createDeliveryAgent();

    const outcome = await deliver(agent, {
      url: `http://localhost:${port}/hook`,
      body,
      headers,
      timeoutMs: 2_000,
    });

    expect(outcome.status).toBeNull();
    expect(outcome.error).toMatch(/non-public|127\.0\.0\.0|::1/);
    await agent.close();
  });

  it('blocks a decimal-encoded loopback address', async () => {
    const agent = createDeliveryAgent();

    const outcome = await deliver(agent, {
      url: `http://2130706433:${port}/hook`,
      body,
      headers,
      timeoutMs: 2_000,
    });

    expect(outcome.status).toBeNull();
    expect(outcome.error).toContain('127.0.0.0/8');
    await agent.close();
  });

  it('does not reach the destination at all', async () => {
    let hits = 0;
    handler = (_req, res) => {
      hits += 1;
      res.writeHead(200).end('ok');
    };

    const agent = createDeliveryAgent();
    await deliver(agent, { url: `http://127.0.0.1:${port}/hook`, body, headers, timeoutMs: 2_000 });

    expect(hits).toBe(0);
    await agent.close();
  });
});

describe('the development escape hatch', () => {
  it('is off unless asked for', async () => {
    const agent = createDeliveryAgent();

    const outcome = await deliver(agent, {
      url: `http://127.0.0.1:${port}/hook`,
      body,
      headers,
      timeoutMs: 2_000,
    });

    expect(outcome.status).toBeNull();
    await agent.close();
  });

  it('reaches a private address only when explicitly enabled', async () => {
    handler = (_req, res) => res.writeHead(200).end('ok');
    const agent = createDeliveryAgent({ allowPrivateAddresses: true });

    const outcome = await deliver(agent, {
      url: `http://127.0.0.1:${port}/hook`,
      body,
      headers,
      timeoutMs: 2_000,
    });

    expect(outcome.status).toBe(200);
    await agent.close();
  });
});

describe('reporting an outcome', () => {
  it('reports a 2xx with the body snippet', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('received');
    };
    const agent = plainAgent();

    const outcome = await deliver(agent, {
      url: `http://127.0.0.1:${port}/hook`,
      body,
      headers,
      timeoutMs: 2_000,
    });

    expect(outcome.status).toBe(200);
    expect(outcome.responseSnippet).toBe('received');
    expect(outcome.error).toBeNull();
    await agent.close();
  });

  it('forwards the body and headers it was given', async () => {
    let seen = '';
    let seenSignature = '';
    handler = (req, res) => {
      seenSignature = String(req.headers['x-hub-signature-256'] ?? '');
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen = Buffer.concat(chunks).toString();
        res.writeHead(200).end();
      });
    };
    const agent = plainAgent();

    await deliver(agent, {
      url: `http://127.0.0.1:${port}/hook`,
      body,
      headers: { ...headers, 'x-hub-signature-256': 'sha256=abc' },
      timeoutMs: 2_000,
    });

    expect(seen).toBe(body.toString());
    expect(seenSignature).toBe('sha256=abc');
    await agent.close();
  });

  it('records a 500 as an outcome rather than throwing', async () => {
    handler = (_req, res) => {
      res.writeHead(500).end('boom');
    };
    const agent = plainAgent();

    const outcome = await deliver(agent, {
      url: `http://127.0.0.1:${port}/hook`,
      body,
      headers,
      timeoutMs: 2_000,
    });

    expect(outcome.status).toBe(500);
    expect(outcome.error).toBeNull();
    await agent.close();
  });

  it('caps the snippet instead of storing whatever came back', async () => {
    handler = (_req, res) => {
      res.writeHead(200).end('x'.repeat(200_000));
    };
    const agent = plainAgent();

    const outcome = await deliver(agent, {
      url: `http://127.0.0.1:${port}/hook`,
      body,
      headers,
      timeoutMs: 5_000,
    });

    expect(outcome.responseSnippet!.length).toBeLessThanOrEqual(2_048);
    await agent.close();
  });

  it('keeps only the allowlisted response headers', async () => {
    handler = (_req, res) => {
      res
        .writeHead(200, {
          'content-type': 'application/json',
          'retry-after': '30',
          server: 'nginx/1.2.3-internal',
          'set-cookie': 'session=secret',
          'www-authenticate': 'Negotiate',
        })
        .end('{}');
    };
    const agent = plainAgent();

    const outcome = await deliver(agent, {
      url: `http://127.0.0.1:${port}/hook`,
      body,
      headers,
      timeoutMs: 2_000,
    });

    expect(outcome.responseHeaders).toMatchObject({ 'content-type': 'application/json', 'retry-after': '30' });
    expect(outcome.responseHeaders).not.toHaveProperty('server');
    expect(outcome.responseHeaders).not.toHaveProperty('set-cookie');
    expect(outcome.responseHeaders).not.toHaveProperty('www-authenticate');
    await agent.close();
  });

  it('gives up on a destination that never responds', async () => {
    handler = () => {
      /* accept the connection and hang */
    };
    const agent = plainAgent();

    const outcome = await deliver(agent, {
      url: `http://127.0.0.1:${port}/hook`,
      body,
      headers,
      timeoutMs: 300,
    });

    expect(outcome.status).toBeNull();
    expect(outcome.error).toBe('delivery failed');
    await agent.close();
  });

  it('collapses failure causes into one opaque error', async () => {
    // Refused, dropped and unreachable must not be separable, or the relay is a
    // port scanner for whoever supplied the destination.
    const agent = plainAgent();

    const refused = await deliver(agent, {
      url: 'http://127.0.0.1:9/hook',
      body,
      headers,
      timeoutMs: 500,
    });

    expect(refused.error).toBe('delivery failed');
    expect(refused.status).toBeNull();
    await agent.close();
  });

  it('reports duration in buckets rather than exact timings', async () => {
    handler = (_req, res) => {
      res.writeHead(200).end('ok');
    };
    const agent = plainAgent();

    const outcome = await deliver(agent, {
      url: `http://127.0.0.1:${port}/hook`,
      body,
      headers,
      timeoutMs: 2_000,
    });

    expect(outcome.durationMs % 100).toBe(0);
    await agent.close();
  });
});
