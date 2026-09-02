import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { badge, escape, html, ladder, layout, raw } from '../dashboard/html.js';
import { listAttempts, replayEvent } from '../repository/attempts.js';
import { listEndpoints } from '../repository/endpoints.js';
import { countEventsByStatus, findEventById, listEvents } from '../repository/events.js';
import type { EventStatus } from '../repository/events.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DashboardOptions {
  db: Db;
  apiKey: string;
  onReplayed?: ((eventId: string, attempt: number) => Promise<void>) | undefined;
}

/**
 * Basic auth rather than a session.
 *
 * A browser cannot send a bearer header from a plain link, and a single
 * operator tool does not need login forms, cookies and a session table to guard
 * one credential. The password is the same API key the JSON routes take.
 */
function authorised(request: FastifyRequest, apiKey: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;

  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const offered = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
  const expected = Buffer.from(apiKey);

  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

/**
 * Rejects a state-changing form post that did not come from our own pages.
 *
 * Browsers attach Basic credentials automatically, the same way they attach
 * cookies, so a page on another site can submit a form here and the browser
 * will authenticate it. The bearer-token JSON route is not exposed this way
 * because nothing attaches an Authorization header on its own.
 *
 * Origin is compared against Host rather than a configured URL, so this stays
 * correct wherever it runs. Behind a proxy that rewrites Host, the proxy's
 * forwarded host is what would need comparing instead.
 */
function sameOrigin(request: FastifyRequest): boolean {
  const host = request.headers.host;
  if (typeof host !== 'string') return false;

  const stated = request.headers.origin ?? request.headers.referer;
  if (typeof stated !== 'string') return false;

  try {
    return new URL(stated).host === host;
  } catch {
    return false;
  }
}

function ago(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export const dashboardRoutes: FastifyPluginAsync<DashboardOptions> = async (app, opts) => {
  app.addHook('onRequest', async (request, reply) => {
    if (!authorised(request, opts.apiKey)) {
      return reply
        .code(401)
        .header('www-authenticate', 'Basic realm="HookRelay"')
        .type('text/plain')
        .send('unauthorised');
    }
  });

  app.get('/dashboard', async (_request, reply) => {
    const [endpoints, counts, recent] = await Promise.all([
      listEndpoints(opts.db),
      countEventsByStatus(opts.db),
      listEvents(opts.db, { limit: 25 }),
    ]);

    const endpointRows = endpoints
      .map(
        (endpoint) => html`<tr>
          <td><a href="/dashboard/endpoints/${endpoint.id}">${endpoint.name}</a></td>
          <td class="mono">${endpoint.destinationUrl}</td>
          <td>${endpoint.isActive ? 'active' : 'disabled'}</td>
          <td class="mono">/hook/${endpoint.id}</td>
        </tr>`,
      )
      .join('');

    const eventRows = recent.map((event) => eventRow(event)).join('');

    return reply.type('text/html').send(
      layout(
        'Overview',
        html`<h1>Overview</h1>
          <p class="sub">
            ${counts['dlq'] ?? 0} dead-lettered, ${counts['failed'] ?? 0} retrying,
            ${counts['delivered'] ?? 0} delivered
          </p>
          <h2>Endpoints</h2>
          ${endpoints.length === 0
            ? raw('<p class="empty">No endpoints yet. Create one with POST /endpoints.</p>')
            : raw(
                `<table><tr><th>Name</th><th>Destination</th><th>State</th><th>Ingest path</th></tr>${endpointRows}</table>`,
              )}
          <h2>Recent events</h2>
          ${recent.length === 0
            ? raw('<p class="empty">Nothing received yet.</p>')
            : raw(
                `<table><tr><th>Status</th><th>Delivery id</th><th>Attempts</th><th>Size</th><th>Received</th></tr>${eventRows}</table>`,
              )}`,
      ),
    );
  });

  app.get<{ Params: { id: string } }>('/dashboard/endpoints/:id', async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).type('text/plain').send('not found');

    const events = await listEvents(opts.db, { endpointId: request.params.id, limit: 100 });
    const rows = events.map((event) => eventRow(event)).join('');

    return reply.type('text/html').send(
      layout(
        'Endpoint',
        html`<h1>Endpoint</h1>
          <p class="sub mono">${request.params.id}</p>
          ${events.length === 0
            ? raw('<p class="empty">No events for this endpoint yet.</p>')
            : raw(
                `<table><tr><th>Status</th><th>Delivery id</th><th>Attempts</th><th>Size</th><th>Received</th></tr>${rows}</table>`,
              )}`,
      ),
    );
  });

  app.get<{ Params: { id: string } }>('/dashboard/events/:id', async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).type('text/plain').send('not found');

    const event = await findEventById(opts.db, request.params.id);
    if (event === null) return reply.code(404).type('text/plain').send('not found');

    const attempts = await listAttempts(opts.db, event.id);
    const attemptRows = attempts
      .map(
        (attempt) => html`<tr>
          <td>${attempt.attemptNumber}</td>
          <td>${raw(badge(attempt.status))}</td>
          <td>${attempt.responseStatus ?? '-'}</td>
          <td>${attempt.durationMs ?? '-'} ms</td>
          <td class="mono">${attempt.error ?? ''}</td>
        </tr>`,
      )
      .join('');

    const replayable = event.status === 'dlq' || event.status === 'failed';

    return reply.type('text/html').send(
      layout(
        'Event',
        html`<h1>Event ${raw(badge(event.status))}</h1>
          <p class="sub mono">${event.id}</p>
          <table>
            <tr><th>Delivery id</th><td class="mono">${event.providerEventId ?? 'none'}</td></tr>
            <tr><th>Attempts</th><td>${event.attemptCount}</td></tr>
            <tr><th>Received</th><td>${event.receivedAt.toISOString()}</td></tr>
            <tr><th>Payload</th><td>${event.body.length} bytes</td></tr>
          </table>
          <h2>Delivery log</h2>
          ${raw(ladder(attempts))}
          ${attempts.length === 0
            ? raw('<p class="empty">No attempts recorded yet.</p>')
            : raw(
                `<table><tr><th>#</th><th>Result</th><th>Status</th><th>Took</th><th>Error</th></tr>${attemptRows}</table>`,
              )}
          ${replayable
            ? raw(
                `<h2>Replay</h2><form method="post" action="/dashboard/events/${escape(event.id)}/replay"><button type="submit">Replay this event</button></form>`,
              )
            : raw('')}`,
      ),
    );
  });

  app.post<{ Params: { id: string } }>(
    '/dashboard/events/:id/replay',
    async (request, reply) => {
      if (!sameOrigin(request)) {
        return reply.code(403).type('text/plain').send('cross-origin form post refused');
      }
      if (!UUID.test(request.params.id)) return reply.code(404).type('text/plain').send('not found');

      const replayed = await replayEvent(opts.db, request.params.id);
      if (replayed !== null && opts.onReplayed !== undefined) {
        await opts.onReplayed(request.params.id, replayed.nextAttemptNumber);
      }

      return reply.redirect(`/dashboard/events/${request.params.id}`, 303);
    },
  );

  function eventRow(event: {
    id: string;
    status: EventStatus;
    providerEventId: string | null;
    attemptCount: number;
    bodyBytes: number;
    receivedAt: Date;
  }): string {
    return html`<tr>
      <td>${raw(badge(event.status))}</td>
      <td class="mono"><a href="/dashboard/events/${event.id}">${event.providerEventId ?? event.id.slice(0, 8)}</a></td>
      <td>${event.attemptCount}</td>
      <td>${event.bodyBytes} B</td>
      <td>${ago(event.receivedAt)}</td>
    </tr>`;
  }
};
