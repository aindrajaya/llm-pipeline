# PRD: Deception Analysis Platform — Rebuild v2

**Document Type:** Product Requirements Document  
**Status:** Draft — For Development Review  
**Target IDE:** Antigravity  
**Author:** Arista Indrajaya  
**Version:** 1.0.0  
**Date:** April 2026

---

## Executive Summary

Deception Analysis Platform v2 is a full-stack rebuild of an existing application that analyzes uploaded content (text documents and audio files) for themes of deception using large language model inference. The primary goals are to replace the Mistral 7B inference backend with Mistral Small 3.2, scale batch processing from 50 to 100 items per session, replace legacy text and audio analysis models with client-provided repository models, properly integrate end-to-end Stripe usage-based billing, and optimize GPU-driven inference for production throughput. The rebuild preserves the existing frontend as much as possible and introduces a clean service boundary between the web API layer, batch orchestration, and AI inference runtime.

---

## 1. Background & Problem Statement

The current application suffers from the following production-grade gaps:

- **Outdated inference model.** Mistral 7B is used for deception and theme analysis. Mistral Small 3.2 offers improved quality and instruction-following for this task with better throughput characteristics at smaller VRAM footprint.
- **Batch capacity bottleneck.** The system supports only 50 items per batch. Customer demand requires 100 items.
- **Legacy analysis models.** The text and audio analysis pipelines use models that must be replaced with a client-supplied repository, creating a hard migration dependency.
- **Broken payment integration.** Stripe is connected but not functioning reliably end-to-end — webhook processing, entitlement updates, and idempotency are unverified.
- **Underutilized GPU resources.** Inference is not fully leveraging GPU batching, quantization, or continuous batching strategies, resulting in underutilized hardware and degraded throughput under load.

This PRD defines the requirements, architecture, and acceptance criteria for a production-grade rebuild addressing all of the above.

---

## 2. Goals

| Goal | Success Metric |
|------|---------------|
| Replace Mistral 7B with Mistral Small 3.2 | Inference routes through Mistral Small 3.2 exclusively |
| Scale batch capacity to 100 items | 100 items submitted, processed, and reported without errors |
| Deceptive theme analysis: max 50 themes | Aggregate report produced after batch completion with ≤50 themes |
| Replace text analysis model | New model from client repo in production inference path |
| Replace audio analysis model | New model from client repo in production inference path |
| GPU optimization | Measurable improvement in throughput and latency vs. baseline |
| Stripe API usage billing end-to-end | Checkout → webhook → entitlement → usage report fully verified |

---

## 3. Non-Goals

- Full redesign of the existing frontend UI
- Training or fine-tuning any model from scratch
- Building a new multi-tenant SaaS product (single-tenant rebuild only)
- Migrating to a fully distributed microservices architecture on day one

---

## 4. Users & Stakeholders

| Role | Needs |
|------|-------|
| End user | Upload 1–100 items, receive per-item deception reports and one aggregate theme report |
| Admin / Ops | Monitor batch status, failed items, retries, GPU utilization, payment logs |
| Business owner | Receive payment via Stripe usage billing; track per-batch API consumption |
| Developer | Clear service boundaries, reproducible local dev environment, documented APIs |

---

## 5. Functional Requirements

### 5.1 Upload & Batch Processing

- The system MUST accept up to 100 items (files or text blobs) per batch session.
- The system MUST validate item type (`text`, `document`, `audio`), file size limits, and total item count before enqueuing.
- Each item MUST track status independently: `uploaded → queued → processing → completed → failed`.
- A failed item MUST NOT fail the entire batch. Retry logic is per-item, not per-batch.
- The frontend MUST display per-item status and a batch-level progress summary in real time using either polling or WebSocket/SSE.
- The system MUST enforce a configurable concurrency ceiling on active inference jobs (default: 20 concurrent slots across a batch of 100).

**Node.js async pattern:** The batch orchestration layer uses `async/await` with `Promise.allSettled` for fan-out across items, ensuring that rejected items are isolated and never block sibling items from completing. `AbortController` is used to enforce per-item inference timeouts.

```javascript
// Batch fan-out pattern — Node.js orchestration layer
async function processBatch(items, maxConcurrent = 20) {
  const semaphore = new Semaphore(maxConcurrent);
  const tasks = items.map(item =>
    semaphore.run(() => analyzeItem(item))
  );
  const results = await Promise.allSettled(tasks);
  return results.map((r, i) => ({
    itemId: items[i].id,
    status: r.status,
    value: r.status === 'fulfilled' ? r.value : null,
    error: r.status === 'rejected' ? r.reason?.message : null,
  }));
}
```

### 5.2 Text Analysis Pipeline

- The existing text analysis model MUST be replaced with the model provided in the client GitHub repository.
- The pipeline MUST support standard preprocessing → inference → structured output per item.
- Output per item MUST include: `summary`, `deception_indicators[]`, `confidence_score`, `raw_output`.
- The pipeline MUST expose a typed contract (TypeScript interface or Pydantic schema) so downstream theme aggregation can consume outputs reliably.

### 5.3 Audio Analysis Pipeline

- The existing audio analysis model MUST be replaced with the model from the client GitHub repository.
- If the client repo model is transcription-based, the pipeline order is: `audio ingestion → preprocessing → transcription/feature extraction → text-form deception inference`.
- The audio pipeline MUST reuse the same batch queue and job orchestration as the text pipeline. No separate retry or monitoring logic.
- Output schema MUST match the text analysis output contract.

### 5.4 Deceptive Theme Analysis

- After all items in a batch reach terminal status (`completed` or `failed`), the system triggers a **deceptive theme aggregation** job.
- Aggregation analyzes the generated `AnalysisReport` records across all items, identifies recurring language patterns, common deception indicators, and cross-item thematic clusters.
- Output is a `ThemeReport` capped at **50 themes maximum**, sorted by `confidence DESC, frequency DESC`.
- Each theme MUST include:
  - `theme_id` (UUID)
  - `theme_title` (string, ≤100 chars)
  - `description` (string)
  - `confidence` (float 0–1)
  - `frequency` (int — how many items this theme appears in)
  - `supporting_items` (array of `batch_item_id`)
  - `example_snippets` (array of strings, ≤3 per theme)
- The theme aggregation MUST be run as a background job, not blocking the web response.
- Theme aggregation uses Mistral Small 3.2 with a dedicated system prompt optimized for clustering deception language patterns.

### 5.5 Payments — Stripe Usage-Based Billing

The Stripe integration models **API usage billing**: users are charged per batch processed, based on item count consumed.

#### 5.5.1 Billing Model

- Product: `Deception Analysis API`
- Pricing: Metered / usage-based per item analyzed (e.g., $0.10 per item)
- Stripe objects used:
  - `Product` → the analysis service
  - `Price` (with `billing_scheme: per_unit`, `usage_type: metered`) → per-item charge
  - `Subscription` → customer subscribes to the metered plan
  - `SubscriptionItem` → tied to the metered `Price`
  - `UsageRecord` → reported after each batch completes

#### 5.5.2 Flow

```
User creates account
  → Stripe Customer created (store customer_id)
  → Stripe Subscription created (store subscription_id, subscription_item_id)
  → Status: active

User submits batch (N items)
  → Pre-flight check: subscription status === 'active'
  → Batch created in DB with payment_status = 'pending_usage_report'
  → Items processed

Batch completes
  → stripe.subscriptionItems.createUsageRecord(subscription_item_id, {
      quantity: N,
      timestamp: Math.floor(Date.now() / 1000),
      action: 'increment'
    })
  → payment_status updated to 'usage_reported'

Stripe invoices at billing period end
  → Webhook: invoice.payment_succeeded → mark customer billing as settled
  → Webhook: invoice.payment_failed → notify user, restrict new batches
```

#### 5.5.3 Webhook Requirements

All webhooks MUST be:
- **Verified** using `stripe.webhooks.constructEvent(payload, sig, process.env.STRIPE_WEBHOOK_SECRET)`.
- **Idempotent**: processed using `stripe_event_id` as deduplication key in `PaymentEvent` table. If the same `stripe_event_id` is received twice, it MUST be acknowledged (HTTP 200) but not reprocessed.
- **Non-blocking**: webhook handler enqueues a job; it does NOT perform DB writes or downstream calls inline before responding to Stripe.
- Webhook response MUST return HTTP 200 within **2 seconds**.

#### 5.5.4 Required Webhook Events

| Event | Action |
|-------|--------|
| `customer.subscription.created` | Store subscription details |
| `customer.subscription.updated` | Update status (e.g., `past_due`, `active`) |
| `customer.subscription.deleted` | Revoke access, block new batches |
| `invoice.payment_succeeded` | Mark billing period settled |
| `invoice.payment_failed` | Flag account, send notification |

#### 5.5.5 Node.js Stripe Integration Pattern

```javascript
// stripe-webhook.js
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency check
  const existing = await PaymentEvent.findOne({ stripe_event_id: event.id });
  if (existing) return res.json({ received: true, duplicate: true });

  // Persist before processing
  await PaymentEvent.create({ stripe_event_id: event.id, status: 'received', payload: event });

  // Enqueue — do NOT process inline
  await jobQueue.add('stripe-event', { eventId: event.id, eventType: event.type });

  res.json({ received: true });
}
```

---

## 6. Non-Functional Requirements

### 6.1 Performance

| Metric | Target |
|--------|--------|
| Batch of 100 items — time to first result | < 30 seconds |
| Single item inference latency (p95) | < 10 seconds |
| Theme aggregation job — completion time | < 60 seconds after all items done |
| Stripe webhook response time | < 2 seconds |
| API endpoint response time (p95, non-inference) | < 200ms |

**GPU performance model:** Production inference MUST use continuous batching (iteration-level scheduling) via vLLM or equivalent. At small batch sizes, the GPU is memory-bandwidth-bound; at larger batch sizes, it becomes compute-bound. Continuous batching eliminates padding waste by evicting completed sequences and immediately pulling in new requests, keeping GPU slots saturated without waiting for the longest sequence to finish.

**Adaptive batch delay:** For dynamic batching, the system MAY use a batch accumulation delay of 2–10ms tuned to the p99 latency SLO. At low request rates, delay drops to ~0ms. At peak load, delay rises to maximize GPU arithmetic intensity. This delay MUST never exceed the configured inference timeout.

**Quantization:** Mistral Small 3.2 SHOULD be deployed with AWQ or GPTQ 4-bit quantization if benchmark results show accuracy degradation < 2% versus FP16 baseline. Quantization reduces the model's VRAM footprint, enabling larger effective batch sizes and better GPU utilization.

### 6.2 Reliability

- Failed items MUST NOT fail the batch — isolated retry policy per item (max 2 retries with exponential backoff).
- All inference jobs MUST have an explicit timeout (default: 30s per item). On timeout, item is marked `failed` with reason `inference_timeout`.
- Dead-letter queue for items exhausting retries — operator is alerted.
- Webhook processing failures MUST be retried up to 5 times with exponential backoff before dead-lettering.
- The web API layer MUST NOT block on inference jobs — all inference is asynchronous.

### 6.3 Scalability

Architecture follows the **Scale Cube** progression:

1. **X-axis (clone):** Web/API tier is stateless and horizontally scalable via process clustering (`node:cluster` or PM2 cluster mode). This is the first scaling axis and requires no architectural change beyond ensuring stateless handlers.
2. **Y-axis (decompose):** Inference service (`Python FastAPI + vLLM`) is a separate process/container from the web API (`Node.js`). Scaling the inference tier does not require scaling the web tier. Batch worker processes are a third separately scalable unit.
3. **Z-axis (data partitioning):** If batch volume requires it in future, batches can be sharded by `customer_id` to dedicated worker pools.

**Node.js process model:** The main API server MUST run in cluster mode, forking one worker per CPU core. CPU-heavy operations (audio preprocessing, synchronous file parsing) MUST be delegated to `worker_threads` or a worker pool to avoid blocking the event loop. The event loop MUST remain free for I/O — it is NOT a compute thread.

```javascript
// cluster.js — primary entry point
import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';

if (cluster.isPrimary) {
  const cpuCount = availableParallelism();
  for (let i = 0; i < cpuCount; i++) cluster.fork();
  cluster.on('exit', (worker) => {
    console.warn(`Worker ${worker.process.pid} died — respawning`);
    cluster.fork();
  });
} else {
  await import('./server.js'); // each worker runs the Express/Fastify server
}
```

### 6.4 Security

- All file uploads MUST be validated for MIME type, magic bytes, and file size before enqueuing.
- Stripe webhook endpoint MUST reject any request without a valid `stripe-signature` header (HTTP 400).
- Model weights and client repository credentials MUST be injected via environment variables / secrets manager — never hardcoded.
- Uploaded files MUST be stored with randomized, non-guessable filenames. No directory traversal.
- PII in uploaded content is subject to the client's data retention policy — the PRD does not prescribe retention duration but the system MUST support configurable TTL-based deletion.

### 6.5 Observability

| Signal | Tool | Key Metrics |
|--------|------|-------------|
| Structured logs | Pino (Node.js) | Request ID, batch ID, item ID, model name, latency |
| Metrics | Prometheus + DCGM Exporter | GPU SM utilization, GPU memory, queue depth, inference latency p50/p95/p99 |
| Dashboards | Grafana | Batch throughput, failed items, GPU utilization, TTFT, TPOT |
| Tracing | OpenTelemetry | End-to-end batch trace from upload to report |
| Alerting | Alertmanager | GPU SM util < 40% for >5min, queue depth > 500, p99 inference > 30s |

**Production inference KPIs to track continuously:**
- **TTFT** (Time to First Token): perceived latency for streaming responses
- **TPOT** (Time Per Output Token): streaming throughput; target ≥11 tokens/sec for real-time display
- **GPU SM Utilization**: target >70% under normal load
- **KV Cache Utilization**: monitor for preemption warnings (vLLM) indicating insufficient KV cache space

---

## 7. System Architecture

### 7.1 Service Map

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CLIENT BROWSER                             │
│   React SPA (existing frontend, maximally reused)                  │
└────────────────────────────┬────────────────────────────────────────┘
                             │ HTTPS
┌────────────────────────────▼────────────────────────────────────────┐
│                    API GATEWAY / BFF (Node.js)                      │
│  - Auth middleware                                                  │
│  - Upload session creation                                          │
│  - Batch CRUD endpoints                                             │
│  - Stripe checkout + subscription management                        │
│  - Webhook receiver (Stripe)                                        │
│  - SSE / WebSocket for real-time batch status                       │
│  Runs in cluster mode (1 worker per CPU core)                       │
└──────────┬───────────────────────────────────┬──────────────────────┘
           │ Enqueue jobs                      │ Read results
┌──────────▼──────────┐             ┌──────────▼──────────────────────┐
│  BATCH ORCHESTRATOR │             │  POSTGRESQL DATABASE             │
│  (Node.js workers)  │             │  Batch, BatchItem,              │
│  - BullMQ / Redis   │             │  AnalysisReport, ThemeReport,   │
│  - Semaphore pool   │             │  PaymentEvent, Customer,        │
│  - Per-item retry   │             │  Subscription                   │
│  - Timeout enforcer │             └─────────────────────────────────┘
└──────────┬──────────┘
           │ HTTP / gRPC
┌──────────▼────────────────────────────────────────────────────────────┐
│                    INFERENCE SERVICE (Python FastAPI)                  │
│  ┌─────────────────────┐  ┌──────────────────┐  ┌──────────────────┐ │
│  │  Text Analysis      │  │  Audio Analysis  │  │  Theme Aggreg.  │ │
│  │  (Client repo model)│  │  (Client repo    │  │  (Mistral Small │ │
│  │  + Mistral Small 3.2│  │  model + Mistral │  │  3.2 via vLLM)  │ │
│  │  for deception score│  │  Small 3.2)      │  │                 │ │
│  └─────────────────────┘  └──────────────────┘  └──────────────────┘ │
│                                                                        │
│  Runtime: vLLM (continuous batching, PagedAttention)                  │
│  Quantization: AWQ 4-bit (validated against FP16 baseline)            │
│  GPU: NVIDIA GPU, CUDA-enabled                                         │
│  Dynamic batch delay: 2–10ms adaptive, SLO-constrained                │
└────────────────────────────────────────────────────────────────────────┘
           │
┌──────────▼──────────┐
│   REDIS (BullMQ)    │
│   Job queues:       │
│   - analysis        │
│   - theme-agg       │
│   - stripe-events   │
│   - dead-letter     │
└─────────────────────┘
```

### 7.2 Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Frontend | React (existing, reused) | Minimize change, maximize delivery speed |
| API / BFF | Node.js + Fastify | Non-blocking I/O, ideal for orchestration and fan-out; cluster mode for X-axis scaling |
| Batch Orchestrator | Node.js + BullMQ + Redis | Event-driven queue, per-item retry, dead-letter, visibility |
| Inference Runtime | Python FastAPI + vLLM | Purpose-built for LLM serving; continuous batching, PagedAttention, GPU-native |
| LLM | Mistral Small 3.2 | Client requirement; improved over 7B for deception analysis task |
| Database | PostgreSQL | Relational integrity for batch/item/payment relationships |
| Cache / Queue | Redis | BullMQ backing store, session cache, rate limiting |
| Payments | Stripe Node.js SDK | Usage-based metered billing for API consumption |
| GPU | NVIDIA (CUDA) | Required for vLLM inference runtime |
| Monitoring | Prometheus + DCGM + Grafana | GPU-aware autoscaling and observability |
| Containers | Docker + docker-compose | Local dev; production targets Kubernetes |

### 7.3 Async Patterns in Node.js Layer

All async operations in the Node.js API and orchestrator layers follow these conventions:

**Fan-out with isolation:** Use `Promise.allSettled` (not `Promise.all`) for batch item fan-out. `Promise.all` rejects immediately on any failure; `Promise.allSettled` reports the outcome of every item and is the correct tool for batch operations where partial failure is acceptable.

**Timeout enforcement:** Use `AbortController` + `Promise.race` to enforce inference call timeouts. If the inference service does not respond within the timeout, the item is marked `failed` with a `inference_timeout` reason, and the AbortController cancels the in-flight HTTP request.

```javascript
async function analyzeItemWithTimeout(item, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await callInferenceService(item, { signal: controller.signal });
    return result;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`inference_timeout after ${timeoutMs}ms for item ${item.id}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

**Async iteration for streaming inference:** When consuming streamed token output from the inference service (for real-time frontend display), use `for await...of` on the async iterable response stream. This avoids buffering the full response in memory and allows progressive delivery to the client via SSE.

```javascript
async function* streamInferenceResponse(itemId, signal) {
  const response = await fetch(`${INFERENCE_URL}/analyze/stream`, {
    method: 'POST',
    body: JSON.stringify({ item_id: itemId }),
    signal,
  });
  for await (const chunk of response.body) {
    yield chunk.toString('utf-8');
  }
}
```

**Generator-based paginated resource fetching:** When retrieving large sets of analysis results from the DB for theme aggregation, use async generator functions to paginate in batches, preventing full-table memory allocation.

---

## 8. Data Model

### 8.1 Core Entities

```sql
-- Batch: one per user submission
CREATE TABLE batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'created',   -- created|queued|processing|completed|failed
  item_count    INT NOT NULL CHECK (item_count BETWEEN 1 AND 100),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  payment_status TEXT NOT NULL DEFAULT 'pending',  -- pending|usage_reported|settled|failed
  theme_report_id UUID REFERENCES theme_reports(id)
);

-- BatchItem: one per uploaded file/text
CREATE TABLE batch_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL,    -- text|audio|document
  file_url      TEXT,
  raw_text      TEXT,
  status        TEXT NOT NULL DEFAULT 'uploaded',  -- uploaded|queued|processing|completed|failed
  retry_count   INT NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);

-- AnalysisReport: output per completed item
CREATE TABLE analysis_reports (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_item_id        UUID NOT NULL REFERENCES batch_items(id),
  model_name           TEXT NOT NULL,
  model_version        TEXT NOT NULL,
  summary              TEXT,
  deception_indicators JSONB,   -- array of {indicator, severity, excerpt}
  confidence_score     FLOAT CHECK (confidence_score BETWEEN 0 AND 1),
  raw_output           JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ThemeReport: one aggregate per batch
CREATE TABLE theme_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id         UUID NOT NULL REFERENCES batches(id),
  theme_count      INT NOT NULL,
  themes           JSONB NOT NULL,  -- array of theme objects (max 50)
  model_name       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- PaymentEvent: idempotent Stripe webhook log
CREATE TABLE payment_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id TEXT UNIQUE NOT NULL,   -- deduplication key
  batch_id        UUID REFERENCES batches(id),
  customer_id     TEXT,
  event_type      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'received',  -- received|processed|failed
  payload         JSONB NOT NULL,
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Subscription: Stripe subscription tracking
CREATE TABLE subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id),
  stripe_customer_id   TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  stripe_item_id       TEXT NOT NULL,   -- SubscriptionItem ID for usage reporting
  status               TEXT NOT NULL,   -- active|past_due|canceled|incomplete
  current_period_end   TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 8.2 Theme Object Schema (JSONB)

```json
{
  "theme_id": "uuid",
  "theme_title": "Contradictory Timeline Claims",
  "description": "Items repeatedly use inconsistent temporal references...",
  "confidence": 0.87,
  "frequency": 12,
  "supporting_items": ["batch_item_id_1", "batch_item_id_2"],
  "example_snippets": [
    "...claimed the event occurred in 2019, but later stated 2021...",
    "...timeline shifted when questioned directly..."
  ]
}
```

---

## 9. API Reference

### 9.1 Batch Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/batches` | Create a new batch session, returns `batch_id` |
| `POST` | `/api/v1/batches/:id/items` | Upload and enqueue items (multipart or JSON) |
| `GET`  | `/api/v1/batches/:id` | Get batch status + item statuses |
| `GET`  | `/api/v1/batches/:id/reports` | Get all `AnalysisReport` records for batch |
| `GET`  | `/api/v1/batches/:id/theme-report` | Get `ThemeReport` for batch |
| `GET`  | `/api/v1/batches/:id/stream` | SSE stream for real-time batch progress |

### 9.2 Stripe / Billing Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/billing/subscribe` | Create Stripe customer + subscription; returns `client_secret` |
| `GET`  | `/api/v1/billing/subscription` | Get current subscription status |
| `POST` | `/api/v1/billing/portal` | Generate Stripe Customer Portal URL |
| `POST` | `/webhook/stripe` | Stripe webhook receiver (raw body required) |

### 9.3 Inference Service Internal API (Python FastAPI)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/analyze/text` | Analyze single text item, returns `AnalysisResult` |
| `POST` | `/analyze/audio` | Analyze single audio item, returns `AnalysisResult` |
| `POST` | `/analyze/stream` | Streaming text analysis (SSE-compatible) |
| `POST` | `/themes/aggregate` | Aggregate theme analysis across reports list |
| `GET`  | `/health` | Health + GPU status check |
| `GET`  | `/metrics` | Prometheus metrics endpoint |

---

## 10. GPU Optimization Strategy

### 10.1 Inference Runtime Configuration

The inference service MUST be deployed with vLLM (or equivalent continuous batching runtime) serving Mistral Small 3.2:

```python
# inference/vllm_server.py
from vllm import LLM, SamplingParams

llm = LLM(
    model="mistralai/Mistral-Small-3.2",
    quantization="awq",                  # 4-bit AWQ — reduce VRAM footprint
    gpu_memory_utilization=0.85,         # Leave 15% headroom for KV cache growth
    max_num_seqs=100,                    # Max concurrent sequences (matches 100-item batch)
    max_model_len=8192,                  # Adjust to model's context window
    tensor_parallel_size=1,             # Increase for multi-GPU deployments
    enforce_eager=False,                 # Allow CUDA graph capture for kernel fusion
)

sampling_params = SamplingParams(
    temperature=0.0,   # Deterministic for deception analysis
    max_tokens=2048,
)
```

### 10.2 Batching Strategy

| Strategy | When to Use | Notes |
|----------|------------|-------|
| Static batching | Dev/testing only | High padding waste, GPU underutilization |
| Dynamic batching | Moderate load | Batch-delay timer 2–10ms, SLO-constrained |
| Continuous batching | Production (recommended) | Evict completed seqs, pull new ones — max GPU saturation |

**Continuous batching rationale:** Waiting for the longest sequence in a static batch causes all other slots to pad idly. Continuous batching allows the inference engine to treat the GPU like an OS scheduler, immediately filling vacated sequence slots mid-batch. This is critical when processing 100 heterogeneous items of variable length.

### 10.3 Occupancy and GPU Utilization

- Target GPU SM utilization: **>70%** under production load.
- If SM utilization is consistently < 50%, increase batch size or enable more concurrent sequences.
- If KV cache preemption warnings appear in vLLM logs, increase `gpu_memory_utilization` or reduce `max_model_len`.
- Profile with Nsight Systems periodically to identify compute-bound vs. memory-bound vs. latency-bound regimes and apply the appropriate remedy.

### 10.4 Quantization Validation

Before deploying AWQ:
1. Benchmark FP16 baseline on 100 representative items.
2. Benchmark AWQ 4-bit on the same set.
3. Verify deception score divergence < 2%.
4. Verify confidence score distribution is stable.
5. Only deploy quantized model if accuracy threshold is met.

---

## 11. Stripe Usage Reporting Implementation

```python
# payments/usage_reporter.py
import stripe
import os

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]

async def report_batch_usage(subscription_item_id: str, item_count: int, batch_id: str):
    """
    Called after all batch items reach terminal status.
    Reports consumed item count as metered usage to Stripe.
    """
    try:
        usage_record = stripe.SubscriptionItem.create_usage_record(
            subscription_item_id,
            quantity=item_count,
            timestamp="now",
            action="increment",
            idempotency_key=f"batch-usage-{batch_id}",  # Prevents double-reporting
        )
        return usage_record
    except stripe.error.StripeError as e:
        # Log and enqueue for retry — never swallow silently
        raise BatchUsageReportError(f"Stripe usage report failed: {e.user_message}") from e
```

**Idempotency:** The `idempotency_key` on the usage record uses `batch_id` as the discriminator. Even if the reporting job is retried (network failure, worker restart), Stripe will not double-bill for the same batch.

---

## 12. Repository Structure (for Portfolio / Proposal Repo)

```
deception-analysis-platform-v2/
├── README.md
├── docs/
│   ├── PRD.md                          ← this document
│   ├── architecture.md
│   ├── api-reference.md
│   └── stripe-billing-guide.md
├── apps/
│   ├── web/                            ← React frontend (existing, minimally modified)
│   └── api/                            ← Node.js Fastify API + orchestrator
│       ├── src/
│       │   ├── cluster.js
│       │   ├── routes/
│       │   │   ├── batches.js
│       │   │   └── billing.js
│       │   ├── workers/
│       │   │   ├── batch-orchestrator.js
│       │   │   └── stripe-event-processor.js
│       │   └── lib/
│       │       ├── semaphore.js
│       │       └── abort-timeout.js
│       └── package.json
├── services/
│   └── inference/                      ← Python FastAPI + vLLM
│       ├── main.py
│       ├── vllm_server.py
│       ├── analyzers/
│       │   ├── text_analyzer.py
│       │   └── audio_analyzer.py
│       ├── theme_aggregator.py
│       └── requirements.txt
├── payments/
│   ├── stripe_webhooks.js
│   └── usage_reporter.py
├── infra/
│   ├── docker-compose.yml              ← GPU-enabled dev environment
│   ├── docker-compose.prod.yml
│   └── monitoring/
│       ├── prometheus.yml
│       └── grafana-dashboard.json
└── scripts/
    ├── load-test.js                    ← k6 or autocannon load test script
    └── benchmark-models.py             ← FP16 vs AWQ accuracy benchmark
```

---

## 13. Development Phases

### Phase 1 — Discovery & Audit (Week 1)
- Audit existing frontend: identify reusable components, API contracts to preserve
- Audit existing backend: map current Mistral 7B usage, batch flow, Stripe config
- Review client GitHub repos for text/audio replacement models: dependencies, input/output contracts, hardware requirements
- Establish baseline performance: latency, throughput, GPU utilization
- Set up local dev environment with Docker Compose (GPU-enabled for inference)

### Phase 2 — Core Rebuild (Weeks 2–4)
- Scaffold Node.js API with cluster mode and BullMQ queue
- Implement batch orchestration with `Promise.allSettled` fan-out, semaphore pool, and `AbortController` timeouts
- Integrate vLLM serving Mistral Small 3.2 (AWQ validated)
- Integrate client text analysis model
- Integrate client audio analysis model
- Implement theme aggregation service (max 50 themes)
- Fix Stripe integration: metered billing, webhook handler, idempotent usage reporting
- Extend upload capacity to 100 items

### Phase 3 — GPU Optimization (Week 5)
- Enable continuous batching in vLLM
- Validate AWQ quantization vs. FP16 baseline
- Profile with Nsight Systems: identify compute/memory/latency-bound regimes
- Configure DCGM + Prometheus + Grafana dashboards
- Configure KEDA autoscaling based on GPU utilization metrics
- Load test with 100-item batches; tune semaphore concurrency and batch delay

### Phase 4 — Hardening & Delivery (Week 6)
- User acceptance testing (UAT) end-to-end
- Stripe payment flow end-to-end verification in test mode
- Edge case testing: timeout handling, partial batch failure, duplicate webhook events
- Rolling update configuration for zero-downtime deployment
- Final documentation: API reference, deployment guide, runbook

---

## 14. Acceptance Criteria

| Criterion | Verification Method |
|-----------|---------------------|
| Upload 100 items without UX degradation | Manual UAT + automated load test |
| Mistral Small 3.2 handles all deception inference | Inference log inspection + model name in `AnalysisReport.model_name` |
| Client text model in production inference path | Integration test: text item produces report with correct `model_name` |
| Client audio model in production inference path | Integration test: audio item produces report with correct `model_name` |
| Theme report produced with ≤50 themes | Unit test on theme aggregator + E2E test on 100-item batch |
| Stripe checkout → usage report → webhook E2E verified | Stripe test mode with `stripe listen` CLI + automated scenario |
| Duplicate webhook events handled idempotently | Send same `stripe_event_id` twice; verify DB has one record, HTTP 200 both times |
| GPU utilized for inference (not CPU fallback) | Grafana GPU SM utilization > 70% during load test |
| Per-item failure does not fail batch | Inject failing item into batch; verify sibling items complete and batch reaches `completed` |
| Inference timeout per item enforced | Simulate slow inference service; verify item marked `failed` with `inference_timeout` |

---

## 15. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Client repo model has incompatible output schema | Medium | High | Contract testing in Phase 1 audit; define adapter layer |
| Mistral Small 3.2 requires prompt tuning for theme clustering | Medium | Medium | Allocate 2 days for prompt engineering iteration in Phase 2 |
| VRAM pressure at 100-item concurrency | Medium | High | Limit active inference slots to 20; monitor KV cache utilization |
| Stripe existing account has undocumented product/price config | High | Medium | Full Stripe account audit in Phase 1; test in Stripe test mode before live |
| Audio pipeline requires transcription stage (slower, more expensive) | Medium | Medium | Benchmark transcription latency separately; consider async pre-transcription |
| GPU availability for development environment | Low | Medium | Docker Compose GPU profile with fallback CPU mode for non-GPU dev machines |

---

*End of PRD v1.0.0*
