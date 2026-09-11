import "server-only"

import { hasCurrentPaidAppAccess } from "@/lib/billing/subscriptions"
import type { SupabaseBillingClient } from "@/lib/billing/types"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"

/**
 * Freemium enrollment admission (freemium-scanner-first T14) — the second way a Personal
 * Plan can be owned, sitting BESIDE the `personal_plan_launch_v1` path in
 * `enrollment.ts` rather than modifying it.
 *
 * The launch path admits a LAUNCH-catalog subscription correlated through `funnel_sessions`
 * to one exact quiz lead. A Premium-sheet purchase has neither half of that: it is a
 * STANDARD-catalog subscription (T13's pinning), and it happens inside the app, long after
 * the quiz, with no offer funnel session. So admission is an explicit record —
 * `public.freemium_plan_admissions`, written once at verified activation — and this
 * resolver turns that record into the same `PersonalPlanEnrollment` shape.
 *
 * **Deploy order: the migration ships BEFORE the flag is turned on.** A missing
 * `freemium_plan_admissions` relation throws out of here rather than resolving to "no
 * admission" — same posture as the field-test reader in `enrollment.ts`. Silently reading a
 * schema error as "this user owns no plan" would revoke a real buyer's Routine, which is
 * strictly worse than failing loudly. With the flag off nothing reads the table at all, so
 * the safe sequence is: apply the migration, verify, then flip
 * `FREEMIUM_SCANNER_FIRST_ENABLED`.
 *
 * **The record binds the source; it never grants access.** Exactly like the migration
 * admission it is modelled on, current paid authority is rechecked on every read, so a
 * cancelled subscription stops resolving here (and resumes, with the SAME enrollment id,
 * if the person resubscribes — which is what keeps the pinned
 * `personal_plans.enrollment_purchase_source_id` valid across a lapse).
 */

export type FreemiumPlanAdmissionRow = {
  /** The plan's enrollment source id — what `enrollment_purchase_source_id` is pinned to. */
  id: string
  userId: string
  provider: "stripe" | "paypal"
  providerReference: string
  leadId: string
  admittedAt: string
}

type AdmissionQuery = {
  select: (columns: string) => AdmissionQuery
  eq: (column: string, value: unknown) => AdmissionQuery
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>
}

export type FreemiumAdmissionReadClient = {
  from: (table: "freemium_plan_admissions") => AdmissionQuery
}

export const FREEMIUM_PLAN_ADMISSIONS_TABLE = "freemium_plan_admissions" as const

/** Reads the user's admission row, or `null` when they have none. */
export async function findFreemiumPlanAdmission(
  client: FreemiumAdmissionReadClient,
  userId: string,
): Promise<FreemiumPlanAdmissionRow | null> {
  const { data, error } = await client
    .from(FREEMIUM_PLAN_ADMISSIONS_TABLE)
    .select("id, user_id, provider, provider_reference, lead_id, admitted_at")
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw error
  return parseFreemiumPlanAdmission(data)
}

export function parseFreemiumPlanAdmission(value: unknown): FreemiumPlanAdmissionRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const provider = row.provider
  if (
    typeof row.id !== "string" ||
    typeof row.user_id !== "string" ||
    (provider !== "stripe" && provider !== "paypal") ||
    typeof row.provider_reference !== "string" ||
    typeof row.lead_id !== "string" ||
    typeof row.admitted_at !== "string"
  ) {
    return null
  }
  return {
    id: row.id,
    userId: row.user_id,
    provider,
    providerReference: row.provider_reference,
    leadId: row.lead_id,
    admittedAt: row.admitted_at,
  }
}

export type FreemiumEnrollmentResolution = {
  /** Stable plan-source identity: the admission row's own id. */
  sourceId: string
  admittedAt: string
  leadId: string
}

export type ResolveFreemiumEnrollmentDeps = {
  flagEnabled?: () => boolean
  findAdmission?: typeof findFreemiumPlanAdmission
  hasPaidAccess?: typeof hasCurrentPaidAppAccess
}

/**
 * `null` means "this user is not a freemium plan owner right now" — flag off, no admission
 * record, or the purchase behind it is no longer current. Callers fall through to the other
 * enrollment sources unchanged.
 */
export async function resolveFreemiumPlanEnrollment(
  supabase: SupabaseBillingClient,
  userId: string,
  now: Date = new Date(),
  deps: ResolveFreemiumEnrollmentDeps = {},
): Promise<FreemiumEnrollmentResolution | null> {
  const flagEnabled = deps.flagEnabled ?? isFreemiumScannerFirstEnabled
  // Inert with the flag off: no admission row can exist, and nothing may read as if one did.
  if (!flagEnabled()) return null

  const findAdmission = deps.findAdmission ?? findFreemiumPlanAdmission
  const admission = await findAdmission(supabase as unknown as FreemiumAdmissionReadClient, userId)
  if (!admission) return null

  // The record is provenance, not entitlement — recheck the purchase is still current.
  const hasPaidAccess = deps.hasPaidAccess ?? hasCurrentPaidAppAccess
  if (!(await hasPaidAccess(supabase, { userId }, now))) return null

  return {
    // The plan source is the ADMISSION, not the provider reference: a subscription id
    // changes when a lapsed buyer resubscribes, and `enrollment_purchase_source_id` is
    // pinned for the life of the plan.
    sourceId: admission.id,
    admittedAt: admission.admittedAt,
    leadId: admission.leadId,
  }
}
