-- Deception Analysis Platform v2 — Initial Schema
-- Run: psql -U postgres -d deception_analysis -f 001_initial.sql

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table (minimal; authentication managed by existing auth layer)
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Subscriptions: Stripe subscription tracking per user
CREATE TABLE IF NOT EXISTS subscriptions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id      TEXT NOT NULL,
  stripe_subscription_id  TEXT NOT NULL UNIQUE,
  stripe_item_id          TEXT NOT NULL,   -- SubscriptionItem ID for usage reporting
  status                  TEXT NOT NULL CHECK (status IN ('active','past_due','canceled','incomplete','trialing')),
  current_period_end      TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer_id ON subscriptions(stripe_customer_id);

-- ThemeReports: created after batch completes (referenced by batches)
CREATE TABLE IF NOT EXISTS theme_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id         UUID NOT NULL,           -- FK added after batches table
  theme_count      INT NOT NULL CHECK (theme_count BETWEEN 0 AND 50),
  themes           JSONB NOT NULL DEFAULT '[]',
  model_name       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Batches: one per user submission
CREATE TABLE IF NOT EXISTS batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'created'
                    CHECK (status IN ('created','queued','processing','completed','failed')),
  item_count      INT NOT NULL CHECK (item_count BETWEEN 1 AND 100),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  payment_status  TEXT NOT NULL DEFAULT 'pending'
                    CHECK (payment_status IN ('pending','usage_reported','settled','failed')),
  theme_report_id UUID REFERENCES theme_reports(id)
);

CREATE INDEX IF NOT EXISTS idx_batches_user_id ON batches(user_id);
CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status);

-- Add FK from theme_reports back to batches now that batches exists
ALTER TABLE theme_reports
  ADD CONSTRAINT fk_theme_reports_batch_id FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_theme_reports_batch_id ON theme_reports(batch_id);

-- BatchItems: one per uploaded file/text blob
CREATE TABLE IF NOT EXISTS batch_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  source_type    TEXT NOT NULL CHECK (source_type IN ('text','audio','document')),
  file_url       TEXT,
  raw_text       TEXT,
  file_name      TEXT,
  file_size      BIGINT,
  mime_type      TEXT,
  status         TEXT NOT NULL DEFAULT 'uploaded'
                   CHECK (status IN ('uploaded','queued','processing','completed','failed')),
  retry_count    INT NOT NULL DEFAULT 0,
  error_message  TEXT,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_batch_items_batch_id ON batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_items_status ON batch_items(status);

-- AnalysisReports: output per completed batch item
CREATE TABLE IF NOT EXISTS analysis_reports (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_item_id         UUID NOT NULL REFERENCES batch_items(id) ON DELETE CASCADE,
  model_name            TEXT NOT NULL,
  model_version         TEXT NOT NULL DEFAULT '1.0.0',
  summary               TEXT,
  deception_indicators  JSONB DEFAULT '[]',  -- [{indicator, severity, excerpt}]
  confidence_score      FLOAT CHECK (confidence_score BETWEEN 0 AND 1),
  raw_output            JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analysis_reports_batch_item_id ON analysis_reports(batch_item_id);

-- PaymentEvents: idempotent Stripe webhook event log
CREATE TABLE IF NOT EXISTS payment_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id  TEXT UNIQUE NOT NULL,   -- Deduplication key
  batch_id         UUID REFERENCES batches(id),
  customer_id      TEXT,
  event_type       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received','processed','failed')),
  payload          JSONB NOT NULL,
  processed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_stripe_event_id ON payment_events(stripe_event_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_customer_id ON payment_events(customer_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_status ON payment_events(status);
