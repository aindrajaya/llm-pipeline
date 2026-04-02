import IORedis from 'ioredis';
import { logger } from './logger.js';

export const redisConnection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,  // Required by BullMQ
  enableReadyCheck: false,
  lazyConnect: true,
});

redisConnection.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});

redisConnection.on('connect', () => {
  logger.info('Redis connected');
});
