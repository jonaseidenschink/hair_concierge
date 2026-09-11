import { computeNeedPlan } from "../compute-stage1"
import {
  PERSONAL_PLAN_STAGE1_COMPUTATION_VERSION,
  type CreateInitialNeedResult,
  type Stage1PreparedArtifact,
} from "./stage1-service"
import { hashPersonalPlanNeedVersionInput, type JsonValue } from "./index"

/**
 * Ownership contract — free-tier `personal_plan_need_versions` (kind = "initial").
 *
 * - **Who creates it:** this service, for signed-in users with NO Personal Plan
 *   entitlement (no enrollment/source/qualification/lead). `stage1-service.ts`
 *   remains the sole writer for the paid/enrolled path and is untouched by this
 *   module. Call this service ONLY at free registration (T18) — it is not safe
 *   to invoke opportunistically for an arbitrary signed-in user (see the
 *   guard below and the no-ordering-guarantee note).
 * - **No ordering guarantee — a collision is a permanent failure, not a race
 *   that resolves:** the underlying `personal_plan_create_or_reuse_initial_need`
 *   RPC pins a plan's `enrollment_purchase_source_id` on whichever call reaches
 *   it FIRST for a given user (`null` from this free path, or a real enrollment
 *   id from the paid path) and rejects every later call whose value differs
 *   (`invalid_source` / `enrollment_mismatch`). This does not prevent a
 *   collision — it converts one into a permanent failure for the path that
 *   loses the race: if this free service ever runs first for a user who then
 *   buys, the paid path's later calls to the same RPC will keep returning
 *   `invalid_source`/`enrollment_mismatch` indefinitely, because nothing here
 *   moves `enrollment_purchase_source_id` off `null`. Fixing that requires an
 *   explicit upgrade/admission step that reassigns the pinned column (tracked
 *   for T14/T18) — it does not self-heal and is not attempted by this module.
 * - **Guard — free provisioning refuses a paid, moderator, or field-test
 *   user:** because a collision is permanent rather than recoverable,
 *   `provisionFreeInitialSnapshot` checks the injected `resolvePaidAccess`
 *   signal before doing anything else. This is the FULL flag-independent
 *   paid-access composite `src/lib/entitlements/access.ts` exports as
 *   `resolvePaidAppAccess` (the same one `hasFreemiumPaidAccess` runs once its
 *   flag check passes) — billing subscription OR active one-time purchase OR
 *   legacy-profile access OR an email-keyed manual access grant OR active
 *   moderator/field-test roster access. A moderator/field-test user gets a
 *   REAL non-null `enrollment_purchase_source_id` through the paid path
 *   (`sourceKind: "field_test"`, activated via
 *   `src/lib/personal-plan-field-test/`), so missing that branch here would
 *   pin this free path's `null` first and permanently collide with theirs —
 *   the exact failure this guard exists to prevent, not just under a lookup
 *   failure.
 *   - `"allowed"` → the typed `"paid_user"` outcome, without touching the
 *     artifact or the RPC.
 *   - `"unavailable"` (the moderator lookup couldn't be read and there is no
 *     independently verified paid entitlement to fall back on) → the typed
 *     `"temporarily_unavailable"` outcome. Fail CLOSED here: an unreadable
 *     moderator lookup must never be treated as "not paid", because a real
 *     moderator/field-test user behind that outage would otherwise get
 *     provisioned free and permanently collide with their real enrollment id.
 *   - `"denied"` → proceeds to provisioning as normal.
 *   This is a defensive backstop against a misrouted call, not the primary
 *   control — the primary control is that this service is only ever invoked
 *   from the free-registration path.
 * - **Source:** the user's linked `personal_plan_prepared_artifacts` row
 *   (`status = 'attached'`, `user_id` = the signed-in user) — the same artifact
 *   `src/lib/quiz/link-to-profile.ts` attaches after quiz completion, regardless
 *   of payment. There is no enrollment/qualification gate here by design: a free
 *   account only needs a completed quiz, not a purchase.
 * - **Derivation:** delegates to the exact same pure `computeNeedPlan` (and the
 *   same `PERSONAL_PLAN_STAGE1_COMPUTATION_VERSION`) that `stage1-service.ts`
 *   uses for the paid path. Nothing about the math is forked here.
 * - **When re-provisioned, and only while the input hash is unchanged:** every
 *   call re-derives from the current artifact and re-submits it. The RPC is
 *   idempotent on `(personal_plan_id, input_hash)` for `kind = 'initial'` rows,
 *   so as long as the derived input hash matches the existing row, calling this
 *   on every scan attempt is a true no-op (no duplicate row, no
 *   `personal_plans.revision` bump). That guarantee does NOT extend to a
 *   changed input hash: if the linked artifact changes between calls, the RPC
 *   treats it as a new initial-need write and runs its normal staleness side
 *   effects — any `in_progress` refinement draft and `active` product draft for
 *   the plan are marked `stale`, `current_refined_need_version_id` is nulled,
 *   and `personal_plans.revision` is bumped. Callers must not assume repeated
 *   calls are side-effect-free in general — only that same-hash calls are.
 * - **Upgrade note (out of scope here, relevant to T14/T18):** because the RPC
 *   pins `enrollment_purchase_source_id` on first write, a user provisioned free
 *   (`null`) who later buys must go through an upgrade path that can move that
 *   column off `null` — calling this same RPC with a real enrollment id for such
 *   a user will currently return `invalid_source` (`enrollment_mismatch`).
 */

export type FreeInitialNeedRequest = {
  userId: string
  preparedArtifactSourceId: string
  schemaVersion: number
  computationVersion: string
  inputHash: string
  inputSnapshot: JsonValue
  outputSnapshot: JsonValue
}

export type ProvisionFreeInitialSnapshotResult =
  | {
      outcome: "provisioned"
      personalPlanId: string
      needVersionId: string
      outputSnapshot: JsonValue
    }
  | { outcome: "no_quiz_artifact" }
  | { outcome: "invalid_source"; reasonCode?: string }
  | { outcome: "paid_user" }
  | { outcome: "temporarily_unavailable" }

/** Mirrors `FreemiumAccessResult` from `src/lib/entitlements/access.ts`
 * without importing it, so this service file stays free of any runtime
 * dependency on the entitlements module. */
export type PaidAccessResolution = "allowed" | "denied" | "unavailable"

export type FreeSnapshotDependencies = {
  loadLinkedQuizArtifact: (userId: string) => Promise<Stage1PreparedArtifact | null>
  createOrReuseInitialNeed: (request: FreeInitialNeedRequest) => Promise<CreateInitialNeedResult>
  /**
   * The defensive guard's paid-access check (see the ownership contract
   * above). Injected rather than resolved here so the service stays pure and
   * unit-testable — `free-snapshot-supabase.ts` wires this to
   * `resolvePaidAppAccess` from `src/lib/entitlements/access.ts`, the FULL
   * flag-independent composite (billing/one-time/legacy-profile access, an
   * email-keyed manual grant, or active moderator/field-test roster access),
   * threading both `userId` and `email` the way the scan route guards do.
   */
  resolvePaidAccess: (
    userId: string,
    email: string | null | undefined,
  ) => Promise<PaidAccessResolution>
  now?: () => Date
}

export function createFreeSnapshotService(deps: FreeSnapshotDependencies) {
  return {
    async provisionFreeInitialSnapshot({
      userId,
      email,
    }: {
      userId: string
      email?: string | null
    }): Promise<ProvisionFreeInitialSnapshotResult> {
      let paidAccess: PaidAccessResolution
      try {
        paidAccess = await deps.resolvePaidAccess(userId, email)
      } catch {
        return { outcome: "temporarily_unavailable" }
      }
      // Fail closed on "unavailable": an unreadable moderator lookup must
      // never be treated as "not paid" — see the ownership-contract guard
      // note above.
      if (paidAccess === "unavailable") return { outcome: "temporarily_unavailable" }
      if (paidAccess === "allowed") return { outcome: "paid_user" }

      let artifact: Stage1PreparedArtifact | null
      try {
        artifact = await deps.loadLinkedQuizArtifact(userId)
      } catch {
        return { outcome: "temporarily_unavailable" }
      }
      if (!artifact) return { outcome: "no_quiz_artifact" }

      const computed = computeNeedPlan({
        rawEnvelope: artifact.quizAnswers,
        artifactId: artifact.id,
        projection: "initial_quiz",
        computationVersion: PERSONAL_PLAN_STAGE1_COMPUTATION_VERSION,
        createdAt: (deps.now ?? (() => new Date()))().toISOString(),
      })
      if (computed.status !== "ready") return { outcome: "invalid_source" }

      const inputSnapshot = computed.snapshot.sourceQuiz as unknown as JsonValue
      const outputSnapshot = computed.snapshot as unknown as JsonValue
      const request: FreeInitialNeedRequest = {
        userId,
        preparedArtifactSourceId: artifact.id,
        schemaVersion: computed.snapshot.schemaVersion,
        computationVersion: computed.snapshot.computationVersion,
        inputHash: hashPersonalPlanNeedVersionInput({
          schemaVersion: computed.snapshot.schemaVersion,
          computationVersion: computed.snapshot.computationVersion,
          inputSnapshot,
        }),
        inputSnapshot,
        outputSnapshot,
      }

      let result: CreateInitialNeedResult
      try {
        result = await deps.createOrReuseInitialNeed(request)
      } catch {
        return { outcome: "temporarily_unavailable" }
      }
      if (result.outcome === "completed") {
        return {
          outcome: "provisioned",
          personalPlanId: result.personalPlanId,
          needVersionId: result.needVersionId,
          outputSnapshot: result.outputSnapshot,
        }
      }
      return result
    },
  }
}
