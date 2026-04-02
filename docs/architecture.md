# Architecture — Deception Analysis Platform v2

## Service Map

```
┌──────────────────────────────────────────────────────────────────────┐
│                         CLIENT BROWSER                               │
│   React SPA (existing frontend, maximally reused)                   │
└────────────────────────┬─────────────────────────────────────────────┘
                         │ HTTPS
┌────────────────────────▼─────────────────────────────────────────────┐
│                   API GATEWAY / BFF  (Node.js Fastify)               │
│  - JWT auth middleware                                               │
│  - Batch CRUD endpoints (POST, GET)                                  │
│  - Item upload (multipart + JSON, MIME/size validation)              │
│  - SSE real-time batch status stream                                 │
│  - Stripe checkout + subscription management                         │
│  - Stripe webhook receiver (verify, idempotent, enqueue)             │
│  Cluster mode: 1 worker per CPU core via node:cluster                │
└──────────┬────────────────────────────────────┬──────────────────────┘
           │ Enqueue jobs                       │ Read/write results
┌──────────▼──────────┐              ┌──────────▼───────────────────────┐
│  BATCH ORCHESTRATOR  │              │    POSTGRESQL DATABASE            │
│  (BullMQ Worker)    │              │  batches, batch_items,           │
│  - Promise.allSettled│              │  analysis_reports, theme_reports, │
│  - Semaphore(20)    │              │  payment_events, subscriptions   │
│  - AbortController  │              └──────────────────────────────────┘
│    timeout per item │
│  - 2×retry+backoff  │
│  - Dead-letter queue│
└──────────┬──────────┘
           │ HTTP
┌──────────▼───────────────────────────────────────────────────────────┐
│               INFERENCE SERVICE  (Python FastAPI + vLLM)             │
│  ┌──────────────────┐  ┌─────────────────┐  ┌──────────────────────┐ │
│  │ Text Analysis    │  │ Audio Analysis  │  │ Theme Aggregation   │ │
│  │ Client model +   │  │ Client model +  │  │ Mistral Small 3.2   │ │
│  │ Mistral Small 3.2│  │ Mistral Small   │  │ ≤50 themes          │ │
│  └──────────────────┘  └─────────────────┘  └──────────────────────┘ │
│  vLLM: continuous batching, PagedAttention, AWQ 4-bit quantization   │
│  GPU: NVIDIA CUDA, SM util target >70%                               │
└──────────────────────────────────────────────────────────────────────┘
           │
┌──────────▼──────────┐
│   REDIS  (BullMQ)   │
│   Queues:           │
│   - analysis        │
│   - theme-agg       │
│   - stripe-events   │
│   - dead-letter     │
└─────────────────────┘
```

## Technology Choices

| Layer | Technology | Why |
|-------|-----------|-----|
| API / BFF | Node.js + Fastify | Non-blocking I/O for fan-out; cluster for X-axis scaling |
| Queue | BullMQ + Redis | Per-item retry, dead-letter, visibility |
| Inference | Python FastAPI + vLLM | Continuous batching, PagedAttention, GPU-native |
| LLM | Mistral Small 3.2 | Client requirement; better instruction-following than 7B |
| DB | PostgreSQL | Relational integrity for batch/item/payment |
| Payments | Stripe metered billing | Per-item usage-based charges |
| Monitoring | Prometheus + DCGM + Grafana | GPU-aware metrics |

## Scaling Strategy (Scale Cube)

1. **X-axis (clone):** API tier is stateless — `node:cluster` or PM2 cluster mode. Zero code changes needed.
2. **Y-axis (decompose):** Inference service is a separate process/container. Scale inference independently of the API tier.
3. **Z-axis (partition):** If needed, shard batch queues by `customer_id` to dedicated worker pools.

## Async Patterns

- **Fan-out:** `Promise.allSettled` — failed items never block siblings
- **Concurrency cap:** `Semaphore(20)` — max 20 concurrent inference slots
- **Timeout:** `AbortController` + timer — 30s per item, marked `inference_timeout`
- **Streaming:** `for await...of` on `ReadableStream` — SSE progressive token delivery
- **Theme aggregation:** Async generator for paginated DB reads → prevents full-table allocation

## GPU Optimization

| Technique | Config |
|-----------|--------|
| Continuous batching | vLLM default (iteration-level scheduling) |
| Quantization | AWQ 4-bit (validated <2% divergence from FP16) |
| GPU memory | `gpu_memory_utilization=0.85` (15% KV cache headroom) |
| Max sequences | `max_num_seqs=100` (matches 100-item batch) |
| CUDA graphs | `enforce_eager=False` (kernel fusion) |

## Security

- File uploads: MIME type + magic bytes validated, randomized UUID filenames
- Stripe webhooks: `stripe.webhooks.constructEvent()` signature verification
- Secrets: injected via environment variables / secrets manager only
- Uploaded files: TTL-based deletion configurable via `FILE_TTL_HOURS` env var
