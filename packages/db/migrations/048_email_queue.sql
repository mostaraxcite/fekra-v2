-- Migration 048: Email queue table for reliable email delivery
-- Persists emails to disk so they survive server restarts/crashes

CREATE TABLE IF NOT EXISTS email_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text_body TEXT,
  from_address TEXT,
  template TEXT,
  template_data JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'dead')),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  last_error TEXT,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_queue_pending
  ON email_queue (next_retry_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_email_queue_status ON email_queue (status);

-- Some self-hosted installs create a dedicated `doable` DB role, while
-- Railway's PostgreSQL deployment uses `postgres`. Grant only when that
-- optional compatibility role exists so the migration is portable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'doable') THEN
    GRANT ALL PRIVILEGES ON TABLE email_queue TO doable;
  END IF;
END
$$;
