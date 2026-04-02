# Stripe Billing Setup Guide

## Overview

Deception Analysis Platform uses Stripe **metered usage-based billing**: customers subscribe to a plan and are charged automatically per item analyzed, at the end of each billing period.

---

## Prerequisites

- Stripe account (test mode for development)
- Stripe CLI installed (`brew install stripe/stripe-cli/stripe` or see [docs](https://stripe.com/docs/stripe-cli))

---

## 1. Create Product and Metered Price

In the Stripe Dashboard (or via CLI):

```bash
# Create product
stripe products create \
  --name="Deception Analysis API" \
  --description="Per-item deception analysis using Mistral Small 3.2"

# Create metered price ($0.10 per item)
stripe prices create \
  --unit-amount=10 \
  --currency=usd \
  --recurring[interval]=month \
  --recurring[usage-type]=metered \
  --product=<product_id>
```

Copy the `price_xxx` ID and set it as `STRIPE_PRICE_ID` in your `.env`.

---

## 2. Configure Webhook Endpoint

```bash
# Register webhook endpoint (production)
stripe webhook-endpoints create \
  --url="https://api.your-domain.com/webhook/stripe" \
  --enabled-events="customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.payment_succeeded,invoice.payment_failed"
```

Copy the webhook signing secret (`whsec_xxx`) and set it as `STRIPE_WEBHOOK_SECRET`.

---

## 3. Local Development (Stripe CLI)

```bash
# Forward Stripe events to local server
stripe listen --forward-to http://localhost:3000/webhook/stripe

# Leave running — the CLI will print a webhook signing secret (use this for dev)
# export STRIPE_WEBHOOK_SECRET=whsec_xxx
```

---

## 4. Test the Full Flow

```bash
# 1. Create a subscription (replaces checkout flow)
curl -X POST http://localhost:3000/api/v1/billing/subscribe \
  -H "Content-Type: application/json" \
  -d '{"user_id":"<uuid>","email":"test@example.com"}'

# 2. Trigger test events
stripe trigger customer.subscription.created
stripe trigger invoice.payment_succeeded
stripe trigger invoice.payment_failed

# 3. Verify idempotency — send same event ID twice
stripe trigger invoice.payment_succeeded  # should return {received:true} both times
# Verify DB: SELECT COUNT(*) FROM payment_events WHERE event_type = 'invoice.payment_succeeded';
# Should be 1 row per event ID
```

---

## 5. Idempotency Verification

The webhook handler uses `stripe_event_id` as a deduplication key:

```sql
-- Check idempotency (only 1 row per stripe_event_id)
SELECT stripe_event_id, COUNT(*) 
FROM payment_events 
GROUP BY stripe_event_id 
HAVING COUNT(*) > 1;
-- Should return 0 rows
```

---

## 6. Usage Reporting

Usage is automatically reported to Stripe after each batch completes:

```
Batch completes → Theme aggregation worker → /report-usage endpoint
→ stripe.SubscriptionItem.create_usage_record(subscription_item_id, quantity=N)
→ batches.payment_status = 'usage_reported'
```

To manually verify usage records in Stripe:
```bash
stripe subscription_items list --subscription=<sub_id>
stripe usage_records list <subscription_item_id>
```

---

## Environment Variables Reference

| Variable | Example | Description |
|----------|---------|-------------|
| `STRIPE_SECRET_KEY` | `sk_test_xxx` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | `whsec_xxx` | Webhook signing secret |
| `STRIPE_PRICE_ID` | `price_xxx` | Metered price ID |
