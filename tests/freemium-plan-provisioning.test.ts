import assert from "node:assert/strict"
import test from "node:test"

import { STAGE1_STAGE2_LAB_ENVELOPE } from "../src/app/labs/personal-plan-stage-1-2/fixture"
import {
  createFreemiumProvisioningService,
  type AcceptInitialRoutineResult,
  type FreemiumProvisioningDependencies,
  type PinEnrollmentSourceResult,
} from "../src/lib/freemium/plan-provisioning"
import { classifyRoutineAcceptanceFailure } from "../src/lib/freemium/plan-provisioning-supabase"
import { DirectAcceptanceError } from "../src/lib/personal-plan/direct-acceptance/accept"
import type { CreateInitialNeedResult } from "../src/lib/personal-plan/persistence/stage1-service"

/**
 * Post-purchase provisioning, with the database replaced by a fake that reimplements the
 * TWO rules that actually decide whether a Premium-sheet buyer gets a plan:
 *
 *  1. `personal_plan_create_or_reuse_initial_need` pins
 *     `personal_plans.enrollment_purchase_source_id` on the first write and afterwards
 *     REJECTS any call whose value differs (`invalid_source` / `enrollment_mismatch`) —
 *     verbatim from the migration
 *     (20260828104243_personal_plan_paid_migration_admission.sql, lines 687-692).
 *  2. The initial need row is deduped on `(personal_plan_id, input_hash)` for
 *     `kind = 'initial'`.
 *
 * Rule 1 is the T6 carry-forward: T6's free path wrote `null` there, so without an explicit
 * pin-moving step every plan write for a converting free user fails permanently. The
 * "without the pin" test below is the red half of that — it proves the fake really does
 * reject, so the green half cannot pass vacuously.
 */

const USER = "user-1"
const ARTIFACT = "artifact-1"
const LEAD = "lead-1"
const ADMISSION = "admission-1"

type FakeState = {
  admissions: Map<
    string,
    { id: string; provider: string; providerReference: string; leadId: string }
  >
  plan: { id: string; enrollmentPurchaseSourceId: string | null } | null
  needVersions: { personalPlanId: string; inputHash: string; id: string }[]
  acceptCalls: number
  admissionInserts: number
}

function freshState(
  plan: FakeState["plan"] = { id: "plan-1", enrollmentPurchaseSourceId: null },
): FakeState {
  return {
    admissions: new Map(),
    plan,
    needVersions: [],
    acceptCalls: 0,
    admissionInserts: 0,
  }
}

function fakeDeps(
  state: FakeState,
  overrides: Partial<FreemiumProvisioningDependencies> = {},
): FreemiumProvisioningDependencies {
  return {
    loadLinkedQuizArtifact: async () => ({
      id: ARTIFACT,
      leadId: LEAD,
      quizAnswers: STAGE1_STAGE2_LAB_ENVELOPE,
    }),
    ensureAdmission: async ({ userId, provider, providerReference, leadId }) => {
      const existing = state.admissions.get(userId)
      if (existing) return { id: existing.id }
      state.admissionInserts += 1
      const row = { id: ADMISSION, provider, providerReference, leadId }
      state.admissions.set(userId, row)
      return { id: row.id }
    },
    pinEnrollmentSource: async ({ enrollmentSourceId }): Promise<PinEnrollmentSourceResult> => {
      if (!state.plan) return "no_plan"
      if (state.plan.enrollmentPurchaseSourceId === null) {
        state.plan.enrollmentPurchaseSourceId = enrollmentSourceId
        return "pinned"
      }
      return state.plan.enrollmentPurchaseSourceId === enrollmentSourceId
        ? "already_pinned"
        : "conflict"
    },
    createOrReuseInitialNeed: async (request): Promise<CreateInitialNeedResult> => {
      // Rule 1, verbatim.
      state.plan ??= {
        id: "plan-1",
        enrollmentPurchaseSourceId: request.enrollmentPurchaseSourceId,
      }
      if (state.plan.enrollmentPurchaseSourceId !== request.enrollmentPurchaseSourceId) {
        return { outcome: "invalid_source", reasonCode: "enrollment_mismatch" }
      }
      // Rule 2.
      const existing = state.needVersions.find(
        (row) => row.personalPlanId === state.plan!.id && row.inputHash === request.inputHash,
      )
      const needVersionId = existing?.id ?? `need-${state.needVersions.length + 1}`
      if (!existing) {
        state.needVersions.push({
          personalPlanId: state.plan.id,
          inputHash: request.inputHash,
          id: needVersionId,
        })
      }
      return {
        outcome: "completed",
        personalPlanId: state.plan.id,
        needVersionId,
        outputSnapshot: request.outputSnapshot as never,
      }
    },
    acceptInitialRoutine: async (): Promise<AcceptInitialRoutineResult> => {
      state.acceptCalls += 1
      return state.acceptCalls === 1 ? "accepted" : "already_accepted"
    },
    ...overrides,
  }
}

function provision(deps: FreemiumProvisioningDependencies) {
  return createFreemiumProvisioningService(deps).provisionAfterPurchase({
    userId: USER,
    provider: "stripe",
    providerReference: "cs_test_1",
  })
}

test("a converting free user's plan is re-pinned off null, then derived and accepted", async () => {
  const state = freshState()
  const result = await provision(fakeDeps(state))

  assert.equal(result.outcome, "provisioned")
  if (result.outcome !== "provisioned") throw new Error("unreachable")
  assert.equal(result.enrollmentSourceId, ADMISSION)
  assert.equal(result.routineAccepted, true)
  assert.equal(state.plan?.enrollmentPurchaseSourceId, ADMISSION)
  assert.equal(state.needVersions.length, 1)
})

test("WITHOUT the pin step the same call fails enrollment_mismatch — the T6 carry-forward, red", async () => {
  const state = freshState()
  const result = await provision(
    // The only change: provisioning does not move the pin, exactly as it stood before T14.
    fakeDeps(state, { pinEnrollmentSource: async () => "no_plan" }),
  )

  assert.deepEqual(result, { outcome: "enrollment_conflict", reasonCode: "enrollment_mismatch" })
  assert.equal(state.needVersions.length, 0)
})

test("replaying provisioning is a no-op: one admission, one need version, no second accept", async () => {
  const state = freshState()
  const first = await provision(fakeDeps(state))
  const second = await provision(fakeDeps(state))

  assert.equal(first.outcome, "provisioned")
  assert.equal(second.outcome, "provisioned")
  if (first.outcome !== "provisioned" || second.outcome !== "provisioned") {
    throw new Error("unreachable")
  }
  assert.equal(first.enrollmentSourceId, second.enrollmentSourceId)
  assert.equal(first.needVersionId, second.needVersionId)
  assert.equal(state.admissionInserts, 1)
  assert.equal(state.needVersions.length, 1)
  // The second accept is the already-accepted branch, and still reports the routine ready.
  assert.equal(second.routineAccepted, true)
})

test("a plan already owned by another enrollment is never overwritten", async () => {
  const state = freshState({ id: "plan-1", enrollmentPurchaseSourceId: "field-test-enrollment" })
  const result = await provision(fakeDeps(state))

  assert.deepEqual(result, {
    outcome: "enrollment_conflict",
    reasonCode: "plan_owned_by_other_source",
  })
  assert.equal(state.plan?.enrollmentPurchaseSourceId, "field-test-enrollment")
  assert.equal(state.needVersions.length, 0)
})

test("a buyer with no plan row yet is admitted and the plan is created pinned", async () => {
  const state = freshState(null)
  const result = await provision(fakeDeps(state))

  assert.equal(result.outcome, "provisioned")
  assert.equal(state.plan?.enrollmentPurchaseSourceId, ADMISSION)
})

test("no attached quiz artifact means no admission is written at all", async () => {
  const state = freshState()
  const result = await provision(fakeDeps(state, { loadLinkedQuizArtifact: async () => null }))

  assert.deepEqual(result, { outcome: "no_quiz_artifact" })
  assert.equal(state.admissionInserts, 0)
  assert.equal(state.plan?.enrollmentPurchaseSourceId, null)
})

test("a failed Routine acceptance still provisions — the purchase is never undone", async () => {
  const state = freshState()
  const result = await provision(
    fakeDeps(state, {
      acceptInitialRoutine: async () => {
        throw new Error("stage 3 unavailable")
      },
    }),
  )

  assert.equal(result.outcome, "provisioned")
  if (result.outcome !== "provisioned") throw new Error("unreachable")
  assert.equal(result.routineAccepted, false)
  // Entitlement-bearing state is written regardless; only the Routine is missing.
  assert.equal(state.plan?.enrollmentPurchaseSourceId, ADMISSION)
  assert.equal(state.needVersions.length, 1)
})

test("an unavailable admission write reports a retryable stage, never a fake success", async () => {
  const state = freshState()
  const result = await provision(
    fakeDeps(state, {
      ensureAdmission: async () => {
        throw new Error("db down")
      },
    }),
  )

  assert.deepEqual(result, { outcome: "temporarily_unavailable", stage: "admission" })
  assert.equal(state.plan?.enrollmentPurchaseSourceId, null)
})

/* ------------------------------------------------------------------------- *
 * Y2 — a conflict is not proof that anybody succeeded.
 * ------------------------------------------------------------------------- */

test("Y2: the conflict LOSER does not claim a Routine that does not exist yet", async () => {
  // `accept.ts:430` raises `conflict` from the FIRST Stage-2 save, before any Routine
  // exists. Mapping that to „already accepted" told the loser of a two-lane race that the
  // Routine was ready while the winner was still mid-flight — or had since failed.
  let confirmations = 0
  const result = await classifyRoutineAcceptanceFailure(
    new DirectAcceptanceError("conflict"),
    async () => {
      confirmations += 1
      return false
    },
  )
  assert.equal(result, "in_progress")
  assert.equal(confirmations, 1, "readiness is confirmed against the plan, not assumed")
})

test("Y2: the conflict loser converges once the winner has committed", async () => {
  const result = await classifyRoutineAcceptanceFailure(
    new DirectAcceptanceError("conflict"),
    async () => true,
  )
  assert.equal(result, "already_accepted")
})

test("Y2: an unconfirmable read is never optimistic", async () => {
  const result = await classifyRoutineAcceptanceFailure(
    new DirectAcceptanceError("refinement_in_progress"),
    async () => null,
  )
  assert.equal(result, "in_progress")
})

test("Y2: `plan_already_accepted` is proof on its own and needs no extra read", async () => {
  // Its guard fires only after `loadActiveRoutineVersionId` returned an id.
  let confirmations = 0
  const result = await classifyRoutineAcceptanceFailure(
    new DirectAcceptanceError("plan_already_accepted"),
    async () => {
      confirmations += 1
      return true
    },
  )
  assert.equal(result, "already_accepted")
  assert.equal(confirmations, 0)
})

test("Y2: every other acceptance failure stays unavailable", async () => {
  assert.equal(
    await classifyRoutineAcceptanceFailure(
      new DirectAcceptanceError("recommendation_unavailable"),
      async () => true,
    ),
    "unavailable",
  )
  assert.equal(
    await classifyRoutineAcceptanceFailure(new Error("boom"), async () => true),
    "unavailable",
  )
})

test("Y2: an in-flight Routine provisions the plan but never reports it ready", async () => {
  const state = freshState()
  const result = await provision(
    fakeDeps(state, { acceptInitialRoutine: async () => "in_progress" }),
  )
  assert.equal(result.outcome, "provisioned")
  if (result.outcome !== "provisioned") throw new Error("unreachable")
  assert.equal(result.routineAccepted, false)
})
