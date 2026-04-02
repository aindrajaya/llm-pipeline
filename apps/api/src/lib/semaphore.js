/**
 * Async Semaphore — limits concurrent executions to `maxConcurrent`.
 *
 * Usage:
 *   const sem = new Semaphore(20);
 *   const results = await Promise.allSettled(
 *     items.map(item => sem.run(() => processItem(item)))
 *   );
 */
export class Semaphore {
  #maxConcurrent;
  #current = 0;
  #queue = [];

  constructor(maxConcurrent) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError('maxConcurrent must be a positive integer');
    }
    this.#maxConcurrent = maxConcurrent;
  }

  /**
   * Acquire a slot. Resolves when a slot is available.
   * @returns {Promise<void>}
   */
  acquire() {
    if (this.#current < this.#maxConcurrent) {
      this.#current++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#queue.push(resolve);
    });
  }

  /**
   * Release a slot, allowing the next queued item to proceed.
   */
  release() {
    const next = this.#queue.shift();
    if (next) {
      next(); // hand slot directly to next waiter
    } else {
      this.#current--;
    }
  }

  /**
   * Run `fn` within one semaphore slot. Automatically acquires and releases.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get currentLoad() {
    return this.#current;
  }

  get queueDepth() {
    return this.#queue.length;
  }
}
