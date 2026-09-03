import {
  type Relay,
  createEndpoint,
  deliver,
  percentiles,
  startDestination,
  table,
} from './harness.js';

const RUNS = 3;
const EVENTS_PER_RUN = 200;

/**
 * Does a dead destination slow down accepting webhooks?
 *
 * This is the claim the whole architecture rests on. Ingest persists and
 * acknowledges; delivery happens elsewhere. If that separation is real, a
 * destination that never answers should not move the ingest latency at all.
 *
 * The destination hangs rather than refusing, because a refused connection
 * returns in microseconds and would not test anything.
 */
async function main(): Promise<void> {
  const relay: Relay = {
    base: process.env.RELAY_BASE ?? 'http://localhost:3000',
    apiKey: process.env.API_KEY ?? '',
  };
  if (relay.apiKey === '') throw new Error('API_KEY must be set');

  const rows: Record<string, string | number>[] = [];

  for (const mode of ['ok', 'hang'] as const) {
    const destination = await startDestination(mode);
    const endpoint = await createEndpoint(relay, `bench-${mode}-${Date.now()}`, destination.url);

    const runs: number[][] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const samples: number[] = [];
      for (let i = 0; i < EVENTS_PER_RUN; i += 1) {
        samples.push(await deliver(endpoint.ingest, endpoint.secret, `${mode}-${run}-${i}`));
      }
      runs.push(samples);
    }

    for (const [index, samples] of runs.entries()) {
      const p = percentiles(samples);
      rows.push({
        destination: mode === 'ok' ? 'healthy' : 'hanging',
        run: index + 1,
        n: p.n,
        'p50 ms': p.p50.toFixed(2),
        'p95 ms': p.p95.toFixed(2),
        'p99 ms': p.p99.toFixed(2),
        'max ms': p.max.toFixed(2),
      });
    }

    await destination.close();
  }

  console.log(`\n### Ingest latency, ${RUNS} runs of ${EVENTS_PER_RUN} events each\n`);
  console.log(table(rows));
}

await main();
