/**
 * Load test — 100-item batch submission.
 * Run: node scripts/load-test.js
 *
 * Tests: batch creation, item upload, SSE stream polling, completion.
 * Reports: TTFR (time to first result), total throughput.
 */
import { randomUUID } from 'node:crypto';

const API_URL = process.env.API_URL || 'http://localhost:3000';
const USER_ID = process.env.TEST_USER_ID || randomUUID();
const ITEM_COUNT = parseInt(process.env.ITEM_COUNT || '100', 10);
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes

const SAMPLE_TEXTS = [
  "I was at home all evening. I never left the house.",
  "The contract was signed on the 15th, not the 22nd as claimed.",
  "I don't recall exactly when the meeting took place, but I know I was there.",
  "The funds were transferred immediately — within minutes of the approval.",
  "We've always complied with all regulations. There are no violations.",
];

async function createBatch() {
  const res = await fetch(`${API_URL}/api/v1/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: USER_ID, item_count: ITEM_COUNT }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create batch: ${res.status} ${body}`);
  }
  return res.json();
}

async function uploadItems(batchId, count) {
  const items = Array.from({ length: count }, (_, i) => ({
    source_type: 'text',
    raw_text: SAMPLE_TEXTS[i % SAMPLE_TEXTS.length] + ` [Item ${i + 1}]`,
  }));

  const res = await fetch(`${API_URL}/api/v1/batches/${batchId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(items),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to upload items: ${res.status} ${body}`);
  }
  return res.json();
}

async function pollBatchStatus(batchId) {
  const start = Date.now();
  let firstResultAt = null;

  while (Date.now() - start < MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(`${API_URL}/api/v1/batches/${batchId}`);
    if (!res.ok) continue;
    const { batch, items } = await res.json();

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const completed = items.filter(i => i.status === 'completed').length;
    const failed = items.filter(i => i.status === 'failed').length;
    const processing = items.filter(i => i.status === 'processing').length;

    if (!firstResultAt && completed > 0) {
      firstResultAt = Date.now() - start;
    }

    console.log(`[${elapsed}s] Status=${batch.status} | ✓${completed} ✗${failed} ⟳${processing}`);

    if (['completed', 'failed'].includes(batch.status)) {
      return {
        finalStatus: batch.status,
        completed,
        failed,
        elapsedMs: Date.now() - start,
        timeToFirstResultMs: firstResultAt,
      };
    }
  }
  throw new Error(`Batch did not complete within ${MAX_WAIT_MS / 1000}s`);
}

async function main() {
  console.log(`\n🚀 Deception Analysis Load Test`);
  console.log(`   API: ${API_URL}`);
  console.log(`   Item count: ${ITEM_COUNT}`);
  console.log(`   User ID: ${USER_ID}\n`);

  console.log('Creating batch...');
  const batch = await createBatch();
  console.log(`✓ Batch created: ${batch.id}\n`);

  console.log(`Uploading ${ITEM_COUNT} items...`);
  const uploadStart = Date.now();
  await uploadItems(batch.id, ITEM_COUNT);
  console.log(`✓ Items uploaded in ${Date.now() - uploadStart}ms\n`);

  console.log('Polling batch status...\n');
  const summary = await pollBatchStatus(batch.id);

  console.log('\n📊 Results:');
  console.log(`   Final status:       ${summary.finalStatus}`);
  console.log(`   Completed items:    ${summary.completed} / ${ITEM_COUNT}`);
  console.log(`   Failed items:       ${summary.failed}`);
  console.log(`   Total time:         ${(summary.elapsedMs / 1000).toFixed(1)}s`);
  if (summary.timeToFirstResultMs !== null) {
    console.log(`   Time to first result: ${(summary.timeToFirstResultMs / 1000).toFixed(1)}s`);
  }

  // PRD target: time to first result < 30s
  const ttfrTarget = 30_000;
  if (summary.timeToFirstResultMs > ttfrTarget) {
    console.log(`\n⚠️  TTFR ${(summary.timeToFirstResultMs/1000).toFixed(1)}s exceeds 30s target`);
  } else {
    console.log(`\n✅ TTFR within 30s target`);
  }
}

main().catch(err => {
  console.error('Load test failed:', err.message);
  process.exit(1);
});
