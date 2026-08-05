import { describe, it, expect } from 'vitest';
import { createSerialiser } from './serialise';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createSerialiser', () => {
  it('never runs two tasks at the same time', async () => {
    const serialise = createSerialiser();
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        serialise(async () => {
          active++;
          peak = Math.max(peak, active);
          await tick(5);
          active--;
        }),
      ),
    );

    // The whole point: concurrent og renders are what would blow the
    // container's memory cap.
    expect(peak).toBe(1);
  });

  it('preserves submission order', async () => {
    const serialise = createSerialiser();
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        serialise(async () => {
          // Earlier tasks sleep longer — order must come from the queue,
          // not from who finishes first.
          await tick((5 - n) * 4);
          order.push(n);
        }),
      ),
    );

    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('returns each task its own result', async () => {
    const serialise = createSerialiser();
    const results = await Promise.all([
      serialise(async () => 'a'),
      serialise(async () => 'b'),
      serialise(async () => 'c'),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('surfaces a failure to its own caller only', async () => {
    const serialise = createSerialiser();
    const failing = serialise(async () => {
      throw new Error('render blew up');
    });
    const following = serialise(async () => 'still fine');

    await expect(failing).rejects.toThrow('render blew up');
    await expect(following).resolves.toBe('still fine');
  });

  it('does not wedge permanently after a failure', async () => {
    // The dangerous bug: one bad render leaves the chain rejected and
    // every future card 500s until the container restarts.
    const serialise = createSerialiser();

    await expect(serialise(async () => { throw new Error('boom'); })).rejects.toThrow();
    await expect(serialise(async () => { throw new Error('boom again'); })).rejects.toThrow();

    await expect(serialise(async () => 'recovered')).resolves.toBe('recovered');
    await expect(serialise(async () => 'still working')).resolves.toBe('still working');
  });

  it('keeps separate serialisers independent', async () => {
    const a = createSerialiser();
    const b = createSerialiser();
    let bRan = false;

    const slow = a(async () => { await tick(20); });
    await b(async () => { bRan = true; });

    // b must not have waited on a's queue.
    expect(bRan).toBe(true);
    await slow;
  });
});
