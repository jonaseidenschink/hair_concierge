import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Server-side accessor for the one-lifetime free-reveal credit ledger
 * (`public.scan_free_reveals` — migration 20260905090000). Deliberately not
 * the scan attempt log: this table only ever holds at most one row per
 * user, and that row's existence *is* the used/unused signal.
 *
 * `hasUsedFreeReveal` backs T1's `getEntitlements` `deps.readFreeRevealUsed`
 * (used = row exists — see src/lib/entitlements/entitlements.ts) and
 * `consumeFreeReveal` backs T8's reveal endpoint. Both are called with the
 * admin client server-side; RLS only grants the owner SELECT on their own
 * row, so a non-admin client can observe `hasUsedFreeReveal` for its own
 * user but can never call `consumeFreeReveal` successfully (INSERT is
 * service-role-only).
 */

export type ConsumeFreeRevealResult = "consumed" | "already_used"

export async function hasUsedFreeReveal(client: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await client
    .from("scan_free_reveals")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle()

  if (error) throw new Error(`free_reveal_lookup_failed: ${error.message}`)
  return data !== null
}

export type FreeRevealRecord = { productId: string }

/**
 * T8 fix round 1 (F1-adjunct, keepsake rule): reads which product the user's one-lifetime
 * credit was already spent on, so a caller that hits `"already_used"` can tell a genuine
 * re-request for the SAME product (re-serve what they paid for) apart from a different
 * product (a real conflict). Read-only; never used to decide consume vs. already_used —
 * `consumeFreeReveal`'s INSERT stays the sole source of truth for that.
 */
export async function loadFreeRevealRecord(
  client: SupabaseClient,
  userId: string,
): Promise<FreeRevealRecord | null> {
  const { data, error } = await client
    .from("scan_free_reveals")
    .select("product_id")
    .eq("user_id", userId)
    .maybeSingle()

  if (error) throw new Error(`free_reveal_lookup_failed: ${error.message}`)
  const row = data as { product_id: string } | null
  return row ? { productId: row.product_id } : null
}

/**
 * Atomic consume: the PRIMARY KEY on `user_id` is the only thing that
 * decides "consumed" vs. "already_used" — a second concurrent INSERT for
 * the same user always loses the unique-violation race and reports
 * `"already_used"`, so this never reads the table before writing to it.
 */
export async function consumeFreeReveal(
  client: SupabaseClient,
  { userId, productId }: { userId: string; productId: string },
): Promise<ConsumeFreeRevealResult> {
  const { error } = await client
    .from("scan_free_reveals")
    .insert({ user_id: userId, product_id: productId })

  if (!error) return "consumed"
  if (isUniqueViolation(error)) return "already_used"
  throw new Error(`free_reveal_consume_failed: ${error.message}`)
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const err = error as { code?: unknown; message?: unknown }
  const text = String(err.message ?? "").toLowerCase()
  return err.code === "23505" || text.includes("duplicate") || text.includes("unique")
}
