import 'dotenv/config';
import { Worker } from 'bullmq';
import { redisConnection } from '../lib/redis.js';
import { themeAggQueue, deadLetterQueue } from '../lib/queues.js';
import { Semaphore } from '../lib/semaphore.js';
import { analyzeItemWithTimeout } from '../lib/abort-timeout.js';
import { query } from '../db/index.js';
import { logger } from '../lib/logger.js';

const INFERENCE_URL = process.env.INFERENCE_SERVICE_URL || 'http://localhost:8000';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_INFERENCE || '20', 10);
const ITEM_TIMEOUT_MS = parseInt(process.env.ITEM_TIMEOUT_MS || '30000', 10);
const MAX_RETRIES = 2;

/**
 * Call the inference service for a single batch item.
 * @param {object} item - BatchItem row
 * @param {{signal: AbortSignal}} options
 * @returns {Promise<object>} AnalysisResult
 */
async function callInferenceService(item, { signal }) {
  const endpoint = item.source_type === 'audio' ? '/analyze/audio' : '/analyze/text';
  const body = item.source_type === 'audio'
    ? { item_id: item.id, file_url: item.file_url }
    : { item_id: item.id, text: item.raw_text, file_url: item.file_url };

  const response = await fetch(`${INFERENCE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Inference service error ${response.status}: ${errBody}`);
  }
  return response.json();
}

/**
 * Analyze a single item with retry logic (max 2 retries, exponential backoff).
 * @param {object} item - BatchItem row
 * @returns {Promise<{success: boolean, result?: object, error?: string}>}
 */
async function analyzeItemWithRetry(item) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.min(1000 * 2 ** attempt, 10_000);
      await new Promise(r => setTimeout(r, backoffMs));
      await query(
        `UPDATE batch_items SET retry_count = retry_count + 1 WHERE id = $1`,
        [item.id]
      );
    }

    try {
      const result = await analyzeItemWithTimeout(item, callInferenceService, ITEM_TIMEOUT_MS);
      return { success: true, result };
    } catch (err) {
      lastError = err;
      const isTimeout = err.name === 'inference_timeout';
      logger.warn(
        { itemId: item.id, attempt, error: err.message, isTimeout },
        'Item analysis failed'
      );
      // Don't retry timeouts — mark as failed immediately
      if (isTimeout) break;
    }
  }
  return { success: false, error: lastError?.message || 'Unknown error' };
}

/**
 * Fan-out: process all items in a batch with semaphore concurrency cap.
 * Uses Promise.allSettled — a failed item never blocks sibling items.
 * @param {string} batchId
 * @param {object[]} items
 */
async function processBatch(batchId, items) {
  const semaphore = new Semaphore(MAX_CONCURRENT);

  const tasks = items.map(item =>
    semaphore.run(async () => {
      // Mark item as processing
      await query(
        `UPDATE batch_items SET status = 'processing', started_at = now() WHERE id = $1`,
        [item.id]
      );

      const { success, result, error } = await analyzeItemWithRetry(item);

      if (success) {
        // Persist analysis report
        await query(
          `INSERT INTO analysis_reports
             (batch_item_id, model_name, model_version, summary, deception_indicators, confidence_score, raw_output)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            item.id,
            result.model_name || 'mistral-small-3.2',
            result.model_version || '1.0.0',
            result.summary,
            JSON.stringify(result.deception_indicators || []),
            result.confidence_score,
            JSON.stringify(result.raw_output || {}),
          ]
        );
        await query(
          `UPDATE batch_items SET status = 'completed', completed_at = now() WHERE id = $1`,
          [item.id]
        );
      } else {
        await query(
          `UPDATE batch_items SET status = 'failed', error_message = $2, completed_at = now() WHERE id = $1`,
          [item.id, error]
        );
        // Dead-letter if retries exhausted
        await deadLetterQueue.add('failed-item', { batchId, itemId: item.id, error });
      }

      return { itemId: item.id, success };
    })
  );

  const results = await Promise.allSettled(tasks);

  // Count outcomes
  const summary = results.reduce((acc, r) => {
    if (r.status === 'fulfilled') {
      acc[r.value.success ? 'completed' : 'failed']++;
    } else {
      acc.failed++;
    }
    return acc;
  }, { completed: 0, failed: 0 });

  logger.info({ batchId, ...summary }, 'Batch processing complete');
  return summary;
}

// ─── BullMQ Worker ────────────────────────────────────────────────────────────
const worker = new Worker('analysis', async (job) => {
  const { batchId } = job.data;
  logger.info({ batchId, jobId: job.id }, 'Starting batch analysis');

  await query(`UPDATE batches SET status = 'processing' WHERE id = $1`, [batchId]);

  // Load all queued items
  const itemsResult = await query(
    `SELECT * FROM batch_items WHERE batch_id = $1 AND status IN ('queued','uploaded')`,
    [batchId]
  );
  const items = itemsResult.rows;

  if (!items.length) {
    logger.warn({ batchId }, 'No items to process');
    await query(
      `UPDATE batches SET status = 'completed', completed_at = now() WHERE id = $1`,
      [batchId]
    );
    return;
  }

  await processBatch(batchId, items);

  // Mark batch completed (even if some items failed)
  await query(
    `UPDATE batches SET status = 'completed', completed_at = now() WHERE id = $1`,
    [batchId]
  );

  // Trigger theme aggregation as a background job
  await themeAggQueue.add('aggregate-themes', { batchId }, {
    jobId: `theme-agg-${batchId}`,
    attempts: 3,
  });

  logger.info({ batchId }, 'Batch completed — theme aggregation job enqueued');
}, {
  connection: redisConnection,
  concurrency: 5,         // 5 batches can be processed concurrently
  limiter: { max: 10, duration: 1000 },
});

worker.on('completed', (job) => {
  logger.info({ jobId: job.id, batchId: job.data.batchId }, 'Analysis job completed');
});

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'Analysis job failed');
});

logger.info({ maxConcurrent: MAX_CONCURRENT }, 'Batch orchestrator worker started');
