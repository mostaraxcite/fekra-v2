/**
 * Fekra first-account bootstrap.
 *
 * Exactly one account is automatically elevated by signup: the first user row
 * ever created in the database. Every later signup remains a normal user.
 *
 * The decision is made under a PostgreSQL advisory transaction lock so two
 * concurrent signups cannot both become owners. Once bootstrap_completed_at is
 * written, automatic elevation is permanently sealed. There is intentionally
 * no request token, query parameter, or environment token that can elevate a
 * later signup.
 */

import { sql } from "../db/index.js";
import { invalidatePlatformConfigCache } from "../lib/platformConfig.js";

export interface BootstrapResult {
  promoted: boolean;
  reason: string;
}

export interface BootstrapContext {
  clientIp?: string | null;
  userAgent?: string | null;
}

const FIRST_OWNER_LOCK_ID = 734921001;

function configIsSealed(value: unknown): boolean {
  return typeof value === "string"
    ? value.length > 0 && value !== "null"
    : value !== null && value !== undefined && value !== false;
}

/**
 * Promote the first-ever account to platform owner.
 *
 * If a previous first-signup request crashed after inserting the user but
 * before completing bootstrap, a later invocation repairs that situation by
 * promoting the actual earliest user rather than the later caller. The return
 * value reports whether `newUserId` itself was promoted.
 */
export async function firstUserBootstrap(
  newUserId: string,
  ctx?: BootstrapContext,
): Promise<BootstrapResult> {
  let promotedUserId: string | null = null;
  let callerWasPromoted = false;
  let resultReason = "not_first_user";

  await sql.begin(async (tx: any) => {
    // Serialize all signup bootstrap decisions across API replicas.
    await tx`SELECT pg_advisory_xact_lock(${FIRST_OWNER_LOCK_ID})`;

    const [configRow] = await tx<{ value: unknown }[]>`
      SELECT value
      FROM platform_config
      WHERE key = 'bootstrap_completed_at'
      FOR UPDATE
    `;

    if (configIsSealed(configRow?.value)) {
      resultReason = "bootstrap_already_completed";
      return;
    }

    // The first account is deterministic even if two registrations arrive at
    // almost the same time. UUID is only a tie-breaker for identical timestamps.
    const [firstUser] = await tx<{ id: string }[]>`
      SELECT id
      FROM users
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `;

    if (!firstUser?.id) {
      resultReason = "no_users";
      return;
    }

    promotedUserId = firstUser.id;
    callerWasPromoted = firstUser.id === newUserId;
    resultReason = callerWasPromoted ? "first_user" : "recovered_first_user";

    await tx`
      UPDATE users
      SET is_platform_admin     = true,
          platform_role         = 'owner',
          is_verified_publisher = true,
          updated_at            = now()
      WHERE id = ${firstUser.id}::uuid
    `;

    // These updates are no-ops if the first user's workspace/credit row has
    // not been created yet; normal signup invokes bootstrap after workspace
    // creation, so the standard path receives owner entitlements immediately.
    await tx`
      UPDATE credit_balances
      SET daily_credits    = 999999,
          monthly_credits  = 999999,
          plan_type        = 'enterprise',
          updated_at       = now()
      WHERE user_id = ${firstUser.id}::uuid
    `;

    await tx`
      UPDATE workspaces w
      SET plan       = 'enterprise',
          updated_at = now()
      FROM workspace_members wm
      WHERE wm.workspace_id = w.id
        AND wm.user_id      = ${firstUser.id}::uuid
        AND wm.role         = 'owner'
    `;

    // Seal automatic promotion in the SAME transaction as the role update.
    // This prevents a crash from leaving an owner promotion without a seal.
    const sealedAtJson = JSON.stringify(new Date().toISOString());
    await tx`
      INSERT INTO platform_config (key, value, updated_by, updated_at)
      VALUES (
        'bootstrap_completed_at',
        ${sealedAtJson}::jsonb,
        ${firstUser.id}::uuid,
        now()
      )
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
    `;

    // Keep the audit row atomic with the promotion when the table is available.
    try {
      await tx`
        INSERT INTO admin_audit_log
          (actor_id, actor_email, actor_role, action,
           resource_type, resource_id, details, client_ip, user_agent)
        SELECT
          u.id,
          u.email,
          'platform_admin',
          'bootstrap_promote_owner',
          'user',
          u.id::text,
          ${JSON.stringify({ reason: resultReason })}::jsonb,
          ${ctx?.clientIp ?? null}::inet,
          ${ctx?.userAgent ?? null}
        FROM users u
        WHERE u.id = ${firstUser.id}::uuid
      `;
    } catch (err) {
      // Audit logging must not make the first account unusable on an older DB.
      console.warn("[firstUserBootstrap] audit INSERT failed:", err);
    }
  });

  invalidatePlatformConfigCache("bootstrap_completed_at");

  if (!promotedUserId) {
    return { promoted: false, reason: resultReason };
  }

  console.info(
    `[firstUserBootstrap] owner sealed: user=${promotedUserId} caller=${newUserId} reason=${resultReason}`,
  );

  return {
    promoted: callerWasPromoted,
    reason: resultReason,
  };
}
