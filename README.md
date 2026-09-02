# HookRelay

Reliable webhook delivery. It receives events, stores them, and keeps retrying until they
land, logging every attempt and dead-lettering the ones that never succeed.

GitHub and Stripe POST an event to your server once. If your server is down at that
moment, the event is gone and nobody tells you. HookRelay sits in the middle. It accepts
the event, acknowledges it immediately, and takes responsibility for delivering it.

## Status

Phase 0. None of the delivery behaviour above exists yet.

Working today: a Fastify server with a `/health` route, Postgres and Redis under Compose,
environment validation that fails at boot rather than mid-request, and tests.

## Running it

Needs Node 24+ and Docker.

```sh
cp .env.example .env
npm install
docker compose up -d
npm run dev
```

Then:

```sh
curl http://localhost:3000/health
# {"status":"ok","uptime":3}
```

## Commands

| Command | Does |
| --- | --- |
| `npm run dev` | run the server, reloading on change |
| `npm test` | run the test suite |
| `npm run typecheck` | types only, no build |
| `npm run build` | compile to `dist/` |

## Not built yet

Ingest, the delivery worker, retries and backoff, the dead-letter queue, replay, the
dashboard. Which is to say everything that makes this HookRelay rather than a server.

`/health` reports that the process is alive. It does not check Postgres or Redis, so a
200 from it does not mean the system is ready to serve traffic.
