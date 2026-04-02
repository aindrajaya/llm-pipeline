import { Queue } from 'bullmq';
import { redisConnection } from './redis.js';

/** Queue for analysis jobs — consumed by batch-orchestrator worker */
export const analysisQueue = new Queue('analysis', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

/** Queue for theme aggregation — triggered after all batch items complete */
export const themeAggQueue = new Queue('theme-agg', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  },
});

/** Queue for Stripe webhook event processing */
export const stripeEventQueue = new Queue('stripe-events', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  },
});

/** Dead-letter queue for items exhausting all retries */
export const deadLetterQueue = new Queue('dead-letter', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: false,
    removeOnFail: false,
  },
});
