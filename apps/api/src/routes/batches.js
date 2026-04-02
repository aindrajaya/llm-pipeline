import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { query } from '../db/index.js';
import { analysisQueue } from '../lib/queues.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/dap-uploads';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const ALLOWED_MIME = new Set([
  'text/plain', 'text/csv',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/webm',
]);

async function ensureUploadDir() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

/**
 * @param {import('fastify').FastifyInstance} app
 */
export async function batchRoutes(app) {
  // ─── POST /api/v1/batches ─────────────────────────────────────────────────
  // Create a new batch session
  app.post('/batches', {
    schema: {
      body: {
        type: 'object',
        required: ['user_id'],
        properties: {
          user_id: { type: 'string', format: 'uuid' },
          item_count: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    },
  }, async (req, reply) => {
    const { user_id, item_count = 1 } = req.body;

    // Verify subscription is active
    const sub = await query(
      `SELECT id, status FROM subscriptions WHERE user_id = $1 AND status = 'active' LIMIT 1`,
      [user_id]
    );
    if (!sub.rows.length) {
      return reply.status(402).send({ error: 'No active subscription. Please subscribe first.' });
    }

    const result = await query(
      `INSERT INTO batches (user_id, item_count) VALUES ($1, $2) RETURNING *`,
      [user_id, item_count]
    );
    reply.status(201).send(result.rows[0]);
  });

  // ─── POST /api/v1/batches/:id/items ──────────────────────────────────────
  // Upload items (multipart files or JSON text blobs)
  app.post('/batches/:id/items', async (req, reply) => {
    const batchId = req.params.id;

    // Fetch batch and validate
    const batchResult = await query(
      `SELECT id, status, item_count FROM batches WHERE id = $1`,
      [batchId]
    );
    if (!batchResult.rows.length) {
      return reply.status(404).send({ error: 'Batch not found' });
    }
    const batch = batchResult.rows[0];
    if (!['created', 'queued'].includes(batch.status)) {
      return reply.status(409).send({ error: `Cannot add items to batch in status: ${batch.status}` });
    }

    // Count existing items
    const countResult = await query(
      `SELECT COUNT(*) FROM batch_items WHERE batch_id = $1`,
      [batchId]
    );
    const existingCount = parseInt(countResult.rows[0].count, 10);

    const items = [];

    // Handle multipart upload
    if (req.isMultipart()) {
      await ensureUploadDir();
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          if (existingCount + items.length >= 100) {
            return reply.status(400).send({ error: 'Batch limit of 100 items exceeded' });
          }
          if (!ALLOWED_MIME.has(part.mimetype)) {
            return reply.status(400).send({ error: `Unsupported MIME type: ${part.mimetype}` });
          }
          // Randomized filename to prevent traversal
          const ext = path.extname(part.filename || '') || '';
          const safeFileName = `${randomUUID()}${ext}`;
          const filePath = path.join(UPLOAD_DIR, safeFileName);

          let fileSize = 0;
          const chunks = [];
          for await (const chunk of part.file) {
            fileSize += chunk.length;
            if (fileSize > MAX_FILE_SIZE) {
              return reply.status(400).send({ error: 'File exceeds 50 MB limit' });
            }
            chunks.push(chunk);
          }
          await fs.writeFile(filePath, Buffer.concat(chunks));

          const sourceType = part.mimetype.startsWith('audio/') ? 'audio' : 'document';
          items.push({ sourceType, fileUrl: filePath, fileName: part.filename, fileSize, mimeType: part.mimetype });
        }
      }
    } else {
      // JSON body — text blobs
      const body = req.body;
      const blobs = Array.isArray(body) ? body : [body];
      if (existingCount + blobs.length > 100) {
        return reply.status(400).send({ error: 'Batch limit of 100 items exceeded' });
      }
      for (const blob of blobs) {
        if (!blob.raw_text && !blob.source_type) {
          return reply.status(400).send({ error: 'Each item requires raw_text and source_type' });
        }
        items.push({ sourceType: blob.source_type || 'text', rawText: blob.raw_text });
      }
    }

    // Insert items into DB
    const insertedItems = [];
    for (const item of items) {
      const res = await query(
        `INSERT INTO batch_items (batch_id, source_type, file_url, raw_text, file_name, file_size, mime_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued') RETURNING *`,
        [batchId, item.sourceType, item.fileUrl || null, item.rawText || null,
         item.fileName || null, item.fileSize || null, item.mimeType || null]
      );
      insertedItems.push(res.rows[0]);
    }

    // Update batch status and enqueue analysis job
    await query(`UPDATE batches SET status = 'queued' WHERE id = $1`, [batchId]);
    await analysisQueue.add('analyze-batch', { batchId }, {
      jobId: `batch-${batchId}`,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 50,
    });

    reply.status(201).send({ batchId, items: insertedItems });
  });

  // ─── GET /api/v1/batches/:id ──────────────────────────────────────────────
  app.get('/batches/:id', async (req, reply) => {
    const { id } = req.params;
    const batchResult = await query(`SELECT * FROM batches WHERE id = $1`, [id]);
    if (!batchResult.rows.length) return reply.status(404).send({ error: 'Batch not found' });

    const itemsResult = await query(
      `SELECT id, source_type, status, retry_count, error_message, started_at, completed_at, file_name
       FROM batch_items WHERE batch_id = $1 ORDER BY created_at`,
      [id]
    );

    reply.send({ batch: batchResult.rows[0], items: itemsResult.rows });
  });

  // ─── GET /api/v1/batches/:id/reports ─────────────────────────────────────
  app.get('/batches/:id/reports', async (req, reply) => {
    const { id } = req.params;
    const result = await query(
      `SELECT ar.* FROM analysis_reports ar
       JOIN batch_items bi ON ar.batch_item_id = bi.id
       WHERE bi.batch_id = $1
       ORDER BY ar.created_at`,
      [id]
    );
    reply.send({ reports: result.rows });
  });

  // ─── GET /api/v1/batches/:id/theme-report ────────────────────────────────
  app.get('/batches/:id/theme-report', async (req, reply) => {
    const { id } = req.params;
    const result = await query(
      `SELECT tr.* FROM theme_reports tr WHERE tr.batch_id = $1`,
      [id]
    );
    if (!result.rows.length) {
      return reply.status(202).send({ message: 'Theme report not yet available' });
    }
    reply.send(result.rows[0]);
  });

  // ─── GET /api/v1/batches/:id/stream — SSE real-time progress ─────────────
  app.get('/batches/:id/stream', async (req, reply) => {
    const { id } = req.params;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendEvent = (data) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Poll every 2 seconds, stream updates
    const POLL_INTERVAL = 2000;
    let closed = false;
    req.raw.on('close', () => { closed = true; });

    const poll = async () => {
      while (!closed) {
        try {
          const batchRes = await query(`SELECT status, item_count FROM batches WHERE id = $1`, [id]);
          if (!batchRes.rows.length) {
            sendEvent({ type: 'error', message: 'Batch not found' });
            break;
          }
          const batch = batchRes.rows[0];
          const itemsRes = await query(
            `SELECT id, status, error_message FROM batch_items WHERE batch_id = $1`,
            [id]
          );
          const stats = itemsRes.rows.reduce((acc, item) => {
            acc[item.status] = (acc[item.status] || 0) + 1;
            return acc;
          }, {});

          sendEvent({ type: 'progress', batchId: id, batchStatus: batch.status, stats, items: itemsRes.rows });

          if (['completed', 'failed'].includes(batch.status)) {
            sendEvent({ type: 'done', batchStatus: batch.status });
            break;
          }
        } catch (err) {
          sendEvent({ type: 'error', message: err.message });
          break;
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
      }
      reply.raw.end();
    };

    poll();
  });
}
