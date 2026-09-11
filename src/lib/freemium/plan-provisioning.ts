import { computeNeedPlan } from "@/lib/personal-plan/compute-stage1"
import { hashPersonalPlanNeedVersionInput, type JsonValue } from "@/lib/personal-plan/persistence"
import {
  PERSONAL_PLAN_STAGE1_COMPUTATION_VERSION,
  type CreateInitialNeedResult,
} from "@/lib/personal-plan/persistence/stage1-service"

/**
 * Post-purchase provisioning for a Premium-sheet buyer (freemium-scanner-first T14).
 *
 * The promise the journey makes is "success closes the sheet into the unlocked world […]
 * the originating gate opens with real content (provisioned routine …)". Paying alone opens
 * nothing: Stage-4/Stage-5 reachability needs a plan with an initial need version AND an
 * accepted Routine (`resolvePersonalPlanJourneyAccess`). This service is the bridge from
 * "payment verified" to those facts, in four idempotent steps.
 *
 *   1. **Admission** — one `freemium_plan_admissions` row per user, keyed to the provider
 *      purchase. Its id becomes the plan's enrollment source identity.
 *   2. **Pin** — moves `personal_plans.enrollment_purchase_source_id` from `NULL` (what T6's
 *      free-snapshot path wrote for a free user who scanned) to that admission id. **This
 *      step is the T6 carry-forward.** `personal_plan_create_or_reuse_initial_need` pins
 *      that column on the FIRST write for a user and afterwards rejects every call whose
 *      value differs with `invalid_source`/`enrollment_mismatch` — it never self-heals. So
 *      the pin has to be moved explicitly here, before step 3 calls that RPC with the real
 *      enrollment id, or every later plan write for this user fails permanently.
 *   3. **Initial need** — the same RPC the paid Stage-1 path uses, same derivation
 *      (`computeNeedPlan` at `PERSONAL_PLAN_STAGE1_COMPUTATION_VERSION`), now carrying the
 *      pinned enrollment id. Idempotent on `(personal_plan_id, input_hash)`: a user who
 *      already has the T6 free snapshot re-derives the identical hash and the RPC reuses
 *      the existing row without side effects.
 *   4. **Acceptance** — drives the existing headless Stage-2 → Stage-4 machinery
 *      (`acceptIdealPlan`, `roleSelection: "server_recommended"`) so the plan ends with an
 *      ACTIVE routine version. A repeat call lands on the already-accepted branch.
 *
 * **Provisioning must never fail the purchase.** Every step maps failure to a typed
 * outcome instead of throwing, and callers are expected to treat a degraded outcome as
 * "entitlement is live, content will follow" — the money is taken either way, and the
 * webhook lane retries the whole thing.
 */

export type FreemiumPurchaseProvider = "stripe" | "paypal"

export type FreemiumProvisioningRequest = {
  userId: string
  provider: FreemiumPurchaseProvider
  /** Stripe Checkout Session id or PayPal subscription id — the verified purchase. */
  providerReference: string
}

export type FreemiumProvisioningResult =
  | {
      outcome: "provisioned"
      enrollmentSourceId: string
      personalPlanId: string
      needVersionId: string
      /** `false` when the plan is entitled and derived but has no accepted Routine yet. */
      routineAccepted: boolean
    }
  /** No attached Personal-Plan quiz artifact — nothing to derive a plan from. */
  | { outcome: "no_quiz_artifact" }
  /** The plan is already owned by a different enrollment (field test, migration, …). */
  | { outcome: "enrollment_conflict"; reasonCode?: string }
  | { outcome: "temporarily_unavailable"; stage: FreemiumProvisioningStage }

export type FreemiumProvisioningStage = "admission" | "pin" | "initial_need" | "acceptance"

export type FreemiumPlanArtifact = {
  id: string
  leadId: string
  quizAnswers: unknown
}

export type PinEnrollmentSourceResult =
  /** The column moved from NULL to this admission id. */
  | "pinned"
  /** It already held this admission id — a replay. */
  | "already_pinned"
  /** It holds a DIFFERENT source id; this service must not overwrite it. */
  | "conflict"
  /** The user has no `personal_plans` row yet — step 3's RPC will create it pinned. */
  | "no_plan"

export type AcceptInitialRoutineResult =
  | "accepted"
  /**
   * The plan already carries an active Routine — nothing to do. Only ever returned once a
   * persisted active routine version has actually been CONFIRMED (Codex fix wave, Y2); a
   * bare acceptance conflict is not proof that anyone succeeded.
   */
  | "already_accepted"
  /**
   * A concurrent acceptance is mid-flight and no active Routine exists yet. Distinct from
   * `unavailable` (which is an error) and from `already_accepted` (which is a fact): the
   * plan is entitled and derived, the Routine is genuinely still being built, and a later
   * call converges once the winner commits.
   */
  | "in_progress"
  | "unavailable"

export type FreemiumProvisioningDependencies = {
  loadLinkedQuizArtifact: (userId: string) => Promise<FreemiumPlanArtifact | null>
  ensureAdmission: (input: {
    userId: string
    provider: FreemiumPurchaseProvider
    providerReference: string
    leadId: string
  }) => Promise<{ id: string }>
  pinEnrollmentSource: (input: {
    userId: string
    enrollmentSourceId: string
  }) => Promise<PinEnrollmentSourceResult>
  createOrReuseInitialNeed: (request: {
    userId: string
    enrollmentPurchaseSourceId: string
    preparedArtifactSourceId: string
    schemaVersion: number
    computationVersion: string
    inputHash: string
    inputSnapshot: JsonValue
    outputSnapshot: JsonValue
  }) => Promise<CreateInitialNeedResult>
  acceptInitialRoutine: (userId: string) => Promise<AcceptInitialRoutineResult>
  now?: () => Date
}

export function createFreemiumProvisioningService(deps: FreemiumProvisioningDependencies) {
  return {
    async provisionAfterPurchase(
      request: FreemiumProvisioningRequest,
    ): Promise<FreemiumProvisioningResult> {
      const { userId, provider, providerReference } = request

      let artifact: FreemiumPlanArtifact | null
      try {
        artifact = await deps.loadLinkedQuizArtifact(userId)
      } catch {
        return { outcome: "temporarily_unavailable", stage: "admission" }
      }
      // Admission names the artifact's lead because the journey loader resolves a plan
      // owner's prepared source by (user_id, lead_id), not by user alone.
      if (!artifact) return { outcome: "no_quiz_artifact" }

      let admission: { id: string }
      try {
        admission = await deps.ensureAdmission({
          userId,
          provider,
          providerReference,
          leadId: artifact.leadId,
        })
      } catch {
        return { outcome: "temporarily_unavailable", stage: "admission" }
      }

      let pinned: PinEnrollmentSourceResult
      try {
        pinned = await deps.pinEnrollmentSource({
          userId,
          enrollmentSourceId: admission.id,
        })
      } catch {
        return { outcome: "temporarily_unavailable", stage: "pin" }
      }
      if (pinned === "conflict") {
        return { outcome: "enrollment_conflict", reasonCode: "plan_owned_by_other_source" }
      }

      const computed = computeNeedPlan({
        rawEnvelope: artifact.quizAnswers,
        artifactId: artifact.id,
        projection: "initial_quiz",
        computationVersion: PERSONAL_PLAN_STAGE1_COMPUTATION_VERSION,
        createdAt: (deps.now ?? (() => new Date()))().toISOString(),
      })
      if (computed.status !== "ready") {
        return { outcome: "enrollment_conflict", reasonCode: "quiz_artifact_unusable" }
      }

      const inputSnapshot = computed.snapshot.sourceQuiz as unknown as JsonValue
      const outputSnapshot = computed.snapshot as unknown as JsonValue

      let need: CreateInitialNeedResult
      try {
        need = await deps.createOrReuseInitialNeed({
          userId,
          enrollmentPurchaseSourceId: admission.id,
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
        })
      } catch {
        return { outcome: "temporarily_unavailable", stage: "initial_need" }
      }
      if (need.outcome === "invalid_source") {
        return {
          outcome: "enrollment_conflict",
          ...(need.reasonCode ? { reasonCode: need.reasonCode } : {}),
        }
      }
      if (need.outcome !== "completed") {
        return { outcome: "temporarily_unavailable", stage: "initial_need" }
      }

      let accepted: AcceptInitialRoutineResult
      try {
        accepted = await deps.acceptInitialRoutine(userId)
      } catch {
        accepted = "unavailable"
      }

      return {
        outcome: "provisioned",
        enrollmentSourceId: admission.id,
        personalPlanId: need.personalPlanId,
        needVersionId: need.needVersionId,
        routineAccepted: accepted === "accepted" || accepted === "already_accepted",
      }
    },
  }
}
