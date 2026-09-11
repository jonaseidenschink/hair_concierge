import assert from "node:assert/strict"
import test from "node:test"

import {
  initialPremiumSheetPurchaseState,
  isPremiumSheetPlanSelectionActive,
  isPremiumSheetPurchaseTerminal,
  premiumSheetPollableSessionId,
  premiumSheetPurchaseReducer,
  premiumSheetShowsCheckout,
  type PremiumSheetPurchaseEvent,
  type PremiumSheetPurchasePhase,
} from "../src/lib/premium-sheet/purchase-state"

/**
 * The sheet's purchase machine. The claims worth pinning are the ones a component test
 * would only reach by accident:
 *
 *  - Stripe's client `onComplete` cannot unlock anything. It moves the machine to
 *    `verifying`; only a SERVER-verified completion reaches `unlocked`.
 *  - Every failure and escape returns to the plan rows. Nothing here can navigate away or
 *    end a free session, because nothing here has that vocabulary.
 *  - An outcome from a superseded attempt, or about a Session the machine is no longer
 *    waiting on, is dropped (Codex fix wave, Y5).
 */

function run(events: PremiumSheetPurchaseEvent[]): PremiumSheetPurchasePhase {
  return events.reduce(premiumSheetPurchaseReducer, initialPremiumSheetPurchaseState)
}

const ATTEMPT = "attempt-1"
const SESSION = "cs_1"

const start: PremiumSheetPurchaseEvent = {
  type: "checkout_requested",
  interval: "year",
  attemptId: ATTEMPT,
}
const ready: PremiumSheetPurchaseEvent = { type: "checkout_ready", attemptId: ATTEMPT }
const completed: PremiumSheetPurchaseEvent = {
  type: "provider_completed",
  sessionId: SESSION,
  attemptId: ATTEMPT,
}

test("the happy path: CTA → checkout → provider done → verified unlock", () => {
  const state = run([
    start,
    ready,
    completed,
    { type: "verification_complete", sessionId: SESSION, routineReady: true },
  ])
  assert.deepEqual(state, { phase: "unlocked", routineReady: true })
})

test("the provider's completion callback ALONE never unlocks", () => {
  assert.equal(run([start, ready, completed]).phase, "verifying")
})

test("a rejected verification lands back on the plan rows, inside the same sheet", () => {
  const state = run([
    start,
    ready,
    completed,
    { type: "verification_failed", sessionId: SESSION, reason: "verification_failed" },
  ])
  assert.deepEqual(state, { phase: "failed", reason: "verification_failed" })
  assert.equal(isPremiumSheetPlanSelectionActive(state), true)
})

test("a pending payment holds its own state and can still complete later", () => {
  const pending = run([
    start,
    ready,
    completed,
    { type: "verification_pending", sessionId: SESSION },
  ])
  assert.deepEqual(pending, { phase: "pending", sessionId: SESSION })

  // Y3: the poll answers the SAME Session without re-entering `verifying`.
  const completedLater = premiumSheetPurchaseReducer(pending, {
    type: "verification_complete",
    sessionId: SESSION,
    routineReady: false,
  })
  assert.deepEqual(completedLater, { phase: "unlocked", routineReady: false })
})

test("a late provider failure cannot demote a pending, provisioning or unlocked purchase", () => {
  for (const settled of [
    { phase: "pending", sessionId: SESSION } as const,
    { phase: "provisioning", sessionId: SESSION, retryable: true } as const,
    { phase: "unlocked", routineReady: true } as const,
  ]) {
    assert.deepEqual(
      premiumSheetPurchaseReducer(settled, {
        type: "checkout_failed",
        reason: "provider_unavailable",
      }),
      settled,
    )
  }
})

test("a second CTA press does not strand the checkout already in flight", () => {
  const paying = run([start, ready])
  const again = premiumSheetPurchaseReducer(paying, {
    type: "checkout_requested",
    interval: "month",
    attemptId: "attempt-2",
  })
  assert.deepEqual(again, paying)
})

test("a failed attempt can be retried from the plan rows with a fresh attempt id", () => {
  const failed = run([
    start,
    { type: "checkout_failed", reason: "checkout_unavailable", attemptId: ATTEMPT },
  ])
  const retried = premiumSheetPurchaseReducer(failed, {
    type: "checkout_requested",
    interval: "month",
    attemptId: "attempt-2",
  })
  assert.deepEqual(retried, { phase: "starting", interval: "month", attemptId: "attempt-2" })
})

test("escaping mid-payment returns to plans, but a settled purchase is terminal", () => {
  const paying = run([start, ready])
  assert.deepEqual(premiumSheetPurchaseReducer(paying, { type: "returned_to_plans" }), {
    phase: "plans",
  })

  for (const settled of [
    { phase: "unlocked", routineReady: true } as const,
    { phase: "provisioning", sessionId: SESSION, retryable: false } as const,
  ]) {
    assert.deepEqual(premiumSheetPurchaseReducer(settled, { type: "returned_to_plans" }), settled)
  }
})

test("a contextual redirect return verifies even though the sheet lost its in-flight state", () => {
  // PayPal (inside Stripe Checkout) reloads the page: the machine is back at `plans` and the
  // only thing it has is the session id from the URL — no attempt identity at all.
  const state = premiumSheetPurchaseReducer(initialPremiumSheetPurchaseState, {
    type: "provider_completed",
    sessionId: "cs_redirect",
  })
  assert.equal(state.phase, "verifying")
  if (state.phase !== "verifying") throw new Error("unreachable")
  assert.equal(state.sessionId, "cs_redirect")
})

test("the plan rows and the checkout body are never both live", () => {
  const states: PremiumSheetPurchasePhase[] = [
    { phase: "plans" },
    { phase: "starting", interval: "year", attemptId: "a" },
    { phase: "paying", interval: "year", attemptId: "a" },
    { phase: "verifying", interval: "year", attemptId: "a", sessionId: SESSION },
    { phase: "pending", sessionId: SESSION },
    { phase: "provisioning", sessionId: SESSION, retryable: true },
    { phase: "failed", reason: "verification_failed" },
    { phase: "unlocked", routineReady: true },
  ]
  for (const state of states) {
    assert.equal(
      isPremiumSheetPlanSelectionActive(state) && premiumSheetShowsCheckout(state),
      false,
      `${state.phase} must not show both`,
    )
  }
})

/* ------------------------------------------------------------------------- *
 * Y5 — outcomes are bound to the attempt that produced them.
 * ------------------------------------------------------------------------- */

test("Y5: a stale attempt's failure cannot replace the live checkout", () => {
  // Attempt A is slow. The buyer presses „Plan ändern", picks another plan and starts B.
  // A's session-creation failure lands afterwards, carrying its own attempt id.
  const payingB = run([
    start,
    ready,
    { type: "returned_to_plans" },
    { type: "checkout_requested", interval: "month", attemptId: "attempt-2" },
    { type: "checkout_ready", attemptId: "attempt-2" },
  ])
  assert.deepEqual(payingB, { phase: "paying", interval: "month", attemptId: "attempt-2" })

  const afterStaleFailure = premiumSheetPurchaseReducer(payingB, {
    type: "checkout_failed",
    reason: "checkout_unavailable",
    attemptId: ATTEMPT,
  })
  assert.deepEqual(afterStaleFailure, payingB, "attempt A's failure must not end attempt B")
})

test("Y5: a stale attempt's ready and completion signals are dropped too", () => {
  const startingB = run([
    start,
    { type: "returned_to_plans" },
    { type: "checkout_requested", interval: "month", attemptId: "attempt-2" },
  ])
  assert.deepEqual(
    premiumSheetPurchaseReducer(startingB, { type: "checkout_ready", attemptId: ATTEMPT }),
    startingB,
  )
  assert.deepEqual(
    premiumSheetPurchaseReducer(startingB, {
      type: "provider_completed",
      sessionId: "cs_stale",
      attemptId: ATTEMPT,
    }),
    startingB,
    "a stale onComplete must never send the sheet to verify a dead attempt's Session",
  )
})

test("Y5: the CURRENT attempt's outcomes still apply", () => {
  const paying = run([start, ready])
  assert.equal(
    premiumSheetPurchaseReducer(paying, {
      type: "provider_completed",
      sessionId: SESSION,
      attemptId: ATTEMPT,
    }).phase,
    "verifying",
  )
  assert.deepEqual(
    premiumSheetPurchaseReducer(paying, {
      type: "checkout_failed",
      reason: "provider_unavailable",
      attemptId: ATTEMPT,
    }),
    { phase: "failed", reason: "provider_unavailable" },
  )
})

test("verification answers about another Session are ignored", () => {
  const pending = { phase: "pending", sessionId: SESSION } as const
  for (const event of [
    { type: "verification_complete", sessionId: "cs_other", routineReady: true },
    { type: "verification_failed", sessionId: "cs_other", reason: "verification_failed" },
    { type: "verification_provisioning", sessionId: "cs_other", retryable: true },
  ] satisfies PremiumSheetPurchaseEvent[]) {
    assert.deepEqual(premiumSheetPurchaseReducer(pending, event), pending)
  }
})

/* ------------------------------------------------------------------------- *
 * Y1 / Y4 — the honest paid-but-unprovisioned state and the new failures.
 * ------------------------------------------------------------------------- */

test("Y1: a provisioning failure is its own state, never an unlock", () => {
  const state = run([
    start,
    ready,
    completed,
    { type: "verification_provisioning", sessionId: SESSION, retryable: true },
  ])
  assert.deepEqual(state, { phase: "provisioning", sessionId: SESSION, retryable: true })
  assert.equal(isPremiumSheetPlanSelectionActive(state), false, "the buyer already paid")
  assert.equal(isPremiumSheetPurchaseTerminal(state), false)
})

test("Y1: provisioning converges to unlocked when a later poll finds the plan", () => {
  const provisioning = run([
    start,
    ready,
    completed,
    { type: "verification_provisioning", sessionId: SESSION, retryable: true },
  ])
  assert.deepEqual(
    premiumSheetPurchaseReducer(provisioning, {
      type: "verification_complete",
      sessionId: SESSION,
      routineReady: true,
    }),
    { phase: "unlocked", routineReady: true },
  )
})

test("Y3: only unsettled states are pollable, and only while retrying can help", () => {
  assert.equal(premiumSheetPollableSessionId({ phase: "pending", sessionId: SESSION }), SESSION)
  assert.equal(
    premiumSheetPollableSessionId({ phase: "provisioning", sessionId: SESSION, retryable: true }),
    SESSION,
  )
  assert.equal(
    premiumSheetPollableSessionId({ phase: "provisioning", sessionId: SESSION, retryable: false }),
    null,
  )
  assert.equal(premiumSheetPollableSessionId({ phase: "unlocked", routineReady: true }), null)
  assert.equal(premiumSheetPollableSessionId({ phase: "plans" }), null)
})

test("Y3: the memo is dropped exactly on the states that cannot change on their own", () => {
  assert.equal(isPremiumSheetPurchaseTerminal({ phase: "unlocked", routineReady: false }), true)
  assert.equal(
    isPremiumSheetPurchaseTerminal({ phase: "failed", reason: "checkout_expired" }),
    true,
  )
  assert.equal(
    isPremiumSheetPurchaseTerminal({ phase: "provisioning", sessionId: SESSION, retryable: false }),
    true,
  )
  assert.equal(isPremiumSheetPurchaseTerminal({ phase: "pending", sessionId: SESSION }), false)
  assert.equal(
    isPremiumSheetPurchaseTerminal({ phase: "provisioning", sessionId: SESSION, retryable: true }),
    false,
  )
})

test("Y4: an expired or abandoned Session is a failure with its own reason, retryable by CTA", () => {
  for (const reason of [
    "checkout_expired",
    "checkout_abandoned",
    "subscription_already_active",
  ] as const) {
    const state = run([
      start,
      ready,
      completed,
      { type: "verification_failed", sessionId: SESSION, reason },
    ])
    assert.deepEqual(state, { phase: "failed", reason })
    assert.equal(
      isPremiumSheetPlanSelectionActive(state),
      true,
      "a new checkout must be one tap away",
    )
  }
})
