import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const initialMigration = readFileSync(
  "supabase/migrations/20260708150000_routine_tracker.sql",
  "utf8",
)
const autosaveMigration = readFileSync(
  "supabase/migrations/20260713120000_routine_tracker_atomic_autosave.sql",
  "utf8",
)
const hardeningMigration = readFileSync(
  "supabase/migrations/20260713143000_secure_routine_tracker_write_boundary.sql",
  "utf8",
)
const payloadHardeningMigration = readFileSync(
  "supabase/migrations/20260713150000_harden_routine_tracker_rpc_payloads.sql",
  "utf8",
)
const entitlementBoundaryMigration = readFileSync(
  "supabase/migrations/20260714120000_enforce_routine_tracker_entitlement_boundary.sql",
  "utf8",
)

test("fresh tracker schema allows authenticated reads but no direct log mutations", () => {
  assert.match(initialMigration, /GRANT SELECT ON TABLE public\.routine_logs TO authenticated;/)
  assert.match(
    initialMigration,
    /GRANT SELECT ON TABLE public\.routine_log_products TO authenticated;/,
  )
  assert.doesNotMatch(initialMigration, /CREATE POLICY routine_logs_(?:insert|update|delete)_own/)
  assert.doesNotMatch(
    initialMigration,
    /CREATE POLICY routine_log_products_(?:insert|update|delete)_own/,
  )
})

test("tracker mutation RPCs run through a fixed-search-path definer boundary", () => {
  assert.equal((autosaveMigration.match(/SECURITY DEFINER/g) ?? []).length, 2)
  assert.equal((autosaveMigration.match(/SET search_path = public, pg_temp/g) ?? []).length, 2)
  assert.match(
    autosaveMigration,
    /GRANT EXECUTE ON FUNCTION public\.replace_routine_log[\s\S]+TO authenticated, service_role;/,
  )
  assert.match(
    autosaveMigration,
    /GRANT EXECUTE ON FUNCTION public\.delete_routine_log[\s\S]+TO authenticated, service_role;/,
  )
})

test("forward hardening removes grants and mutation policies from existing databases", () => {
  assert.match(
    hardeningMigration,
    /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.routine_logs FROM authenticated;/,
  )
  assert.match(
    hardeningMigration,
    /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.routine_log_products FROM authenticated;/,
  )
  assert.equal((hardeningMigration.match(/DROP POLICY IF EXISTS/g) ?? []).length, 6)
  assert.equal((hardeningMigration.match(/SECURITY DEFINER/g) ?? []).length, 2)
})

test("replace_routine_log rejects malformed, oversized, and duplicate direct-RPC payloads", () => {
  assert.match(
    payloadHardeningMigration,
    /jsonb_array_length\(coalesce\(p_products, '\[\]'::jsonb\)\) > 40/,
  )
  assert.match(
    payloadHardeningMigration,
    /jsonb_array_elements\(coalesce\(p_products, '\[\]'::jsonb\)\) AS p\(value\)/,
  )
  assert.match(payloadHardeningMigration, /jsonb_typeof\(p\.value\) <> 'object'/)
  assert.match(payloadHardeningMigration, /jsonb_typeof\(p\.value -> 'category'\) <> 'string'/)
  assert.match(payloadHardeningMigration, /char_length\(p\.value ->> 'product_name'\) > 200/)
  assert.match(payloadHardeningMigration, /user_product_usage_id' !~\* '\^\[0-9a-f\]/)
  assert.match(
    payloadHardeningMigration,
    /THEN 'usage:' \|\| \(p\.value ->> 'user_product_usage_id'\)/,
  )
  assert.match(payloadHardeningMigration, /ELSE 'manual:' \|\| \(p\.value ->> 'category'\)/)
  assert.match(payloadHardeningMigration, /'code', 'invalid_products'/)
})

test("delete_routine_log writes an absent-row tombstone before applying revision ordering", () => {
  const deleteFunction = payloadHardeningMigration.slice(
    payloadHardeningMigration.indexOf("CREATE OR REPLACE FUNCTION public.delete_routine_log"),
  )
  const replaceFunction = payloadHardeningMigration.slice(
    payloadHardeningMigration.indexOf("CREATE OR REPLACE FUNCTION public.replace_routine_log"),
    payloadHardeningMigration.indexOf("CREATE OR REPLACE FUNCTION public.delete_routine_log"),
  )
  assert.match(
    deleteFunction,
    /INSERT INTO public\.routine_logs \(user_id, logged_on, timezone, day_type, client_session_id, client_revision, deleted_at\)[\s\S]+VALUES \(v_user_id, p_logged_on, p_timezone, 'none', p_client_session_id, p_client_revision, now\(\)\)[\s\S]+ON CONFLICT \(user_id, logged_on\) DO NOTHING;/,
  )
  assert.match(deleteFunction, /IF v_inserted_rows > 0 THEN/)
  assert.match(
    deleteFunction,
    /v_log\.client_session_id = p_client_session_id AND v_log\.client_revision >= p_client_revision/,
  )
  assert.ok(
    deleteFunction.indexOf("INSERT INTO public.routine_logs") <
      deleteFunction.indexOf("v_log.client_session_id = p_client_session_id"),
    "the tombstone must exist before a same-session stale revision is evaluated",
  )
  assert.ok(
    replaceFunction.indexOf("v_log.client_session_id = p_client_session_id") <
      replaceFunction.indexOf("deleted_at = NULL"),
    "a delayed lower revision must return stale before it can restore a tombstone",
  )
})

test("entitlement boundary revokes direct tracker access and replaces RPC signatures", () => {
  for (const table of ["routine_logs", "routine_log_products", "tracker_nudge_dismissals"]) {
    assert.match(
      entitlementBoundaryMigration,
      new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM authenticated;`),
    )
  }
  assert.match(
    entitlementBoundaryMigration,
    /DROP FUNCTION IF EXISTS public\.replace_routine_log\(date, text, text, text, jsonb, uuid, bigint\);/,
  )
  assert.match(
    entitlementBoundaryMigration,
    /DROP FUNCTION IF EXISTS public\.delete_routine_log\(date, text, uuid, bigint\);/,
  )
  assert.match(
    entitlementBoundaryMigration,
    /CREATE FUNCTION public\.replace_routine_log\(\s*p_user_id uuid,/,
  )
  assert.match(
    entitlementBoundaryMigration,
    /CREATE FUNCTION public\.delete_routine_log\(p_user_id uuid,/,
  )
  assert.equal(
    (entitlementBoundaryMigration.match(/server_boundary_user_required/g) ?? []).length,
    2,
  )
  assert.doesNotMatch(entitlementBoundaryMigration, /auth\.uid\(\)/)
  assert.match(
    entitlementBoundaryMigration,
    /GRANT EXECUTE ON FUNCTION public\.replace_routine_log\(uuid, date, text, text, text, jsonb, uuid, bigint\) TO service_role;/,
  )
  assert.match(
    entitlementBoundaryMigration,
    /GRANT EXECUTE ON FUNCTION public\.delete_routine_log\(uuid, date, text, uuid, bigint\) TO service_role;/,
  )
  assert.match(
    entitlementBoundaryMigration,
    /REVOKE ALL ON FUNCTION public\.replace_routine_log\(uuid, date, text, text, text, jsonb, uuid, bigint\) FROM PUBLIC, anon, authenticated;/,
  )
})
