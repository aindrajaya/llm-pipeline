/**
 * AbortController timeout unit tests — node:test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeItemWithTimeout, withTimeout } from '../lib/abort-timeout.js';

describe('analyzeItemWithTimeout', () => {
  test('resolves when inference completes before timeout', async () => {
    const item = { id: 'item-1' };
    const fastFn = async (_item, _opts) => ({ result: 'ok' });

    const result = await analyzeItemWithTimeout(item, fastFn, 500);
    assert.deepEqual(result, { result: 'ok' });
  });

  test('throws inference_timeout error when deadline exceeded', async () => {
    const item = { id: 'item-2' };
    const slowFn = (_item, { signal }) =>
      new Promise((_, reject) => {
        const t = setTimeout(() => {}, 1000);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          const err = new Error('AbortError');
          err.name = 'AbortError';
          reject(err);
        });
      });

    await assert.rejects(
      () => analyzeItemWithTimeout(item, slowFn, 50),
      (err) => {
        assert.equal(err.name, 'inference_timeout');
        assert.match(err.message, /inference_timeout after 50ms/);
        assert.equal(err.itemId, 'item-2');
        return true;
      }
    );
  });

  test('Promise.allSettled: timed-out item does not block sibling items', async () => {
    const items = [
      { id: 'fast-1' },
      { id: 'slow-2' },
      { id: 'fast-3' },
    ];

    const callFn = async (item, { signal }) => {
      if (item.id === 'slow-2') {
        return new Promise((_, reject) => {
          const t = setTimeout(() => {}, 5000);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            const err = new Error('AbortError');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      await new Promise(r => setTimeout(r, 10));
      return { analyzed: item.id };
    };

    const results = await Promise.allSettled(
      items.map(item => analyzeItemWithTimeout(item, callFn, 100))
    );

    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[0].value.analyzed, 'fast-1');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.name, 'inference_timeout');
    assert.equal(results[2].status, 'fulfilled');
    assert.equal(results[2].value.analyzed, 'fast-3');
  });
});

describe('withTimeout', () => {
  test('resolves when promise completes in time', async () => {
    const p = new Promise(r => setTimeout(() => r('done'), 10));
    const result = await withTimeout(p, 500);
    assert.equal(result, 'done');
  });

  test('rejects when deadline exceeded', async () => {
    const p = new Promise(r => setTimeout(() => r('too late'), 1000));
    await assert.rejects(
      () => withTimeout(p, 50, 'test operation'),
      /Timeout: test operation exceeded 50ms/
    );
  });
});
