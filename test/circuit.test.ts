import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/delivery/circuit.js';

function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('Circuit', () => {
  it('stays closed while failures are below the threshold', () => {
    const circuit = new Circuit({ threshold: 3 });

    circuit.recordFailure('a');
    circuit.recordFailure('a');

    expect(circuit.isOpen('a')).toBe(false);
  });

  it('opens on the threshold failure', () => {
    const circuit = new Circuit({ threshold: 3 });

    for (let i = 0; i < 3; i += 1) circuit.recordFailure('a');

    expect(circuit.isOpen('a')).toBe(true);
  });

  it('keeps destinations apart', () => {
    const circuit = new Circuit({ threshold: 2 });

    circuit.recordFailure('a');
    circuit.recordFailure('a');

    expect(circuit.isOpen('a')).toBe(true);
    expect(circuit.isOpen('b')).toBe(false);
  });

  it('closes as soon as a delivery succeeds', () => {
    const circuit = new Circuit({ threshold: 2 });
    circuit.recordFailure('a');
    circuit.recordFailure('a');

    circuit.recordSuccess('a');

    expect(circuit.isOpen('a')).toBe(false);
    expect(circuit.failures('a')).toBe(0);
  });

  it('lets exactly one probe through once the window has passed', () => {
    const time = clock();
    const circuit = new Circuit({ threshold: 2, openMs: 30_000 }, time.now);
    circuit.recordFailure('a');
    circuit.recordFailure('a');
    expect(circuit.isOpen('a')).toBe(true);

    time.advance(30_000);

    // One probe is allowed through, and the circuit closes again behind it so
    // the next delivery does not also get through while the probe is in flight.
    expect(circuit.isOpen('a')).toBe(false);
    circuit.recordFailure('a');
    expect(circuit.isOpen('a')).toBe(true);
  });

  it('does not reopen on its own before the window elapses', () => {
    const time = clock();
    const circuit = new Circuit({ threshold: 2, openMs: 30_000 }, time.now);
    circuit.recordFailure('a');
    circuit.recordFailure('a');

    time.advance(29_999);

    expect(circuit.isOpen('a')).toBe(true);
  });
});
