import 'dotenv/config';
import { Worker } from 'bullmq';
import { redisConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { query } from '../db/index.js';

const INFERENCE_URL = process.env.INFERENCE_SERVICE_URL || 'http://localhost:8000';

// ─── Theme aggregation worker ─────────────────────────────────────────────────
const themeWorker = new Worker('theme-agg', async (job) => {
  const { batchId } = job.data;
  logger.info({ batchId, jobId: job.id }, 'Starting theme aggregation');

  // Load all AnalysisReports for this batch
  const reportsResult = await query(
    `SELECT ar.id, ar.summary, ar.deception_indicators, ar.confidence_score, bi.id as batch_item_id
     FROM analysis_reports ar
     JOIN batch_items bi ON ar.batch_item_id = bi.id
     WHERE bi.batch_id = $1 AND bi.status = 'completed'`,
    [batchId]
  );

  const reports = reportsResult.rows;
  if (!reports.length) {
    logger.warn({ batchId }, 'No completed reports to aggregate themes from');
    return;
  }

  // Call inference service theme aggregation endpoint
  const response = await fetch(`${INFERENCE_URL}/themes/aggregate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batch_id: batchId, reports }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Theme aggregation failed: ${response.status} ${errText}`);
  }

  const themeReport = await response.json();

  // Store ThemeReport
  const insertResult = await query(
    `INSERT INTO theme_reports (batch_id, theme_count, themes, model_name)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      batchId,
      themeReport.themes.length,
      JSON.stringify(themeReport.themes),
      themeReport.model_name || 'mistral-small-3.2',
    ]
  );

  const themeReportId = insertResult.rows[0].id;

  // Link theme report back to batch
  await query(
    `UPDATE batches SET theme_report_id = $1 WHERE id = $2`,
    [themeReportId, batchId]
  );

  // Report usage to Stripe
  const subResult = await query(
    `SELECT s.stripe_item_id, b.item_count FROM subscriptions s
     JOIN batches b ON b.user_id = s.user_id
     WHERE b.id = $1 AND s.status = 'active'`,
    [batchId]
  );

  if (subResult.rows.length) {
    const { stripe_item_id, item_count } = subResult.rows[0];
    try {
      const usageRes = await fetch(`${INFERENCE_URL}/report-usage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription_item_id: stripe_item_id, item_count, batch_id: batchId }),
      });
      if (usageRes.ok) {
        await query(
          `UPDATE batches SET payment_status = 'usage_reported' WHERE id = $1`,
          [batchId]
        );
      }
    } catch (err) {
      // Non-fatal — log and continue; usage report can be retried
      logger.error({ err: err.message, batchId }, 'Stripe usage report failed');
    }
  }

  logger.info({ batchId, themeCount: themeReport.themes.length }, 'Theme aggregation complete');
}, {
  connection: redisConnection,
  concurrency: 3,
});

// ─── Stripe event processor worker ───────────────────────────────────────────
const stripeWorker = new Worker('stripe-events', async (job) => {
  const { eventId, eventType } = job.data;
  logger.info({ eventId, eventType }, 'Processing Stripe event');

  // Fetch the stored event payload
  const eventResult = await query(
    `SELECT payload FROM payment_events WHERE stripe_event_id = $1`,
    [eventId]
  );
  if (!eventResult.rows.length) {
    throw new Error(`Payment event not found: ${eventId}`);
  }
  const event = eventResult.rows[0].payload;

  try {
    switch (eventType) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data?.object;
        if (!sub) break;
        await query(
          `UPDATE subscriptions
           SET status = $1, current_period_end = to_timestamp($2), updated_at = now()
           WHERE stripe_subscription_id = $3`,
          [sub.status, sub.current_period_end, sub.id]
        );
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data?.object;
        if (!sub) break;
        await query(
          `UPDATE subscriptions SET status = 'canceled', updated_at = now()
           WHERE stripe_subscription_id = $1`,
          [sub.id]
        );
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data?.object;
        if (!invoice) break;
        // Mark all batches for this customer as settled
        await query(
          `UPDATE batches b SET payment_status = 'settled'
           FROM subscriptions s
           WHERE b.user_id = s.user_id
             AND s.stripe_customer_id = $1
             AND b.payment_status = 'usage_reported'`,
          [invoice.customer]
        );
        logger.info({ customerId: invoice.customer }, 'Invoice payment succeeded — batches settled');
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data?.object;
        if (!invoice) break;
        // Update subscription status  
        await query(
          `UPDATE subscriptions SET status = 'past_due', updated_at = now()
           WHERE stripe_customer_id = $1`,
          [invoice.customer]
        );
        logger.warn({ customerId: invoice.customer }, 'Invoice payment failed — subscription past_due');
        // TODO: Send notification to user (email/webhook)
        break;
      }

      default:
        logger.debug({ eventType }, 'Unhandled Stripe event — ignoring');
    }

    // Mark event as processed
    await query(
      `UPDATE payment_events SET status = 'processed', processed_at = now() WHERE stripe_event_id = $1`,
      [eventId]
    );
  } catch (err) {
    await query(
      `UPDATE payment_events SET status = 'failed' WHERE stripe_event_id = $1`,
      [eventId]
    );
    throw err; // BullMQ will retry
  }
}, {
  connection: redisConnection,
  concurrency: 10,
});

stripeWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'Stripe event processing failed');
});
themeWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'Theme aggregation failed');
});

logger.info('Stripe event processor + theme aggregation workers started');
