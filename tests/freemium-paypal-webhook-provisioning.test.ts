import assert from "node:assert/strict"
import test from "node:test"

import { STAGE1_STAGE2_LAB_ENVELOPE } from "../src/app/labs/personal-plan-stage-1-2/fixture"
import {
  createFreemiumProvisioningService,
  type AcceptInitialRoutineResult,
  type FreemiumProvisioningDependencies,
  type FreemiumProvisioningResult,
  type PinEnrollmentSourceResult,
} from "../src/lib/freemium/plan-provisioning"
import type { CreateInitialNeedResult } from "../src/lib/personal-plan/persistence/stage1-service"
import {
  freemiumPayPalProvisioningUserId,
  FreemiumPayPalWebhookProvisioningRetryError,
  provisionFreemiumPayPalSubscription,
  runFreemiumPayPalSubscriptionProvisioning,
  type FreemiumPayPalWebhookIntent,
} from "../src/lib/paypal/freemium-webhook-provisioning"

/**
 * The PayPal webhook's freemium lane — the safety net the R1 rework left open.
 *
 * The buyer it exists for approves in the PayPal popup and closes the tab: the sheet's
 * verification call never runs, so nothing but this lane can turn the payment into an
 * admission, a pinned plan and an accepted Routine. Its contract is deliberately the Stripe
 * lane's, word for word — skipped / provisioned / retryable / blocked — because the two
 * differ in how a purchase is PROVEN, never in what a proven purchase is worth.
 */

const USER = "user-1"
const SUBSCRIPTION_ID = "I-PAYPALSUB1"
const ADMISSION = "admission-1"

function sheetIntent(patch: Partial<FreemiumPayPalWebhookIntent> = {}) {
  return { source: "premium_sheet", user_id: USER, ...patch } as FreemiumPayPalWebhookIntent
}

const provisioned: FreemiumProvisioningResult = {
  outcome: "provisioned",
  enrollmentSourceId: ADMISSION,
  personalPlanId: "plan-1",
  needVersionId: "need-1",
  routineAccepted: true,
}

/** The two outcomes no redelivery can fix, with the reason each must surface. */
const BLOCKED_OUTCOMES: [FreemiumProvisioningResult, string][] = [
  [{ outcome: "no_quiz_artifact" }, "no_quiz_artifact"],
  [
    { outcome: "enrollment_conflict", reasonCode: "plan_owned_by_other_source" },
    "plan_owned_by_other_source",
  ],
]

const activation = { userId: USER, subscriptionId: SUBSCRIPTION_ID }

/* ------------------------------------------------------------------------- *
 * Admission — never inferred, never somebody else's.
 * ------------------------------------------------------------------------- */

test("only the sheet's own PayPal checkout is freemium work", () => {
  const enabled = { freemiumEnabled: () => true }
  assert.equal(freemiumPayPalProvisioningUserId(sheetIntent(), enabled), USER)
  // Every legacy entry point, and the absence of an intent altogether.
  assert.equal(
    freemiumPayPalProvisioningUserId(sheetIntent({ source: "pricing_page" }), enabled),
    null,
  )
  assert.equal(
    freemiumPayPalProvisioningUserId(sheetIntent({ source: "quiz_result_offer" }), enabled),
    null,
  )
  assert.equal(freemiumPayPalProvisioningUserId(null, enabled), null)
  // A sheet intent with no signed-in buyer recorded names nobody to provision for.
  assert.equal(freemiumPayPalProvisioningUserId(sheetIntent({ user_id: null }), enabled), null)
  assert.equal(freemiumPayPalProvisioningUserId(sheetIntent({ user_id: "  " }), enabled), null)
  // And the whole lane is off with the flag off.
  assert.equal(
    freemiumPayPalProvisioningUserId(sheetIntent(), { freemiumEnabled: () => false }),
    null,
  )
})

test("a legacy PayPal subscription reaches no provisioning at all", async () => {
  let calls = 0
  const provisionFreemiumPurchase = async () => {
    calls += 1
    return provisioned
  }
  for (const intent of [sheetIntent({ source: "pricing_page" }), null]) {
    const outcome = await provisionFreemiumPayPalSubscription(
      intent,
      { freemiumEnabled: () => true, provisionFreemiumPurchase },
      activation,
    )
    assert.deepEqual(outcome, { status: "skipped" })
  }
  const offOutcome = await provisionFreemiumPayPalSubscription(
    sheetIntent(),
    { freemiumEnabled: () => false, provisionFreemiumPurchase },
    activation,
  )
  assert.deepEqual(offOutcome, { status: "skipped" })
  assert.equal(calls, 0)
})

test("an intent whose account is not the activation's unlocks nobody, and is not retried", async () => {
  // The plan's `enrollment_purchase_source_id` pin is permanent and never self-heals, so
  // pinning the intent's user while the paid authority lives on another account cannot be
  // undone — and a redelivery would resolve the same two identities again.
  let calls = 0
  const captured: string[] = []
  const outcome = await provisionFreemiumPayPalSubscription(
    sheetIntent({ user_id: "someone-else" }),
    {
      freemiumEnabled: () => true,
      provisionFreemiumPurchase: async () => {
        calls += 1
        return provisioned
      },
      captureFreemiumProvisioningException: ((_error: unknown, context: { reason?: string }) => {
        captured.push(String(context.reason))
      }) as never,
    },
    activation,
  )

  assert.deepEqual(outcome, { status: "blocked", reason: "identity_mismatch" })
  assert.equal(calls, 0)
  assert.deepEqual(captured, ["freemium_webhook_identity_mismatch"])
})

/* ------------------------------------------------------------------------- *
 * Durability — a failure has to reach PayPal, or it reaches nobody.
 * ------------------------------------------------------------------------- */

test("a failing provisioning is reported AND demands a redelivery", async () => {
  const captured: Record<string, unknown>[] = []
  const outcome = await provisionFreemiumPayPalSubscription(
    sheetIntent(),
    {
      freemiumEnabled: () => true,
      provisionFreemiumPurchase: async () => {
        throw new Error("provisioning down")
      },
      captureFreemiumProvisioningException: ((
        _error: unknown,
        context: Record<string, unknown>,
      ) => {
        captured.push(context)
      }) as never,
    },
    activation,
  )

  assert.deepEqual(outcome, { status: "retryable", reason: "provisioning_error" })
  // Provider-shaped coordinates: this lane must never report as the card lane.
  assert.deepEqual(captured, [
    {
      reason: "freemium_webhook_provisioning_failed",
      provider: "paypal",
      stage: "paypal_webhook_ingestion",
      source: "premium_sheet",
      paypalSubscriptionId: SUBSCRIPTION_ID,
    },
  ])
})

test("a plan with no accepted Routine is a retry, not a success", async () => {
  // Admitted, pinned and derived is not enough: `resolvePersonalPlanJourneyAccess` needs an
  // ACTIVE routine version, so this buyer would still meet a gate.
  const outcome = await provisionFreemiumPayPalSubscription(
    sheetIntent(),
    {
      freemiumEnabled: () => true,
      provisionFreemiumPurchase: async () => ({ ...provisioned, routineAccepted: false }),
    },
    activation,
  )
  assert.deepEqual(outcome, { status: "retryable", reason: "routine_not_accepted" })
})

test("a temporarily unavailable stage names itself in the retry reason", async () => {
  const outcome = await provisionFreemiumPayPalSubscription(
    sheetIntent(),
    {
      freemiumEnabled: () => true,
      provisionFreemiumPurchase: async () => ({
        outcome: "temporarily_unavailable",
        stage: "initial_need",
      }),
      captureFreemiumProvisioningException: (() => {}) as never,
    },
    activation,
  )
  assert.deepEqual(outcome, { status: "retryable", reason: "unavailable_initial_need" })
})

test("a failure a redelivery cannot fix is blocked, not retried forever", async () => {
  for (const [result, reason] of BLOCKED_OUTCOMES) {
    const captured: string[] = []
    const outcome = await provisionFreemiumPayPalSubscription(
      sheetIntent(),
      {
        freemiumEnabled: () => true,
        provisionFreemiumPurchase: async () => result,
        captureFreemiumProvisioningException: ((_error: unknown, context: { reason?: string }) => {
          captured.push(String(context.reason))
        }) as never,
      },
      activation,
    )
    assert.deepEqual(outcome, { status: "blocked", reason })
    assert.deepEqual(captured, ["freemium_webhook_provisioning_blocked"])
  }
})

test("the runner throws exactly when the delivery has to be failed", async () => {
  const enabled = { freemiumEnabled: () => true }
  await assert.rejects(
    () =>
      runFreemiumPayPalSubscriptionProvisioning(
        sheetIntent(),
        {
          ...enabled,
          provisionFreemiumPurchase: async () => {
            throw new Error("down")
          },
          captureFreemiumProvisioningException: (() => {}) as never,
        },
        activation,
      ),
    (error: unknown) => {
      assert.ok(error instanceof FreemiumPayPalWebhookProvisioningRetryError)
      assert.equal(error.reason, "provisioning_error")
      assert.equal(error.paypalSubscriptionId, SUBSCRIPTION_ID)
      return true
    },
  )

  // Success, skipped and blocked all return: only `retryable` is improved by asking again.
  assert.deepEqual(
    await runFreemiumPayPalSubscriptionProvisioning(
      sheetIntent(),
      { ...enabled, provisionFreemiumPurchase: async () => provisioned },
      activation,
    ),
    { status: "provisioned" },
  )
  assert.deepEqual(
    await runFreemiumPayPalSubscriptionProvisioning(
      sheetIntent({ source: "pricing_page" }),
      { ...enabled, provisionFreemiumPurchase: async () => provisioned },
      activation,
    ),
    { status: "skipped" },
  )
  assert.deepEqual(
    await runFreemiumPayPalSubscriptionProvisioning(
      sheetIntent(),
      {
        ...enabled,
        provisionFreemiumPurchase: async () => ({ outcome: "no_quiz_artifact" }),
        captureFreemiumProvisioningException: (() => {}) as never,
      },
      activation,
    ),
    { status: "blocked", reason: "no_quiz_artifact" },
  )
})

test("a chain that outruns the budget fails the delivery instead of being killed", async () => {
  // A killed invocation leaves the event CLAIMED — the claim is released in a `catch`, which
  // a kill never reaches — and every redelivery afterwards is dropped as a duplicate. Giving
  // up first keeps the failure where the claim can still be released.
  await assert.rejects(
    () =>
      runFreemiumPayPalSubscriptionProvisioning(
        sheetIntent(),
        { freemiumEnabled: () => true, provisionFreemiumPurchase: () => new Promise(() => {}) },
        activation,
        { budgetMs: 5 },
      ),
    (error: unknown) => {
      assert.ok(error instanceof FreemiumPayPalWebhookProvisioningRetryError)
      assert.equal(error.reason, "provisioning_budget_exhausted")
      return true
    },
  )
})

/* ------------------------------------------------------------------------- *
 * Approve-then-close, through the REAL provisioning service.
 *
 * The fake below is the database, reimplementing the two rules that actually decide whether
 * this buyer gets a plan (see freemium-plan-provisioning.test.ts): the enrollment pin is
 * written once and afterwards rejects any different value, and the initial need row is
 * deduped on `(personal_plan_id, input_hash)`.
 * ------------------------------------------------------------------------- */

type FakeState = {
  admissions: Map<string, { id: string; provider: string; providerReference: string }>
  plan: { id: string; enrollmentPurchaseSourceId: string | null } | null
  needVersions: { personalPlanId: string; inputHash: string; id: string }[]
  admissionInserts: number
  acceptCalls: number
}

function freshState(): FakeState {
  return {
    admissions: new Map(),
    // What T6's free path leaves behind for a user who scanned before paying.
    plan: { id: "plan-1", enrollmentPurchaseSourceId: null },
    needVersions: [],
    admissionInserts: 0,
    acceptCalls: 0,
  }
}

function fakeDeps(state: FakeState): FreemiumProvisioningDependencies {
  return {
    loadLinkedQuizArtifact: async () => ({
      id: "artifact-1",
      leadId: "lead-1",
      quizAnswers: STAGE1_STAGE2_LAB_ENVELOPE,
    }),
    ensureAdmission: async ({ userId, provider, providerReference }) => {
      const existing = state.admissions.get(userId)
      if (existing) return { id: existing.id }
      state.admissionInserts += 1
      state.admissions.set(userId, { id: ADMISSION, provider, providerReference })
      return { id: ADMISSION }
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
      state.plan ??= {
        id: "plan-1",
        enrollmentPurchaseSourceId: request.enrollmentPurchaseSourceId,
      }
      if (state.plan.enrollmentPurchaseSourceId !== request.enrollmentPurchaseSourceId) {
        return { outcome: "invalid_source", reasonCode: "enrollment_mismatch" }
      }
      const planId = state.plan.id
      const existing = state.needVersions.find(
        (row) => row.personalPlanId === planId && row.inputHash === request.inputHash,
      )
      const needVersionId = existing?.id ?? `need-${state.needVersions.length + 1}`
      if (!existing) {
        state.needVersions.push({
          personalPlanId: planId,
          inputHash: request.inputHash,
          id: needVersionId,
        })
      }
      return {
        outcome: "completed",
        personalPlanId: planId,
        needVersionId,
        outputSnapshot: request.outputSnapshot as never,
      }
    },
    acceptInitialRoutine: async (): Promise<AcceptInitialRoutineResult> => {
      state.acceptCalls += 1
      return state.acceptCalls === 1 ? "accepted" : "already_accepted"
    },
  }
}

function webhookDeps(state: FakeState) {
  return {
    freemiumEnabled: () => true,
    provisionFreemiumPurchase: (input: { userId: string; providerReference: string }) =>
      createFreemiumProvisioningService(fakeDeps(state)).provisionAfterPurchase({
        userId: input.userId,
        provider: "paypal" as const,
        providerReference: input.providerReference,
      }),
  }
}

test("approve-then-close: the webhook alone leaves the buyer admitted, pinned, derived and accepted", async () => {
  const state = freshState()

  const outcome = await runFreemiumPayPalSubscriptionProvisioning(
    sheetIntent(),
    webhookDeps(state),
    activation,
  )

  assert.deepEqual(outcome, { status: "provisioned" })
  // Exactly what `resolvePersonalPlanJourneyAccess` reads on the buyer's next visit.
  assert.equal(state.plan?.enrollmentPurchaseSourceId, ADMISSION)
  assert.equal(state.needVersions.length, 1)
  assert.equal(state.acceptCalls, 1)
  // The admission remembers the PayPal purchase it was bought with.
  assert.deepEqual(state.admissions.get(USER), {
    id: ADMISSION,
    provider: "paypal",
    providerReference: SUBSCRIPTION_ID,
  })
})

test("redelivery converges — one admission, one Routine, whatever the retry count", async () => {
  const state = freshState()
  const deps = webhookDeps(state)

  await runFreemiumPayPalSubscriptionProvisioning(sheetIntent(), deps, activation)
  await runFreemiumPayPalSubscriptionProvisioning(sheetIntent(), deps, activation)
  await runFreemiumPayPalSubscriptionProvisioning(sheetIntent(), deps, activation)

  assert.equal(state.admissionInserts, 1)
  assert.equal(state.needVersions.length, 1)
})

test("the sheet's own completion call and the webhook converge on the same admission", async () => {
  // Both lanes call the same service with the same identity and the same provider reference,
  // so whichever arrives first provisions and the other one is a no-op. That is the whole
  // reason the webhook lane is safe to add beside a sheet that is still polling.
  const state = freshState()
  const service = createFreemiumProvisioningService(fakeDeps(state))

  const sheetLane = await service.provisionAfterPurchase({
    userId: USER,
    provider: "paypal",
    providerReference: SUBSCRIPTION_ID,
  })
  const webhookLane = await runFreemiumPayPalSubscriptionProvisioning(
    sheetIntent(),
    webhookDeps(state),
    activation,
  )

  assert.equal(sheetLane.outcome, "provisioned")
  assert.deepEqual(webhookLane, { status: "provisioned" })
  assert.equal(state.admissionInserts, 1)
  assert.equal(state.needVersions.length, 1)
})
