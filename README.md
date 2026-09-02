# HookRelay

Reliable webhook delivery. It receives events, stores them, and keeps retrying until they
land, logging every attempt and dead-lettering the ones that never succeed.

GitHub and Stripe POST an event to your server once. If your server is down at that
moment, the event is gone and nobody tells you. HookRelay sits in the middle. It accepts
the event, acknowledges it immediately, and takes responsibility for delivering it.

## Status

Phase 1. The schema exists and is tested. Nothing is ingested or delivered yet.

Working today: a Fastify server with a `/health` route, Postgres and Redis under Compose,
environment validation that fails at boot rather than mid-request, reversible migrations,
and repositories for endpoints and events with 26 tests behind them.

## Running it

Needs Node 24+ and Docker.

```sh
cp .env.example .env
npm install
docker compose up -d --wait
npm run migrate:up
npm run dev
```

Then:

```sh
curl http://localhost:3000/health
# {"status":"ok","uptime":3}
```

Tests need the database up. They create `hookrelay_test` themselves and migrate it through
the same CLI the app uses, so a schema that works only under test cannot exist.

## Commands

| Command | Does |
| --- | --- |
| `npm run dev` | run the server, reloading on change |
| `npm test` | run the test suite |
| `npm run typecheck` | types only, no build |
| `npm run build` | compile to `dist/` |
| `npm run migrate:up` | apply migrations |
| `npm run migrate:down` | roll the last one back |

## Schema notes

Two decisions worth knowing before reading the migration.

**The payload is `bytea`, not `jsonb`.** GitHub signs the exact bytes it sent. Parsing to
JSON and re-serialising reorders keys and drops whitespace, so the signature would never
verify again and a replay would send something the provider never signed.

**The idempotency index is partial**, covering only rows that carry a provider delivery id:

```sql
CREATE UNIQUE INDEX events_endpoint_provider_key
  ON events (endpoint_id, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
```

A null there means the provider sent no delivery id, which is identity *unknown*, not
identity *shared*. Two events that both lack an id are two events. Using
`NULLS NOT DISTINCT` would allow one keyless event per endpoint, ever, and silently
discard the rest.

## Not built yet

Ingest, the delivery worker, retries and backoff, the dead-letter queue, replay, and the
dashboard. Which is to say everything that makes this HookRelay rather than a schema.

`/health` reports that the process is alive. It does not check Postgres or Redis, so a
200 from it does not mean the system is ready to serve traffic.
