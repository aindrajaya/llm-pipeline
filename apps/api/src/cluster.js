/**
 * cluster.js — Production entry point.
 * Forks one worker per CPU core. Respawns crashed workers.
 * In dev, use `node src/server.js` directly (or npm run dev).
 */
import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { logger } from './lib/logger.js';

if (cluster.isPrimary) {
  const cpuCount = availableParallelism();
  logger.info({ cpuCount }, 'Starting cluster — forking workers');

  for (let i = 0; i < cpuCount; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    logger.warn(
      { pid: worker.process.pid, code, signal },
      'Worker died — respawning'
    );
    cluster.fork();
  });

  cluster.on('online', (worker) => {
    logger.info({ pid: worker.process.pid }, 'Worker online');
  });
} else {
  // Each worker runs the Fastify server
  await import('./server.js');
}
