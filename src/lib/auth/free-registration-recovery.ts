import { createAdminClient } from "@/lib/supabase/admin"
import { reportFreeProvisioningOutcome } from "@/lib/observability/free-registration"
import type { ProvisionFreeInitialSnapshotResult } from "@/lib/personal-plan/persistence/free-snapshot-service"
import { provisionFreeInitialSnapshotForUser } from "@/lib/personal-plan/persistence/free-snapshot-supabase"

/**
 * The two outcomes `free-snapshot-service.ts` signals that can never self-heal
 * on retry: `no_quiz_artifact` (no linked quiz artifact to derive from) and
 * `invalid_source` (`computeNeedPlan` refused the one that exists). Neither
 * condition changes between renders, unlike `temporarily_unavailable`, which
 * is a real outage the next visit can still recover from.
 */
export type FreeProvisioningTerminalOutcome = Extract<
  ProvisionFreeInitialSnapshotResult["outcome"],
  "no_quiz_artifact" | "invalid_source"
>

function isTerminalProvisioningOutcome(
  outcome: ProvisionFreeInitialSnapshotResult["outcome"],
): outcome is FreeProvisioningTerminalOutcome {
  return outcome === "no_quiz_artifact" || outcome === "invalid_source"
}

/**
 * The retry surface for a free account whose confirm-time provisioning failed
 * (T18 fix round 1, review finding W2).
 *
 * Before this existed, a typed provisioning failure at `/auth/confirm` was a
 * PERMANENT dead end: the lead was already claimed, so `/api/auth/free-registration`
 * answered 409, no other surface provisioned, and the user sat on a scanner that
 * said „Für den Scan brauchen wir zuerst deine Haaranalyse" thirty seconds after
 * completing it. The confirm route's comment claimed „the next confirm/visit can
 * provision idempotently"; this module is what makes that true.
 *
 * Deliberately narrow, because `free-snapshot-service.ts`'s ownership contract
 * forbids opportunistic invocation for an arbitrary signed-in user. It runs only
 * when ALL of these hold:
 *  - the freemium flag is on (checked by the caller — `/scan`'s server page);
 *  - the caller resolved the page tier to `"free"`, i.e. the same email-aware
 *    paid-access composite the scan APIs enforce with already DENIED paid access
 *    (that composite failing resolves `"premium"`, so an outage never reaches
 *    here);
 *  - the account has no initial need version yet — the precise condition the
 *    scanner's `profile_missing` reports;
 *  - the account's lead has not already been marked with a TERMINAL outcome
 *    (fix round 2, review finding N3 — see below).
 * The service then re-runs its own paid/moderator guard before writing anything.
 *
 * Every non-success outcome is reported, so a repeatedly failing account is
 * visible rather than silently stuck. `no_quiz_artifact`/`invalid_source` are
 * PERMANENT for a given quiz artifact — retrying them on every `/scan` render
 * bought nothing but an unbounded stream of Sentry `error`s, one per render,
 * forever. The first time either occurs here, this persists a durable marker
 * on the account's claimed `leads` row (see the migration comment for why that
 * row) and every later render short-circuits before calling `provision` or
 * `report` at all — one `error`, not one per render. A write failure is
 * swallowed: the worst case is one more retry (and one more reported error)
 * next render, never a broken page.
 */
export async function recoverMissingFreeSnapshot(input: {
  userId: string
  email?: string | null
  admin?: RecoveryAdmin
  hasInitialNeed?: (userId: string) => Promise<boolean>
  loadTerminalOutcome?: (userId: string) => Promise<FreeProvisioningTerminalOutcome | null>
  markTerminalOutcome?: (userId: string, outcome: FreeProvisioningTerminalOutcome) => Promise<void>
  provision?: (input: {
    userId: string
    email?: string | null
  }) => Promise<ProvisionFreeInitialSnapshotResult>
  report?: typeof reportFreeProvisioningOutcome
}): Promise<"not_needed" | "attempted" | "terminal"> {
  const hasInitialNeed =
    input.hasInitialNeed ?? ((userId: string) => hasInitialNeedVersion(userId, input.admin))
  if (await hasInitialNeed(input.userId)) return "not_needed"

  const loadTerminalOutcome =
    input.loadTerminalOutcome ?? ((userId: string) => loadLeadTerminalOutcome(userId, input.admin))
  if (await loadTerminalOutcome(input.userId)) return "terminal"

  const provision = input.provision ?? provisionFreeInitialSnapshotForUser
  const result = await provision({
    userId: input.userId,
    ...(input.email ? { email: input.email } : {}),
  })
  const report = input.report ?? reportFreeProvisioningOutcome
  report(result, { stage: "scan_retry", userId: input.userId })

  if (isTerminalProvisioningOutcome(result.outcome)) {
    const markTerminalOutcome =
      input.markTerminalOutcome ??
      ((userId: string, outcome: FreeProvisioningTerminalOutcome) =>
        markLeadTerminalOutcome(userId, outcome, input.admin))
    try {
      await markTerminalOutcome(input.userId, result.outcome)
    } catch {
      /* Best-effort marker — a failed write just means one more retry (and one
         more reported error) on the next render, never a broken page. */
    }
  }

  return "attempted"
}

/**
 * One cheap read — the same `personal_plans` row `loadScanEvaluationContext`
 * starts from — so a healthy free account pays a single indexed lookup per
 * `/scan` render and never re-enters the provisioning path.
 */
async function hasInitialNeedVersion(userId: string, injected?: RecoveryAdmin): Promise<boolean> {
  const admin = injected ?? (createAdminClient() as unknown as RecoveryAdmin)
  const { data, error } = await admin
    .from("personal_plans")
    .select("current_initial_need_version_id, current_refined_need_version_id")
    .eq("user_id", userId)
    .maybeSingle()
  // Fail "already provisioned" on an unreadable lookup: never provision on a
  // signal we could not read (same fail-closed rule the service itself uses).
  if (error) return true
  if (!data || typeof data !== "object") return false
  const row = data as {
    current_initial_need_version_id?: unknown
    current_refined_need_version_id?: unknown
  }
  return Boolean(row.current_initial_need_version_id ?? row.current_refined_need_version_id)
}

/**
 * The claimed `leads` row for this account's personal-plan quiz — the home
 * for the terminal marker (fix round 2, N3; see the migration comment for why
 * this table over a bare `personal_plans` row). Looked up by `user_id`
 * because that is all either caller (`/auth/confirm`, `/scan`) is guaranteed
 * to have; `20260910091500_leads_free_provisioning_terminal_outcome.sql`
 * indexes it so this stays one cheap read, not a table scan.
 */
async function loadLeadTerminalOutcome(
  userId: string,
  injected?: RecoveryAdmin,
): Promise<FreeProvisioningTerminalOutcome | null> {
  const admin = injected ?? (createAdminClient() as unknown as RecoveryAdmin)
  const { data, error } = await admin
    .from("leads")
    .select("free_provisioning_terminal_outcome")
    .eq("user_id", userId)
    .eq("quiz_kind", "personal_plan")
    .maybeSingle()
  // Fail OPEN on an unreadable lookup: a read error is evidence of nothing.
  // Treating it as "terminal" would silently and permanently stop retrying a
  // recoverable account; treating it as "not terminal" costs at most one more
  // attempt (and one more reported error) this render — the same trade-off
  // `recoverMissingFreeSnapshot`'s own swallowed write failure makes.
  if (error || !data || typeof data !== "object") return null
  const value = (data as { free_provisioning_terminal_outcome?: unknown })
    .free_provisioning_terminal_outcome
  return value === "no_quiz_artifact" || value === "invalid_source" ? value : null
}

/** Best-effort write of the terminal marker onto the same claimed lead row. */
async function markLeadTerminalOutcome(
  userId: string,
  outcome: FreeProvisioningTerminalOutcome,
  injected?: RecoveryAdmin,
): Promise<void> {
  const admin = injected ?? (createAdminClient() as unknown as RecoveryAdmin)
  const { error } = await admin
    .from("leads")
    .update({ free_provisioning_terminal_outcome: outcome })
    .eq("user_id", userId)
    .eq("quiz_kind", "personal_plan")
  if (error) throw new Error(`leads terminal-outcome write failed: ${String(error)}`)
}

type RecoverySelectQuery = {
  select: (columns: string) => RecoverySelectQuery
  eq: (column: string, value: string) => RecoverySelectQuery
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>
}

type RecoveryUpdateQuery = {
  eq: (column: string, value: string) => RecoveryUpdateQuery
} & PromiseLike<{ error: unknown }>

type RecoveryLeadsQuery = RecoverySelectQuery & {
  update: (values: Record<string, unknown>) => RecoveryUpdateQuery
}

type RecoveryAdmin = {
  from(table: "personal_plans"): RecoverySelectQuery
  from(table: "leads"): RecoveryLeadsQuery
}
