import { sql } from "./index.js";

const ownerEmail = process.env.FEKRA_OWNER_EMAIL?.trim().toLowerCase();
const reconcileE2E = process.env.FEKRA_RECONCILE_E2E === "true";

if (!ownerEmail) {
  throw new Error("FEKRA_OWNER_EMAIL is required");
}

const [owner] = await sql<{ id: string; email: string }[]>`
  SELECT id, email
  FROM users
  WHERE lower(email) = ${ownerEmail}
  LIMIT 1
`;

if (!owner) {
  throw new Error(`Owner account not found: ${ownerEmail}`);
}

await sql.begin(async (tx: any) => {
  if (reconcileE2E) {
    await tx`
      UPDATE users
      SET is_platform_admin = false,
          platform_role = 'member',
          updated_at = now()
      WHERE email LIKE 'fekra.e2e.%@example.com'
    `;
  }

  await tx`
    UPDATE users
    SET is_platform_admin = true,
        platform_role = 'owner',
        is_verified_publisher = true,
        approval_status = 'approved',
        updated_at = now()
    WHERE id = ${owner.id}::uuid
  `;

  await tx`
    UPDATE credit_balances
    SET daily_credits = 999999,
        monthly_credits = 999999,
        plan_type = 'enterprise',
        updated_at = now()
    WHERE user_id = ${owner.id}::uuid
  `;

  await tx`
    UPDATE workspaces w
    SET plan = 'enterprise',
        updated_at = now()
    FROM workspace_members wm
    WHERE wm.workspace_id = w.id
      AND wm.user_id = ${owner.id}::uuid
      AND wm.role = 'owner'
  `;

  const seal = JSON.stringify(new Date().toISOString());
  await tx`
    INSERT INTO platform_config (key, value, updated_by, updated_at)
    VALUES ('bootstrap_completed_at', ${seal}::jsonb, ${owner.id}::uuid, now())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
  `;
});

const affected = await sql<{
  email: string;
  is_platform_admin: boolean;
  platform_role: string;
}[]>`
  SELECT email, is_platform_admin, platform_role
  FROM users
  WHERE lower(email) = ${ownerEmail}
     OR (${reconcileE2E} AND email LIKE 'fekra.e2e.%@example.com')
  ORDER BY email
`;

console.log("FEKRA_OWNER_RECONCILE=" + JSON.stringify(affected));
console.log("BOOTSTRAP_SEALED=true");
await sql.end();
