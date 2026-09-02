import type { Socket } from 'node:net';
import { Agent, buildConnector, request } from 'undici';
import {
  BlockedAddressError,
  checkLiteralHost,
  guardedLookup,
  isAllowedAddress,
} from './address-guard.js';

/** Enough of the response to debug with, small enough not to be an exfiltration channel. */
const MAX_SNIPPET_BYTES = 2_048;

/** Everything else can carry internal detail: Server, Set-Cookie, WWW-Authenticate, Location. */
const LOGGED_HEADERS = ['content-type', 'content-length', 'retry-after'] as const;

/** Refused, reset and dropped connections are separable by timing otherwise, which is a port scanner. */
const DURATION_BUCKET_MS = 100;

export interface DeliveryOutcome {
  status: number | null;
  durationMs: number;
  responseSnippet: string | null;
  responseHeaders: Record<string, string>;
  error: string | null;
}

export interface DeliveryRequest {
  url: string;
  body: Buffer;
  headers: Record<string, string>;
  timeoutMs: number;
}

/**
 * An agent that will not open a socket to a non-public address.
 *
 * Two hooks are needed, not one. `lookup` is passed at build time because
 * `buildConnector` ignores a per-request one, and it never fires at all for a
 * literal address since those skip DNS. The post-connect check on
 * `remoteAddress` is the backstop for anything that resolved outside the shim.
 *
 * Validating here rather than when a destination is saved is what closes DNS
 * rebinding: the address is checked and connected to in the same call, so there
 * is no window in which it can change. It also handles redirects for free,
 * since every hop opens a new socket through this hook.
 */
export interface AgentOptions {
  connectTimeoutMs?: number;
  /** Development only. See ALLOW_PRIVATE_DESTINATIONS. */
  allowPrivateAddresses?: boolean;
}

export function createDeliveryAgent(options: AgentOptions = {}): Agent {
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;

  if (options.allowPrivateAddresses === true) {
    return new Agent({ connect: { timeout: connectTimeoutMs } });
  }

  const connector = buildConnector({
    timeout: connectTimeoutMs,
    lookup: guardedLookup as never,
  });

  return new Agent({
    connect(options, callback) {
      const hostname = String(options.hostname ?? '');
      try {
        checkLiteralHost(hostname);
      } catch (blocked) {
        callback(blocked as Error, null);
        return;
      }

      connector(options as never, (err, socket) => {
        if (err) {
          callback(err, null);
          return;
        }

        const peer = (socket as Socket).remoteAddress;
        if (peer === undefined || !isAllowedAddress(peer)) {
          socket?.destroy();
          callback(new BlockedAddressError(peer ?? 'unknown', 'post-connect peer check'), null);
          return;
        }

        callback(null, socket);
      });
    },
  });
}

/**
 * Rejects a destination before a socket is considered.
 *
 * The address guard handles where a request goes. This handles what the URL is
 * allowed to be: only http and https, and no embedded credentials. `new URL`
 * keeps `username` and `password`, so a destination of
 * `https://admin:hunter2@example.com/` would put a password into a delivery log
 * the person who supplied it can read.
 */
export function assertDeliverableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedAddressError(raw, 'not a url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedAddressError(raw, `unsupported scheme ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new BlockedAddressError(url.host, 'credentials in url');
  }

  return url;
}

function quantise(ms: number): number {
  return Math.round(ms / DURATION_BUCKET_MS) * DURATION_BUCKET_MS;
}

function pickHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of LOGGED_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string') picked[name] = value;
    else if (Array.isArray(value) && value[0] !== undefined) picked[name] = value[0];
  }
  return picked;
}

/**
 * Sends one delivery and reports what happened. Never throws for a failed
 * delivery: a refusal is an outcome to record, not an exception to handle.
 */
export async function deliver(agent: Agent, req: DeliveryRequest): Promise<DeliveryOutcome> {
  const started = process.hrtime.bigint();
  const elapsed = () => quantise(Number(process.hrtime.bigint() - started) / 1e6);

  try {
    const url = assertDeliverableUrl(req.url);

    const res = await request(url, {
      dispatcher: agent,
      method: 'POST',
      body: req.body,
      headers: req.headers,
      signal: AbortSignal.timeout(req.timeoutMs),
      // Undici does not follow redirects unless a redirect interceptor is
      // composed in. A destination has no business redirecting a webhook, and
      // chasing one would mean revalidating every hop.
    });

    // Cap by aborting rather than reading and slicing. Reading first would pull
    // a large internal response into memory before the limit could apply.
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      chunks.push(buf.subarray(0, Math.max(0, MAX_SNIPPET_BYTES - total)));
      total += buf.length;
      if (total >= MAX_SNIPPET_BYTES) {
        res.body.destroy();
        break;
      }
    }

    return {
      status: res.statusCode,
      durationMs: elapsed(),
      responseSnippet: Buffer.concat(chunks).toString('utf8'),
      responseHeaders: pickHeaders(res.headers),
      error: null,
    };
  } catch (err) {
    return {
      status: null,
      durationMs: elapsed(),
      responseSnippet: null,
      responseHeaders: {},
      // Blocked addresses say which range; everything else is collapsed so a
      // caller cannot separate refused from dropped from unreachable.
      error: err instanceof BlockedAddressError ? err.message : 'delivery failed',
    };
  }
}
