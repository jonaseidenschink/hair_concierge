import assert from "node:assert/strict"
import test from "node:test"
import type Stripe from "stripe"

import {
  createFreemiumPurchaseCompletionHandler,
  type FreemiumPurchaseCompletionDeps,
} from "../src/app/api/freemium/purchase/complete/route"
import type { FreemiumProvisioningResult } from "../src/lib/freemium/plan-provisioning"
import {
  PayPalCheckoutActivationError,
  type PayPalCheckoutAccountResult,
} from "../src/lib/paypal/checkout-activation"
import { CheckoutActivationError } from "../src/lib/stripe/checkout-activation"
import {
  freemiumCheckoutProvisioningUserId,
  FreemiumWebhookProvisioningRetryError,
  provisionFreemiumCheckoutSession,
  runFreemiumCheckoutProvisioning,
} from "../src/lib/stripe/webhook-handlers"

/**
 * The purchase-completion journey with Stripe mocked at the API seam — the endpoint's own
 * dependency boundary, so everything below it (ownership, pending classification, the
 * unlock decision) is the real code.
 *
 * The rule this suite exists to hold: **the client callback never unlocks anything.** The
 * sheet's `onComplete` only causes this request; a Session that Stripe reports as unpaid,
 * or that belongs to somebody else, must come back as `pending` / 403 no matter what the
 * browser claims.
 */

const USER = "user-1"
const SESSION_ID = "cs_test_freemium_1"
/** Docket rework R1 — the PayPal lane's evidence: an intent token, not a Session id. */
const PAYPAL_TOKEN = "pp_token_freemium_0123456789"
const PAYPAL_SUBSCRIPTION_ID = "I-PAYPALSUB1"

function freemiumSession(overrides: Partial<Stripe.Checkout.Session> = {}) {
  return {
    id: SESSION_ID,
    metadata: { freemium_admission: "1", freemium_user_id: USER },
    ...overrides,
  } as unknown as Stripe.Checkout.Session
}

/** The two provisioning outcomes no retry can fix, with the reason each must surface. */
const BLOCKED_OUTCOMES: [FreemiumProvisioningResult, string][] = [
  [{ outcome: "no_quiz_artifact" }, "no_quiz_artifact"],
  [
    { outcome: "enrollment_conflict", reasonCode: "plan_owned_by_other_source" },
    "plan_owned_by_other_source",
  ],
]

const provisioned: FreemiumProvisioningResult = {
  outcome: "provisioned",
  enrollmentSourceId: "admission-1",
  personalPlanId: "plan-1",
  needVersionId: "need-1",
  routineAccepted: true,
}

function deps(overrides: Partial<FreemiumPurchaseCompletionDeps> = {}) {
  return {
    enabled: () => true,
    getUser: async () => ({ id: USER }),
    checkRateLimit: (async () => ({ allowed: true })) as never,
    retrieveSession: async () => freemiumSession(),
    assertActivatable: () => {},
    activate: async () =>
      ({ userId: USER, email: "buyer@example.com", canSetInitialPassword: false }) as never,
    findPayPalIntent: async () => ({
      userId: USER,
      providerSubscriptionId: PAYPAL_SUBSCRIPTION_ID,
    }),
    activatePayPal: async () =>
      ({
        status: "active",
        userId: USER,
        email: "buyer@example.com",
        providerSubscriberEmail: "buyer@example.com",
        canSetInitialPassword: false,
      }) as never,
    provision: async () => provisioned,
    ...overrides,
  } satisfies FreemiumPurchaseCompletionDeps
}

function request(body: unknown = { sessionId: SESSION_ID }) {
  return new Request("https://chaarlie.de/api/freemium/purchase/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function call(overrides: Partial<FreemiumPurchaseCompletionDeps> = {}, body?: unknown) {
  const response = await createFreemiumPurchaseCompletionHandler(deps(overrides))(request(body))
  return { status: response.status, body: await response.json() }
}

test("a verified purchase unlocks and reports the provisioned Routine", async () => {
  const result = await call()
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { status: "complete", routineReady: true })
})

test("flag off: the endpoint does not exist", async () => {
  const result = await call({ enabled: () => false })
  assert.equal(result.status, 404)
})

test("an anonymous caller cannot complete anything", async () => {
  const result = await call({ getUser: async () => null })
  assert.equal(result.status, 401)
})

test("a Session created for another user is refused before any write", async () => {
  let provisionCalls = 0
  const result = await call({
    retrieveSession: async () =>
      freemiumSession({
        metadata: { freemium_admission: "1", freemium_user_id: "someone-else" },
      } as never),
    provision: async () => {
      provisionCalls += 1
      return provisioned
    },
  })
  assert.equal(result.status, 403)
  assert.equal(provisionCalls, 0)
})

test("a Session without the freemium marker is refused — a plain subscription is not an admission", async () => {
  const result = await call({
    retrieveSession: async () =>
      freemiumSession({ metadata: { pricing_catalog: "standard" } } as never),
  })
  assert.equal(result.status, 403)
})

test("an unpaid Session is pending, never complete — the client callback is only a hint", async () => {
  let provisionCalls = 0
  const result = await call({
    assertActivatable: () => {
      throw new CheckoutActivationError("checkout_session_unpaid", "unpaid")
    },
    provision: async () => {
      provisionCalls += 1
      return provisioned
    },
  })
  assert.deepEqual(result.body, { status: "pending" })
  assert.equal(provisionCalls, 0)
})

test("F6: a foreign Session is 403 before its payment state is ever classified", async () => {
  // The oracle this closes: an authenticated caller must not be able to tell an unpaid
  // Session from a terminally unusable one for an id that is not theirs.
  let classified = 0
  const result = await call({
    retrieveSession: async () =>
      freemiumSession({
        metadata: { freemium_admission: "1", freemium_user_id: "someone-else" },
      } as never),
    assertActivatable: () => {
      classified += 1
      throw new CheckoutActivationError("checkout_session_unpaid", "unpaid")
    },
  })
  assert.equal(result.status, 403)
  assert.deepEqual(result.body, { error: "forbidden" })
  assert.equal(classified, 0, "the Session's state is never classified for a non-owner")
})

test("F6: an unreadable Session is 503, never a classified reason", async () => {
  const result = await call({
    retrieveSession: async () => {
      throw new Error("stripe unreachable")
    },
  })
  assert.equal(result.status, 503)
  assert.deepEqual(result.body, { error: "temporarily_unavailable" })
})

test("a Session with no subscription yet is pending, not failed", async () => {
  const result = await call({
    activate: async () => {
      throw new CheckoutActivationError("checkout_session_subscription_missing", "no sub")
    },
  })
  assert.deepEqual(result.body, { status: "pending" })
})

test("pending → complete: the same call succeeds once the payment settles", async () => {
  let settled = false
  const assertActivatable = () => {
    if (!settled) throw new CheckoutActivationError("checkout_session_unpaid", "unpaid")
  }
  assert.deepEqual((await call({ assertActivatable })).body, { status: "pending" })
  settled = true
  assert.deepEqual((await call({ assertActivatable })).body, {
    status: "complete",
    routineReady: true,
  })
})

test("a terminally unusable Session fails recoverably, with the reason named", async () => {
  const result = await call({
    activate: async () => {
      throw new CheckoutActivationError("checkout_subscription_expired", "expired")
    },
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { status: "failed", reason: "checkout_subscription_expired" })
})

test("activation resolving a different account unlocks nobody", async () => {
  const result = await call({
    activate: async () => ({ userId: "other-user", email: "x@example.com" }) as never,
  })
  assert.equal(result.status, 403)
})

test("Y1: a failed provisioning is never reported as a complete purchase", async () => {
  // It used to answer `{status:"complete", routineReady:false}` — which the sheet renders as
  // „Alles freigeschaltet" plus a promise that the Routine is being built, over a buyer who
  // has no admission row, no plan and nothing in flight.
  const captured: string[] = []
  const result = await call({
    provision: async () => ({ outcome: "temporarily_unavailable", stage: "acceptance" }),
    captureException: ((_error: unknown, context: { reason?: string }) => {
      captured.push(String(context.reason))
    }) as never,
  })
  assert.equal(result.status, 200, "the payment is real; this is not an error response")
  assert.deepEqual(result.body, { status: "provisioning", retryable: true, reason: "acceptance" })
  assert.deepEqual(captured, ["freemium_provisioning_unavailable"])
})

test("Y1: a thrown provisioning error is contained, reported, and honestly reported back", async () => {
  const captured: string[] = []
  const result = await call({
    provision: async () => {
      throw new Error("db down")
    },
    captureException: ((_error: unknown, context: { reason?: string }) => {
      captured.push(String(context.reason))
    }) as never,
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { status: "provisioning", retryable: true, reason: "admission" })
  assert.deepEqual(captured, ["freemium_provisioning_failed", "freemium_provisioning_unavailable"])
})

test("Y1: a provisioning failure a retry cannot fix stops the client polling", async () => {
  for (const [provisioning, reason] of BLOCKED_OUTCOMES) {
    const result = await call({ provision: async () => provisioning })
    assert.deepEqual(result.body, { status: "provisioning", retryable: false, reason })
  }
})

test("R2: a provisioned plan whose Routine is not accepted yet is honest provisioning, not complete", async () => {
  // It used to answer `{status:"complete", routineReady:false}` here — which the sheet
  // renders as „Alles freigeschaltet" and closes, while the gate stays locked. The webhook
  // lane (`provisionFreemiumCheckoutSession`) already treats this exact condition as
  // retryable (`routine_not_accepted`); this endpoint now agrees (Codex fix wave round 2).
  const result = await call({
    provision: async () => ({ ...provisioned, routineAccepted: false }),
  })
  assert.deepEqual(result.body, {
    status: "provisioning",
    retryable: true,
    reason: "routine_not_accepted",
  })
})

test("R2: the same call converges to complete once the Routine is accepted", async () => {
  let attempts = 0
  const provision = async () => {
    attempts += 1
    return attempts === 1 ? { ...provisioned, routineAccepted: false } : provisioned
  }
  assert.deepEqual((await call({ provision })).body, {
    status: "provisioning",
    retryable: true,
    reason: "routine_not_accepted",
  })
  assert.deepEqual((await call({ provision })).body, { status: "complete", routineReady: true })
})

test("Y1: the same call converges once provisioning succeeds", async () => {
  // The durability claim, at the endpoint's own seam: nothing about the first failure is
  // sticky, so the poll (or the webhook redelivery) reaches the complete state.
  let attempts = 0
  const provision = async () => {
    attempts += 1
    return attempts === 1
      ? ({ outcome: "temporarily_unavailable", stage: "initial_need" } as const)
      : provisioned
  }
  assert.deepEqual((await call({ provision })).body, {
    status: "provisioning",
    retryable: true,
    reason: "initial_need",
  })
  assert.deepEqual((await call({ provision })).body, { status: "complete", routineReady: true })
})

/* ------------------------------------------------------------------------- *
 * Y4 — the Session's own lifecycle status decides retryability.
 * ------------------------------------------------------------------------- */

test("Y4: an expired Session is a terminal failure, not an endless „wird geprüft“", async () => {
  let provisionCalls = 0
  const result = await call({
    retrieveSession: async () => freemiumSession({ status: "expired" } as never),
    // `assertCheckoutSessionActivatable` raises `checkout_session_incomplete` for this
    // Session — the code that used to be classified as pending.
    assertActivatable: () => {
      throw new CheckoutActivationError("checkout_session_incomplete", "not complete")
    },
    provision: async () => {
      provisionCalls += 1
      return provisioned
    },
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { status: "failed", reason: "checkout_session_expired" })
  assert.equal(provisionCalls, 0)
})

test("Y4: a Session the buyer abandoned (still `open`) is a failure they can retry", async () => {
  const result = await call({
    retrieveSession: async () => freemiumSession({ status: "open" } as never),
    assertActivatable: () => {
      throw new CheckoutActivationError("checkout_session_incomplete", "not complete")
    },
  })
  assert.deepEqual(result.body, { status: "failed", reason: "checkout_session_abandoned" })
})

test("Y4: a complete Session whose payment is still settling is still pending", async () => {
  const result = await call({
    retrieveSession: async () => freemiumSession({ status: "complete" } as never),
    assertActivatable: () => {
      throw new CheckoutActivationError("checkout_session_unpaid", "unpaid")
    },
  })
  assert.deepEqual(result.body, { status: "pending" })
})

test("Y4: the lifecycle check runs only for the Session's owner", async () => {
  const result = await call({
    retrieveSession: async () =>
      freemiumSession({
        status: "expired",
        metadata: { freemium_admission: "1", freemium_user_id: "someone-else" },
      } as never),
  })
  assert.equal(result.status, 403, "a non-owner learns nothing about the Session's state")
})

test("a malformed body is rejected before Stripe is touched", async () => {
  let retrieved = 0
  const result = await call(
    {
      retrieveSession: async () => {
        retrieved += 1
        return freemiumSession()
      },
    },
    { sessionId: "not-a-session" },
  )
  assert.equal(result.status, 400)
  assert.equal(retrieved, 0)
})

/* ------------------------------------------------------------------------- *
 * PayPal lane (docket rework R1) — the same contract, different evidence.
 *
 * The sheet's PayPal button is the offer page's button; the only thing that changed is
 * where it routes on approval. So what reaches this endpoint is a checkout-intent token,
 * and these assertions hold it to the SAME bar as the card lane: ownership before any
 * classification, the server's own re-read decides, and the activation's resolved user
 * must agree with the caller.
 * ------------------------------------------------------------------------- */

const paypalBody = { paypalToken: PAYPAL_TOKEN }

test("R1: a verified PayPal approval unlocks, and provisions against the subscription", async () => {
  const provisions: { userId: string; provider: string; providerReference: string }[] = []
  const result = await call(
    {
      provision: async (input) => {
        provisions.push(input)
        return provisioned
      },
    },
    paypalBody,
  )
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { status: "complete", routineReady: true })
  assert.deepEqual(provisions, [
    { userId: USER, provider: "paypal", providerReference: PAYPAL_SUBSCRIPTION_ID },
  ])
})

test("R1: an intent this user did not start is refused before PayPal is ever asked", async () => {
  let activated = 0
  const result = await call(
    {
      findPayPalIntent: async () => ({
        userId: "someone-else",
        providerSubscriptionId: PAYPAL_SUBSCRIPTION_ID,
      }),
      activatePayPal: async () => {
        activated += 1
        throw new Error("must not be reached")
      },
    },
    paypalBody,
  )
  assert.equal(result.status, 403)
  assert.equal(activated, 0, "a foreign token is never an oracle for its settlement state")
})

test("R1: an unknown token answers exactly like a foreign one", async () => {
  const result = await call({ findPayPalIntent: async () => null }, paypalBody)
  assert.equal(result.status, 403)
})

test("R1: an intent with no bound subscription is pending, not failed", async () => {
  let activated = 0
  const result = await call(
    {
      findPayPalIntent: async () => ({ userId: USER, providerSubscriptionId: null }),
      activatePayPal: async () => {
        activated += 1
        throw new Error("must not be reached")
      },
    },
    paypalBody,
  )
  assert.deepEqual(result.body, { status: "pending" })
  assert.equal(activated, 0)
})

test("R1: an approval PayPal has not activated yet is pending — the callback unlocks nothing", async () => {
  const result = await call({ activatePayPal: async () => ({ status: "pending" }) }, paypalBody)
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { status: "pending" })
})

test("R1: pending → complete, once PayPal reports the subscription active", async () => {
  const answers: PayPalCheckoutAccountResult[] = [
    { status: "pending" },
    {
      status: "active",
      userId: USER,
      email: "buyer@example.com",
      providerSubscriberEmail: "buyer@example.com",
      canSetInitialPassword: false,
    },
  ]
  const activatePayPal = async () => answers.shift()!
  assert.deepEqual((await call({ activatePayPal }, paypalBody)).body, { status: "pending" })
  assert.deepEqual((await call({ activatePayPal }, paypalBody)).body, {
    status: "complete",
    routineReady: true,
  })
})

test("R1: a duplicate-guarded checkout fails recoverably instead of unlocking", async () => {
  const result = await call({ activatePayPal: async () => ({ status: "duplicate" }) }, paypalBody)
  assert.deepEqual(result.body, { status: "failed", reason: "paypal_duplicate_checkout" })
})

test("R1: an activation refusal surfaces its own code, and provisions nothing", async () => {
  let provisioned = 0
  const result = await call(
    {
      activatePayPal: async () => {
        throw new PayPalCheckoutActivationError(
          "paypal_checkout_intent_expired",
          "PayPal checkout intent is expired",
        )
      },
      provision: async () => {
        provisioned += 1
        throw new Error("must not be reached")
      },
    },
    paypalBody,
  )
  assert.deepEqual(result.body, { status: "failed", reason: "paypal_checkout_intent_expired" })
  assert.equal(provisioned, 0)
})

test("R1: an unreadable activation is 503, never a classified verdict", async () => {
  const result = await call(
    {
      activatePayPal: async () => {
        throw new Error("paypal api down")
      },
    },
    paypalBody,
  )
  assert.equal(result.status, 503)
  assert.deepEqual(result.body, { error: "temporarily_unavailable" })
})

test("R1: an activation resolving a different account unlocks nobody", async () => {
  const result = await call(
    {
      activatePayPal: async () =>
        ({
          status: "active",
          userId: "someone-else",
          email: "other@example.com",
          providerSubscriberEmail: "other@example.com",
          canSetInitialPassword: false,
        }) as never,
    },
    paypalBody,
  )
  assert.equal(result.status, 403)
})

test("R1: the PayPal lane shares the card lane's honest provisioning answers", async () => {
  assert.deepEqual(
    (await call({ provision: async () => ({ outcome: "no_quiz_artifact" }) }, paypalBody)).body,
    { status: "provisioning", retryable: false, reason: "no_quiz_artifact" },
  )
  assert.deepEqual(
    (
      await call(
        { provision: async () => ({ ...provisioned, routineAccepted: false }) },
        paypalBody,
      )
    ).body,
    { status: "provisioning", retryable: true, reason: "routine_not_accepted" },
  )
})

test("R1: a body naming both providers, or neither, is refused before anything is read", async () => {
  for (const body of [
    { sessionId: SESSION_ID, paypalToken: PAYPAL_TOKEN },
    { paypalToken: "short" },
    { paypalToken: 42 },
    {},
  ]) {
    let touched = 0
    const result = await call(
      {
        retrieveSession: async () => {
          touched += 1
          return freemiumSession()
        },
        findPayPalIntent: async () => {
          touched += 1
          return { userId: USER, providerSubscriptionId: PAYPAL_SUBSCRIPTION_ID }
        },
      },
      body,
    )
    assert.equal(result.status, 400, `must refuse ${JSON.stringify(body)}`)
    assert.equal(touched, 0)
  }
})

test("R1: the PayPal lane is gone with the flag off, and closed to anonymous callers", async () => {
  assert.equal((await call({ enabled: () => false }, paypalBody)).status, 404)
  assert.equal((await call({ getUser: async () => null }, paypalBody)).status, 401)
})

/* ------------------------------------------------------------------------- *
 * Webhook lane — the same provisioning, without the buyer present.
 * ------------------------------------------------------------------------- */

test("webhook replay provisions through the same idempotent service", async () => {
  const calls: { userId: string; providerReference: string }[] = []
  const webhookDeps = {
    freemiumEnabled: () => true,
    provisionFreemiumPurchase: async (input: { userId: string; providerReference: string }) => {
      calls.push(input)
      return provisioned
    },
  }
  await provisionFreemiumCheckoutSession(freemiumSession(), webhookDeps, { userId: USER })
  await provisionFreemiumCheckoutSession(freemiumSession(), webhookDeps, { userId: USER })

  // Both deliveries reach provisioning with the SAME identity — the service (proved
  // idempotent in freemium-plan-provisioning.test.ts) is what makes the replay a no-op,
  // rather than the webhook guessing whether it already ran.
  assert.deepEqual(calls, [
    { userId: USER, providerReference: SESSION_ID },
    { userId: USER, providerReference: SESSION_ID },
  ])
})

test("the webhook lane is inert for every non-freemium checkout", async () => {
  let calls = 0
  const provisionFreemiumPurchase = async () => {
    calls += 1
    return provisioned
  }
  await provisionFreemiumCheckoutSession(
    { id: "cs_legacy", metadata: { lead_id: "lead-1" } } as never,
    { freemiumEnabled: () => true, provisionFreemiumPurchase },
    { userId: USER },
  )
  assert.equal(calls, 0)
})

test("the webhook lane is inert with the flag off", async () => {
  let calls = 0
  await provisionFreemiumCheckoutSession(
    freemiumSession(),
    {
      freemiumEnabled: () => false,
      provisionFreemiumPurchase: async () => {
        calls += 1
        return provisioned
      },
    },
    { userId: USER },
  )
  assert.equal(calls, 0)
})

test("F7: the webhook lane refuses when the activation resolved a different account", async () => {
  // The plan's `enrollment_purchase_source_id` pin is permanent, so pinning the metadata
  // user's plan while the paid authority lives on another account is unrecoverable.
  let calls = 0
  await provisionFreemiumCheckoutSession(
    freemiumSession(),
    {
      freemiumEnabled: () => true,
      provisionFreemiumPurchase: async () => {
        calls += 1
        return provisioned
      },
    },
    { userId: "other-user" },
  )
  assert.equal(calls, 0)
})

test("the deferral guard decides synchronously, so a legacy checkout queues no extra work", () => {
  // The webhook schedules provisioning with `defer`; if the guard only ran INSIDE the
  // deferred callback, every legacy checkout would still enqueue one — which is exactly
  // what the Customer.io webhook suite counts.
  assert.equal(
    freemiumCheckoutProvisioningUserId(freemiumSession(), { freemiumEnabled: () => true }),
    USER,
  )
  assert.equal(
    freemiumCheckoutProvisioningUserId({ id: "cs_legacy", metadata: {} } as never, {
      freemiumEnabled: () => true,
    }),
    null,
  )
  assert.equal(
    freemiumCheckoutProvisioningUserId(freemiumSession(), { freemiumEnabled: () => false }),
    null,
  )
})

/* ------------------------------------------------------------------------- *
 * Y1 — the webhook lane's durability contract.
 *
 * The whole point of this lane is the buyer who is NOT watching: an asynchronous payment
 * that settles minutes later, a tab closed mid-payment. If its failure is swallowed, there
 * is no other lane — `claimWebhookEvent` has already claimed the event id, so no redelivery
 * is processable, and the buyer stays paid-and-unprovisioned forever. So a failure here has
 * to reach Stripe as a failed delivery.
 * ------------------------------------------------------------------------- */

test("Y1: a failing webhook provisioning is reported AND demands a redelivery", async () => {
  const captured: string[] = []
  const outcome = await provisionFreemiumCheckoutSession(
    freemiumSession(),
    {
      freemiumEnabled: () => true,
      provisionFreemiumPurchase: async () => {
        throw new Error("provisioning down")
      },
      captureFreemiumProvisioningException: ((_error: unknown, context: { reason?: string }) => {
        captured.push(String(context.reason))
      }) as never,
    },
    { userId: USER },
  )
  assert.deepEqual(outcome, { status: "retryable", reason: "provisioning_error" })
  assert.deepEqual(captured, ["freemium_webhook_provisioning_failed"])
})

test("Y1: a plan with no accepted Routine is a retry, not a success", async () => {
  // Admitted, pinned and derived is not enough: `resolvePersonalPlanJourneyAccess` needs an
  // ACTIVE routine version, so this buyer still sees a gate.
  const outcome = await provisionFreemiumCheckoutSession(
    freemiumSession(),
    {
      freemiumEnabled: () => true,
      provisionFreemiumPurchase: async () => ({ ...provisioned, routineAccepted: false }),
    },
    { userId: USER },
  )
  assert.deepEqual(outcome, { status: "retryable", reason: "routine_not_accepted" })
})

test("Y1: a failure a redelivery cannot fix is blocked, not retried forever", async () => {
  for (const [result, reason] of BLOCKED_OUTCOMES) {
    const outcome = await provisionFreemiumCheckoutSession(
      freemiumSession(),
      { freemiumEnabled: () => true, provisionFreemiumPurchase: async () => result },
      { userId: USER },
    )
    assert.deepEqual(outcome, { status: "blocked", reason })
  }
})

test("Y1: a successful provisioning asks for nothing", async () => {
  const outcome = await provisionFreemiumCheckoutSession(
    freemiumSession(),
    { freemiumEnabled: () => true, provisionFreemiumPurchase: async () => provisioned },
    { userId: USER },
  )
  assert.deepEqual(outcome, { status: "provisioned" })
})

test("Y1: the runner throws exactly when the delivery has to be failed", async () => {
  const enabled = { freemiumEnabled: () => true }
  await assert.rejects(
    () =>
      runFreemiumCheckoutProvisioning(
        freemiumSession(),
        {
          ...enabled,
          provisionFreemiumPurchase: async () => {
            throw new Error("down")
          },
        },
        { userId: USER },
      ),
    (error: unknown) => {
      assert.ok(error instanceof FreemiumWebhookProvisioningRetryError)
      assert.equal(error.reason, "provisioning_error")
      assert.equal(error.checkoutSessionId, SESSION_ID)
      return true
    },
  )

  // Success and blocked both return; only `retryable` throws, because only `retryable` is
  // improved by asking Stripe again.
  assert.deepEqual(
    await runFreemiumCheckoutProvisioning(
      freemiumSession(),
      { ...enabled, provisionFreemiumPurchase: async () => provisioned },
      { userId: USER },
    ),
    { status: "provisioned" },
  )
  assert.deepEqual(
    await runFreemiumCheckoutProvisioning(
      freemiumSession(),
      { ...enabled, provisionFreemiumPurchase: async () => ({ outcome: "no_quiz_artifact" }) },
      { userId: USER },
    ),
    { status: "blocked", reason: "no_quiz_artifact" },
  )
})

test("Y1: a chain that outruns the budget fails the delivery instead of being killed", async () => {
  // Stripe gives a webhook ~30s. If the chain ran past that, the platform would kill the
  // invocation with the event still CLAIMED — and the redelivery would then be dropped as a
  // duplicate. Giving up first keeps the failure where the claim can be released.
  await assert.rejects(
    () =>
      runFreemiumCheckoutProvisioning(
        freemiumSession(),
        {
          freemiumEnabled: () => true,
          provisionFreemiumPurchase: () => new Promise(() => {}),
        },
        { userId: USER },
        { budgetMs: 5 },
      ),
    (error: unknown) => {
      assert.ok(error instanceof FreemiumWebhookProvisioningRetryError)
      assert.equal(error.reason, "provisioning_budget_exhausted")
      return true
    },
  )
})

test("Y1: redelivery converges — one enrollment, one Routine, whatever the retry count", async () => {
  // The idempotency claim the retry lane depends on, driven through the real service in
  // `freemium-plan-provisioning.test.ts`; here it is the LANE that is checked: a first
  // delivery fails and demands a retry, the retry succeeds and demands nothing, and the
  // provider reference both carried is the same one.
  const references: string[] = []
  let attempts = 0
  const deps = {
    freemiumEnabled: () => true,
    provisionFreemiumPurchase: async (input: { userId: string; providerReference: string }) => {
      references.push(input.providerReference)
      attempts += 1
      if (attempts === 1) throw new Error("transient")
      return provisioned
    },
    captureFreemiumProvisioningException: (() => {}) as never,
  }

  await assert.rejects(() =>
    runFreemiumCheckoutProvisioning(freemiumSession(), deps, { userId: USER }),
  )
  assert.deepEqual(
    await runFreemiumCheckoutProvisioning(freemiumSession(), deps, { userId: USER }),
    { status: "provisioned" },
  )
  assert.deepEqual(references, [SESSION_ID, SESSION_ID])
})
