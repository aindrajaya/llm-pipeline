/**
 * Semaphore unit tests — node:test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../lib/semaphore.js';

describe('Semaphore', () => {
  test('throws on invalid maxConcurrent', () => {
    assert.throws(() => new Semaphore(0), RangeError);
    assert.throws(() => new Semaphore(-1), RangeError);
  });

  test('respects concurrency ceiling', async () => {
    const sem = new Semaphore(3);
    let activeCount = 0;
    let peakActive = 0;

    const tasks = Array.from({ length: 10 }, (_, i) =>
      sem.run(async () => {
        activeCount++;
        peakActive = Math.max(peakActive, activeCount);
        await new Promise(r => setTimeout(r, 20));
        activeCount--;
        return i;
      })
    );

    await Promise.all(tasks);
    assert.equal(peakActive, 3, `Peak concurrent should be 3, got ${peakActive}`);
  });

  test('run() resolves all tasks', async () => {
    const sem = new Semaphore(2);
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(n => sem.run(async () => n * 2))
    );
    assert.deepEqual(results.sort((a, b) => a - b), [2, 4, 6, 8, 10]);
  });

  test('exposes currentLoad and queueDepth', async () => {
    const sem = new Semaphore(1);
    const blocker = sem.run(() => new Promise(r => setTimeout(r, 100)));
    // Give the blocker time to acquire
    await new Promise(r => setTimeout(r, 10));
    assert.equal(sem.currentLoad, 1);
    await blocker;
    assert.equal(sem.currentLoad, 0);
  });
});
