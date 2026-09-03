# Measured behaviour

Three questions, measured rather than asserted. Everything here was produced by the scripts
in `bench/`, which anyone can rerun.

## How

One laptop: Intel i5-8350U (4 cores, 8 threads, 1.7 GHz base), 16 GB RAM, Windows 10.
Postgres 16 and Redis 7 in Docker Desktop on the WSL2 backend. Node 24.13.0. Worker
concurrency 10, delivery timeout 10 s, retry ladder with equal jitter from a 1 s base.

The relay, the load generator and the destinations all run on the same machine, so the
absolute numbers are worse than a real deployment would see. The comparisons are what
matter, and both sides of every comparison carry the same overhead.

Destinations **hang** rather than refuse. A refused connection returns in microseconds and
costs a worker nothing, so it would not test anything. A destination that accepts a
connection and never answers is the failure that actually hurts.

Percentiles are nearest-rank, so every figure printed is a value that occurred.

## A dead destination does not slow down accepting webhooks

The architecture rests on this: ingest persists and acknowledges, delivery happens
elsewhere. If that separation is real, a destination that never answers should not move
the ingest latency.

Three runs of 200 events each, sent sequentially.

| destination | run | p50 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- |
| healthy | 1 | 17.91 | 44.75 | 80.37 | 109.33 |
| healthy | 2 | 24.63 | 66.95 | 104.98 | 178.28 |
| healthy | 3 | 22.85 | 53.39 | 242.82 | 436.79 |
| hanging | 1 | 27.14 | 130.52 | 208.60 | 829.23 |
| hanging | 2 | 17.34 | 104.73 | 162.46 | 188.33 |
| hanging | 3 | 18.33 | 52.98 | 87.30 | 141.53 |

The medians are indistinguishable: 17.9–24.6 ms healthy against 17.3–27.1 ms hanging, with
the ranges overlapping. The separation holds.

The tails are noisy in **both** directions, which is the honest reading. A healthy run
produced a p99 of 242 ms while a hanging run produced 87 ms. On a laptop running Postgres
and Redis through a WSL2 virtual machine, tail latency is dominated by the host rather
than by the destination's state. Anyone claiming a tail effect from these numbers would be
reading noise.

## One dead destination starves every other endpoint

A hanging delivery holds a worker slot for the whole 10 s timeout. With a shared queue and
a fixed concurrency, enough of them occupy every slot and an unrelated endpoint waits.

Measured as the time from accepting a webhook on a healthy endpoint to that destination
actually receiving it, with and without a noisy neighbour.

| noisy neighbour | run | p50 ms | max ms |
| --- | --- | --- | --- |
| none | 1 | 189 | 299 |
| none | 2 | 151 | 185 |
| none | 3 | 577 | 739 |
| 40 hanging | 1 | 35,022 | 35,210 |
| 40 hanging | 2 | 35,311 | 35,524 |
| 40 hanging | 3 | 38,947 | 38,971 |

Roughly a hundredfold degradation, and it matches the model exactly: 40 events over a
concurrency of 10 is four waves, each held for the 10 s timeout, so about 40 s. Observed
35–39 s.

This is not a bug in the delivery code. It is what a shared queue with fixed concurrency
does, and BullMQ's maintainer says as much in issue #303: *"Currently there is not a
perfect solution for this in BullMQ."* Even the paid Groups feature does not fix it here,
because it cannot preserve ordering when a job fails and is retried, and for webhook
delivery retries are the workload.

## A circuit breaker bounds the damage, and the bound does not grow

Once a destination has failed repeatedly there is no information left in dialling it
again, so `src/delivery/circuit.ts` reschedules the job without the call. The slot is
freed in microseconds instead of seconds. Five consecutive failures open it; it stays open
30 s and then lets one probe through.

| noisy neighbour | run | p50 ms |
| --- | --- | --- |
| none | 1 | 149 |
| none | 2 | 133 |
| none | 3 | 145 |
| 40 hanging | 1 | 8,893 |
| 40 hanging | 2 | 8,810 |
| 40 hanging | 3 | 8,795 |

From ~37 s to ~8.8 s, a bit over fourfold.

The residual is not waste, it is the cost of learning. With concurrency 10, a full wave of
hanging deliveries starts before any of them has failed, so one 10 s timeout elapses before
the circuit can open. That predicts something stronger than a fourfold win: the delay
should be **bounded by one wave regardless of how large the backlog is**. Tested:

| backlog | run 1 | run 2 |
| --- | --- | --- |
| 40 hanging | 8,794 ms | 8,432 ms |
| 120 hanging | 8,207 ms | 8,339 ms |
| 240 hanging | 6,154 ms | 7,143 ms |

Six times the backlog, no growth in the delay. It drifts slightly *downward*, which makes
sense: more events in flight means the five failures needed to open the circuit accumulate
sooner relative to the healthy events being sent.

So the change is not "four times faster". It is that the delay stopped scaling with the
backlog at all.

## What this does not show

**The unmitigated case was only measured at a backlog of 40.** The wave model predicts
linear growth, and 120 events without the breaker would need about two minutes, past the
90 s patience the harness allows. That growth is predicted, not measured, and the
distinction matters.

**The circuit is per process.** Two worker processes each learn about a dead destination
separately, so the cost is one extra timeout wave per process. That was a deliberate
trade: sharing the state would put a coordination dependency in the delivery path. It has
not been measured with more than one worker.

**Nothing here is a throughput benchmark.** Events are sent sequentially, so these numbers
say nothing about events per second. They answer the question of whether a failing
destination affects things that should be independent of it.

**Duplicate delivery under worker crashes is not measured.** At-least-once means duplicates
are certain rather than possible, and the ceiling is asserted from the design rather than
observed. That gap is the obvious next measurement.
