# Deception Analysis Platform v2 — API Reference

## Base URLs

| Environment | URL |
|-------------|-----|
| Development | `http://localhost:3000` |
| Production  | `https://api.your-domain.com` |

## Authentication
All endpoints require a valid JWT in the `Authorization: Bearer <token>` header (except `/webhook/stripe`).

---

## Batch Endpoints

### POST `/api/v1/batches`
Create a new batch session.

**Request body:**
```json
{ "user_id": "uuid", "item_count": 100 }
```
**Response `201`:**
```json
{ "id": "uuid", "user_id": "uuid", "status": "created", "item_count": 100, "payment_status": "pending" }
```

---

### POST `/api/v1/batches/:id/items`
Upload items. Accepts **multipart/form-data** (files) or **application/json** (text blobs).

**JSON body (text blobs — array):**
```json
[
  { "source_type": "text", "raw_text": "Document content here" },
  { "source_type": "text", "raw_text": "Another document" }
]
```
Limit: 100 items total per batch. File size: 50 MB per file.  
Allowed MIME types: `text/plain`, `text/csv`, `application/pdf`, `.docx`, `audio/*`.

**Response `201`:**
```json
{ "batchId": "uuid", "items": [{ "id": "uuid", "status": "queued", ... }] }
```

---

### GET `/api/v1/batches/:id`
Get batch status and all item statuses.

**Response `200`:**
```json
{
  "batch": { "id": "uuid", "status": "processing", "item_count": 100, "payment_status": "pending" },
  "items": [{ "id": "uuid", "status": "completed", "source_type": "text" }]
}
```
Item statuses: `uploaded → queued → processing → completed | failed`

---

### GET `/api/v1/batches/:id/reports`
Get all `AnalysisReport` records for the batch.

**Response `200`:**
```json
{
  "reports": [{
    "id": "uuid",
    "batch_item_id": "uuid",
    "model_name": "mistral-small-3.2",
    "summary": "Subject shows several deception indicators...",
    "deception_indicators": [
      { "indicator": "Contradictory timeline", "severity": "high", "excerpt": "..." }
    ],
    "confidence_score": 0.87
  }]
}
```

---

### GET `/api/v1/batches/:id/theme-report`
Get the aggregated `ThemeReport` for the batch. Returns `202` if not yet ready.

**Response `200`:**
```json
{
  "batch_id": "uuid",
  "theme_count": 12,
  "themes": [{
    "theme_id": "uuid",
    "theme_title": "Contradictory Timeline Claims",
    "description": "Items repeatedly use inconsistent temporal references...",
    "confidence": 0.87,
    "frequency": 12,
    "supporting_items": ["batch_item_id_1", "batch_item_id_2"],
    "example_snippets": ["...claimed the event occurred in 2019..."]
  }]
}
```

---

### GET `/api/v1/batches/:id/stream`
Server-Sent Events stream for real-time batch progress.

```
Content-Type: text/event-stream

data: {"type":"progress","batchStatus":"processing","stats":{"completed":12,"processing":8,"failed":0}}
data: {"type":"done","batchStatus":"completed"}
```

---

## Billing Endpoints

### POST `/api/v1/billing/subscribe`
Create Stripe Customer + metered Subscription.

**Request body:**
```json
{ "user_id": "uuid", "email": "user@example.com" }
```
**Response `201`:**
```json
{
  "subscriptionId": "sub_xxx",
  "customerId": "cus_xxx",
  "status": "incomplete",
  "clientSecret": "seti_xxx_secret_xxx"
}
```
Use `clientSecret` with Stripe.js to confirm payment method.

---

### GET `/api/v1/billing/subscription?user_id=uuid`
Get current subscription status.

**Response `200`:**
```json
{
  "stripe_customer_id": "cus_xxx",
  "stripe_subscription_id": "sub_xxx",
  "status": "active",
  "current_period_end": "2026-05-01T00:00:00Z"
}
```

---

### POST `/api/v1/billing/portal`
Generate Stripe Customer Portal URL for self-service billing management.

**Request body:**
```json
{ "user_id": "uuid", "return_url": "https://app.example.com/billing" }
```
**Response `200`:**  
```json
{ "url": "https://billing.stripe.com/session/xxx" }
```

---

### POST `/webhook/stripe`
Stripe webhook receiver. Requires raw request body with `stripe-signature` header.

- Returns `200` within 2 seconds
- Idempotent: duplicate events return `{"received":true,"duplicate":true}`
- Rejects invalid signatures with `400`

---

## Inference Service API (Internal — `http://inference:8000`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/analyze/text` | Analyze single text item |
| `POST` | `/analyze/audio` | Analyze single audio item |
| `POST` | `/analyze/stream` | Streaming text analysis |
| `POST` | `/themes/aggregate` | Aggregate themes across reports |
| `POST` | `/report-usage` | Report Stripe metered usage |
| `GET`  | `/health` | Health + GPU status |
| `GET`  | `/metrics` | Prometheus metrics |

### `AnalysisResult` schema
```json
{
  "item_id": "uuid",
  "model_name": "mistral-small-3.2",
  "model_version": "1.0.0",
  "summary": "string",
  "deception_indicators": [
    { "indicator": "string", "severity": "low|medium|high", "excerpt": "string" }
  ],
  "confidence_score": 0.87,
  "raw_output": {}
}
```
