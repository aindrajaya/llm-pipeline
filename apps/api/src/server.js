import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { collectDefaultMetrics, Registry, Counter, Histogram } from 'prom-client';
import { batchRoutes } from './routes/batches.js';
import { billingRoutes } from './routes/billing.js';
import { logger } from './lib/logger.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    ...(process.env.NODE_ENV !== 'production' && {
      transport: { target: 'pino-pretty', options: { colorize: true } },
    }),
  },
  requestIdHeader: 'x-request-id',
  trustProxy: true,
});

// ─── Prometheus metrics ──────────────────────────────────────────────────────
const register = new Registry();
collectDefaultMetrics({ register });

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

export const batchJobsTotal = new Counter({
  name: 'batch_jobs_total',
  help: 'Total batch jobs created',
  labelNames: ['status'],
  registers: [register],
});

// ─── Plugins ────────────────────────────────────────────────────────────────
await app.register(cors, {
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
});

await app.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB per file
    files: 100,
  },
});

await app.register(rateLimit, {
  max: 200,
  timeWindow: '1 minute',
});

// ─── Request timing hook ─────────────────────────────────────────────────────
app.addHook('onResponse', (req, reply, done) => {
  httpRequestDuration.labels(
    req.method,
    req.routeOptions?.url || req.url,
    reply.statusCode.toString()
  ).observe(reply.elapsedTime / 1000);
  done();
});

// ─── Routes ──────────────────────────────────────────────────────────────────
await app.register(batchRoutes, { prefix: '/api/v1' });
await app.register(billingRoutes, { prefix: '' });

// Health check
app.get('/health', async () => ({
  status: 'ok',
  pid: process.pid,
  uptime: process.uptime(),
  timestamp: new Date().toISOString(),
}));

// Prometheus metrics endpoint
app.get('/metrics', async (req, reply) => {
  reply.type(register.contentType);
  return register.metrics();
});

// ─── 404 / Error handlers ────────────────────────────────────────────────────
app.setNotFoundHandler((req, reply) => {
  reply.status(404).send({ error: 'Not Found', path: req.url });
});

app.setErrorHandler((err, req, reply) => {
  app.log.error({ err, url: req.url }, 'Unhandled error');
  const status = err.statusCode || 500;
  reply.status(status).send({
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
try {
  await app.listen({ port: PORT, host: HOST });
  logger.info({ port: PORT, pid: process.pid }, 'API server started');
} catch (err) {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
}

export default app;
