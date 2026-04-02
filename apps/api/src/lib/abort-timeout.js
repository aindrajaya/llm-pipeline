/**
 * Wraps an inference call with AbortController timeout.
 *
 * If the inference service does not respond within `timeoutMs`,
 * the item is marked failed with reason `inference_timeout`.
 *
 * @param {object} item - Batch item to analyze
 * @param {(item: object, options: {signal: AbortSignal}) => Promise<any>} callFn
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<any>}
 * @throws {Error} with name 'inference_timeout' if timed out
 */
export async function analyzeItemWithTimeout(item, callFn, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await callFn(item, { signal: controller.signal });
    return result;
  } catch (err) {
    if (err.name === 'AbortError' || controller.signal.aborted) {
      const timeoutErr = new Error(
        `inference_timeout after ${timeoutMs}ms for item ${item.id}`
      );
      timeoutErr.name = 'inference_timeout';
      timeoutErr.itemId = item.id;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Race a promise against a timeout.
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} [label]
 * @returns {Promise<T>}
 */
export function withTimeout(promise, timeoutMs, label = 'operation') {
  const timeout = new Promise((_, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`Timeout: ${label} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    // Prevent timer from keeping process alive
    if (t.unref) t.unref();
  });
  return Promise.race([promise, timeout]);
}
