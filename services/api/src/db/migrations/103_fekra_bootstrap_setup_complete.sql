-- 103_fekra_bootstrap_setup_complete.sql
-- Isolated Fekra V2 bootstrap posture:
-- - Doable's operator setup wizard is a one-time platform concern and must not
--   intercept normal Fekra user signups once infrastructure is provisioned.
-- - Keep public signup approval disabled in this smoke environment.
--
-- This migration intentionally does NOT configure AI providers, billing,
-- email, OAuth, or any secret material.

INSERT INTO platform_config (key, value, updated_at)
VALUES ('setup_completed_at', to_jsonb(now()::text), now())
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = now();

INSERT INTO platform_config (key, value, updated_at)
VALUES (
  'signup_approval',
  '{"enabled": false, "pending_message": ""}'::jsonb,
  now()
)
ON CONFLICT (key) DO UPDATE
SET value = jsonb_set(
      COALESCE(platform_config.value, '{}'::jsonb),
      '{enabled}',
      'false'::jsonb,
      true
    ),
    updated_at = now();

INSERT INTO platform_config (key, value, updated_at)
VALUES ('setup.require_signup_approval', 'false'::jsonb, now())
ON CONFLICT (key) DO UPDATE
SET value = 'false'::jsonb,
    updated_at = now();
