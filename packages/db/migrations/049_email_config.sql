-- Migration 049: Email provider configuration (encrypted at rest)
-- Stores the admin-configured email provider settings in the database.
-- All sensitive credentials (API keys, passwords, OAuth tokens) are
-- encrypted using pgp_sym_encrypt with the ENCRYPTION_KEY.
-- Only one active config row exists at a time (singleton pattern).

CREATE TABLE IF NOT EXISTS email_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('smtp', 'resend', 'google')),
  label TEXT NOT NULL DEFAULT '',
  from_address TEXT NOT NULL DEFAULT 'Doable <noreply@doable.me>',
  credentials_encrypted BYTEA NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  verified BOOLEAN NOT NULL DEFAULT false,
  last_verified_at TIMESTAMPTZ,
  last_error TEXT,
  configured_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_config_active
  ON email_config (is_active) WHERE is_active = true;

-- `doable` is an optional dedicated database role. Railway's deployment
-- connects as `postgres`, so do not make schema creation depend on that role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'doable') THEN
    GRANT ALL PRIVILEGES ON TABLE email_config TO doable;
  END IF;
END
$$;
