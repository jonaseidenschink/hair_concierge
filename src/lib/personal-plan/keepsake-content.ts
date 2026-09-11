import "server-only"

import { createAdminClient } from "@/lib/supabase/admin"

/**
 * Keepsake CONTENT (T17, freemium-scanner-first PR5) — the accepted Routine version a
 * keepsake Routine/Anwendung render needs. This is NOT the lapsed classifier any more:
 * that lives in `hasPersonalPlanKeepsakeEvidence` below (PR5 review fix Z2), because a
 * lapsed user with no accepted Routine still owns Merkliste and chat keepsakes.
 *
 * "Lapsed" is not a stored state anywhere in this schema — it is a composition:
 * the paid-access composite says DENIED right now, but this user demonstrably
 * held paid access at some point. `personal_plans.active_routine_version_id` is
 * the conservative proof of that second half: a Routine version can only become
 * *active* through Stage 4 acceptance, which is reachable only for an owner whose
 * journey access resolved to `personal_plan` — i.e. `accessState === "active"`
 * plus a prepared source (see `journey-access-loader.ts`). A never-paid freemium
 * user has no `personal_plans` row at all (T14's `freemium_plan_admissions` is
 * written only at VERIFIED purchase activation), so this signal cannot promote
 * one into keepsake reads.
 *
 * A pending proposal is deliberately NOT accepted as evidence: it is an unaccepted
 * suggestion, not something the user ever owned, and T17's promise is "nothing you
 * already had is taken away", not "a draft becomes readable forever".
 *
 * Reads throw on a query error rather than resolving to `null`. Callers fail
 * closed by catching — a keepsake lookup that cannot be trusted degrades to
 * today's free-tier behaviour (the T12 „Beispiel" page), never to a wrongly
 * unlocked surface.
 */
export type PersonalPlanKeepsakeContent = {
  personalPlanId: string
  activeRoutineVersionId: string
}

type KeepsakeQuery = {
  select: (columns: string) => KeepsakeQuery
  eq: (column: string, value: unknown) => KeepsakeQuery
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>
}

export type PersonalPlanKeepsakeReadClient = {
  from: (table: "personal_plans") => KeepsakeQuery
}

/**
 * PR5 review fix (Z2, controller ruling) — the CLASSIFIER's evidence, wider than the
 * content read above.
 *
 * Requiring `active_routine_version_id` conflated "held paid access" with "accepted a
 * Routine". Paid scanning, saving and chat never required an accepted Routine, so two real
 * cohorts lapsed into the never-paid bucket and lost reads they had paid for: legacy
 * subscribers from before the Personal Plan, and buyers whose provisioning stopped short of
 * Stage-4 acceptance. Their Merkliste GET 403'd and their chat showed the „Beispiel" page
 * instead of their own history.
 *
 * Evidence is now composite-denied PLUS any PAID-ERA ARTIFACT — each of these could only
 * ever have been created while the user held paid access:
 * - a PAID-ORIGIN `personal_plans` row (enrollment/plan evidence),
 * - their own `scan_wishlist` rows (every write path is premium-gated: the save endpoint,
 *   and T16's auto-save which only runs on a premium resolve),
 * - their own chat conversations (the chat surface is premium; a free user gets the T12
 *   „Beispiel" chat, which writes nothing).
 *
 * PAID-ORIGIN IS NOT "HAS A ROW" (PR6 Codex review, finding V5 — cross-PR)
 * -----------------------------------------------------------------------
 * The original wording assumed a never-paid freemium user has no `personal_plans` row at
 * all. T18's free registration falsifies that: `/auth/confirm` provisions the free initial
 * snapshot, and `personal_plan_create_or_reuse_initial_need` CREATES the plan row on that
 * first write. A brand-new free registrant therefore classified as LAPSED and was served
 * keepsake views plus „Noch keine Routine" instead of the approved Beispiel pages and
 * upgrade CTAs.
 *
 * The discriminator is `enrollment_purchase_source_id`, which that same RPC pins on the
 * FIRST write for a user and never moves on its own: the free path pins it to `null`
 * (`free-snapshot-service.ts`'s ownership contract) and every paid path carries a real
 * enrollment id — T14's freemium admission explicitly moves the column off `null` before
 * calling the RPC (`freemium/plan-provisioning.ts` step 2, the "pin"), and the launch,
 * migration and field-test paths supply their own source ids. So `IS NOT NULL` is exactly
 * "this plan was admitted by a purchase", which is what this probe is asking.
 *
 * Each check is an owner-scoped existence probe (one column, `limit(1)`), evaluated in
 * cheapest-first order and short-circuiting on the first hit — a premium user never runs
 * any of them (`resolveAuthenticatedAppAccessState` asks only after the composite denied).
 *
 * Cost if this is ever wrong in the generous direction: a misclassified free user reads
 * their own (empty) keepsakes. Every MUTATION keeps its unchanged premium guard, so this
 * cannot hand anyone a write. Errors still propagate: callers catch and fall back to
 * today's behaviour, never to a wrongly unlocked surface.
 */
type KeepsakeEvidenceTable = "personal_plans" | "scan_wishlist" | "conversations"

type KeepsakeEvidenceQuery = {
  select: (columns: string) => KeepsakeEvidenceQuery
  eq: (column: string, value: unknown) => KeepsakeEvidenceQuery
  not: (column: string, operator: string, value: unknown) => KeepsakeEvidenceQuery
  limit: (count: number) => KeepsakeEvidenceQuery
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>
}

export type PersonalPlanKeepsakeEvidenceReadClient = {
  from: (table: KeepsakeEvidenceTable) => KeepsakeEvidenceQuery
}

/** The paid-era artifacts, cheapest first. `id` alone — nothing here reads content. */
const KEEPSAKE_EVIDENCE_PROBES: readonly {
  table: KeepsakeEvidenceTable
  /** V5: a `personal_plans` row only counts when a purchase admitted it. */
  paidOriginOnly?: true
}[] = [
  { table: "personal_plans", paidOriginOnly: true },
  { table: "scan_wishlist" },
  { table: "conversations" },
]

export async function hasPersonalPlanKeepsakeEvidence(
  client: PersonalPlanKeepsakeEvidenceReadClient,
  userId: string,
): Promise<boolean> {
  for (const probe of KEEPSAKE_EVIDENCE_PROBES) {
    let query = client.from(probe.table).select("id").eq("user_id", userId)
    if (probe.paidOriginOnly) query = query.not("enrollment_purchase_source_id", "is", null)
    const { data, error } = await query.limit(1).maybeSingle()
    if (error) throw error
    if (data) return true
  }
  return false
}

export function hasPersonalPlanKeepsakeEvidenceForUser(userId: string): Promise<boolean> {
  return hasPersonalPlanKeepsakeEvidence(
    createAdminClient() as unknown as PersonalPlanKeepsakeEvidenceReadClient,
    userId,
  )
}

export async function loadPersonalPlanKeepsakeContent(
  client: PersonalPlanKeepsakeReadClient,
  userId: string,
): Promise<PersonalPlanKeepsakeContent | null> {
  const { data, error } = await client
    .from("personal_plans")
    .select("id,active_routine_version_id")
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw error
  return parsePersonalPlanKeepsakeContent(data)
}

export function parsePersonalPlanKeepsakeContent(
  value: unknown,
): PersonalPlanKeepsakeContent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== "string" || typeof row.active_routine_version_id !== "string") return null
  return { personalPlanId: row.id, activeRoutineVersionId: row.active_routine_version_id }
}

export function loadPersonalPlanKeepsakeContentForUser(
  userId: string,
): Promise<PersonalPlanKeepsakeContent | null> {
  return loadPersonalPlanKeepsakeContent(
    createAdminClient() as unknown as PersonalPlanKeepsakeReadClient,
    userId,
  )
}
