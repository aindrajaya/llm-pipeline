# Deception Analysis Platform v2

A production-grade full-stack system for analyzing uploaded content (text documents and audio files) for themes of deception using LLM inference (Mistral Small 3.2 via vLLM).

## Architecture

```
Client Browser → Node.js Fastify API (cluster mode)
                         ↓
                    BullMQ / Redis (job queues)
                         ↓
               Python FastAPI + vLLM (inference service)
                         ↓
                    PostgreSQL (persistent state)
```

### Services
| Service | Port | Description |
|---------|------|-------------|
| `api` | 3000 | Node.js Fastify API + BFF |
| `inference` | 8000 | Python FastAPI + vLLM inference |
| `postgres` | 5432 | PostgreSQL database |
| `redis` | 6379 | BullMQ queue backing store |
| `prometheus` | 9090 | Metrics collection |
| `grafana` | 3001 | Observability dashboards |

## Quick Start (Development)

### Prerequisites
- Docker Desktop with GPU passthrough enabled (NVIDIA CUDA)
- Node.js 20+
- Python 3.11+

### 1. Clone and configure environment
```bash
git clone <repo>
cd deception-analysis-platform-v2
cp apps/api/.env.example apps/api/.env
# Edit apps/api/.env with your credentials
```

### 2. Start all services
```bash
docker compose -f infra/docker-compose.yml up --build
```

### 3. Run database migrations
```bash
docker compose -f infra/docker-compose.yml exec postgres \
  psql -U postgres -d deception_analysis -f /docker-entrypoint-initdb.d/001_initial.sql
```

### 4. Test the API
```bash
# Create a batch
curl -X POST http://localhost:3000/api/v1/batches \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"user_id":"test-user-uuid"}'

# Check inference health
curl http://localhost:8000/health
```

## Environment Variables

See [`apps/api/.env.example`](apps/api/.env.example) for the full list. Key variables:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection URL |
| `STRIPE_SECRET_KEY` | Stripe secret key (use `sk_test_...` in dev) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `INFERENCE_SERVICE_URL` | Internal URL for the Python inference service |
| `TEXT_MODEL_PATH` | Path or HuggingFace repo ID for client text model |
| `AUDIO_MODEL_PATH` | Path or HuggingFace repo ID for client audio model |
| `MISTRAL_MODEL_ID` | `mistralai/Mistral-Small-3.2` (or local path) |

## Stripe Setup (Test Mode)

See [`docs/stripe-billing-guide.md`](docs/stripe-billing-guide.md) for full setup instructions.

```bash
# Install Stripe CLI and forward webhooks to local server
stripe listen --forward-to http://localhost:3000/webhook/stripe

# Test webhook events
stripe trigger customer.subscription.created
stripe trigger invoice.payment_succeeded
```

## Load Testing

```bash
# Install autocannon
npm install -g autocannon

# Run 100-item batch load test
node scripts/load-test.js
```

## Model Benchmarking (FP16 vs AWQ)

```bash
cd services/inference
python scripts/benchmark-models.py --items-file benchmark_items.json
```

## Production Deployment

```bash
docker compose -f infra/docker-compose.prod.yml up -d
```

Production uses PM2 cluster mode for the Node.js API, vLLM with AWQ 4-bit quantization for inference, and resource-limited containers.

## Docs

- [Architecture](docs/architecture.md)
- [API Reference](docs/api-reference.md)
- [Stripe Billing Guide](docs/stripe-billing-guide.md)
