/**
 * The Premium sheet's purchase machine (freemium-scanner-first T14).
 *
 * Pure and React-free so the states that matter — and above all the ones that must NOT
 * unlock anything — are testable without a browser. The sheet renders one of these
 * phases; the component owns only the effects (fetch, Stripe mount, refresh, toast).
 *
 * The journey's shape, in states:
 *
 *   plans ──(CTA)──▶ starting ──▶ paying ──(Stripe onComplete)──▶ verifying
 *                        │                                            │
 *                        │                          ┌─────────────────┼─────────────────┐
 *                        ▼                          ▼                 ▼                 ▼
 *                     failed ◀──────────────────  pending      provisioning        unlocked
 *
 * Four rules the type system enforces here rather than leaving to the component:
 *
 *  1. **Only the server unlocks.** `unlocked` is reachable only from a verified
 *     completion (`verification_complete`), never from Stripe's client callback — that
 *     callback moves the machine to `verifying` and nothing else.
 *  2. **Failure never costs the free session.** Every failure and every escape lands back
 *     in `plans` (or holds `failed` with a retry), inside the same mounted sheet. Nothing
 *     in this machine navigates, and nothing clears scan state.
 *  3. **Outcomes are bound to the attempt that produced them** (Codex fix wave, Y5). Every
 *     async callback the checkout mount raises carries the `attemptId` it was created for,
 *     and an outcome whose attempt is no longer the current one is DROPPED. Without that,
 *     a slow failure from attempt A landing after the buyer restarted as attempt B replaces
 *     B's live payment form with A's failure screen.
 *  4. **Verification outcomes are bound to their Session id.** Polling (`pending` /
 *     `provisioning`) means several verification requests can be in flight across a phase
 *     change; an answer about a Session the machine is no longer waiting on is dropped.
 */

import type { BillingInterval } from "@/lib/stripe/intervals"

export type PremiumSheetPurchasePhase =
  /** Plan selection — the T13 sheet, unchanged. */
  | { phase: "plans" }
  /** CTA pressed; the checkout session is being created. */
  | { phase: "starting"; interval: BillingInterval; attemptId: string }
  /** Embedded checkout is mounted and the buyer is paying. */
  | { phase: "paying"; interval: BillingInterval; attemptId: string }
  /** Stripe says the form finished; the server is deciding whether money moved. */
  | { phase: "verifying"; interval: BillingInterval; attemptId: string; sessionId: string }
  /** Verified: entitlement is live. `routineReady` says whether content is there yet. */
  | { phase: "unlocked"; routineReady: boolean }
  /** An asynchronous payment is still settling; the webhook will finish it. */
  | { phase: "pending"; sessionId: string }
  /**
   * Paid and entitled, but the plan itself could NOT be provisioned on this call (Codex fix
   * wave, Y1). The buyer's access is recorded server-side; the Routine is not there yet.
   * `retryable` says whether polling can still converge — a transient server failure can,
   * a missing quiz artifact or a foreign enrollment cannot.
   */
  | { phase: "provisioning"; sessionId: string; retryable: boolean }
  /** Recoverable: the sheet shows the reason and one retry back into `plans`. */
  | { phase: "failed"; reason: PremiumSheetPurchaseFailure }

export type PremiumSheetPurchaseFailure =
  /** The checkout session could not be created (network, config, server). */
  | "checkout_unavailable"
  /** Stripe.js or the embedded form could not load. */
  | "provider_unavailable"
  /** The server refused or could not verify the completed session. */
  | "verification_failed"
  /** The Checkout Session expired before the buyer paid (Codex fix wave, Y4). */
  | "checkout_expired"
  /** The buyer came back without paying — Stripe still reports the Session as `open`. */
  | "checkout_abandoned"

export type PremiumSheetPurchaseEvent =
  | { type: "checkout_requested"; interval: BillingInterval; attemptId: string }
  | { type: "checkout_ready"; attemptId: string }
  | { type: "checkout_failed"; reason: PremiumSheetPurchaseFailure; attemptId?: string }
  /**
   * Stripe's embedded `onComplete` (carries its attempt), or a contextual redirect return /
   * a resumed pending verification (no attempt — the mount that owned it is gone).
   */
  | { type: "provider_completed"; sessionId: string; attemptId?: string }
  | { type: "verification_complete"; sessionId: string; routineReady: boolean }
  | { type: "verification_pending"; sessionId: string }
  | { type: "verification_provisioning"; sessionId: string; retryable: boolean }
  | { type: "verification_failed"; sessionId: string; reason: PremiumSheetPurchaseFailure }
  /** Any escape the buyer takes: back to plans, the X, backdrop, Escape. */
  | { type: "returned_to_plans" }

export const initialPremiumSheetPurchaseState: PremiumSheetPurchasePhase = { phase: "plans" }

/**
 * An attempt-bound outcome is actionable only while its attempt is the current one. An
 * event with no attempt identity (the redirect return, a resumed verification) is not
 * attempt-bound and always applies.
 */
function attemptIsCurrent(state: PremiumSheetPurchasePhase, attemptId?: string): boolean {
  if (attemptId === undefined) return true
  return "attemptId" in state && state.attemptId === attemptId
}

/** The phases that are waiting on a verification answer, and for which Session. */
function awaitsSession(state: PremiumSheetPurchasePhase, sessionId: string): boolean {
  if (state.phase !== "verifying" && state.phase !== "pending" && state.phase !== "provisioning") {
    return false
  }
  return state.sessionId === sessionId
}

export function premiumSheetPurchaseReducer(
  state: PremiumSheetPurchasePhase,
  event: PremiumSheetPurchaseEvent,
): PremiumSheetPurchasePhase {
  switch (event.type) {
    case "checkout_requested":
      // Guarded against a double CTA press: a checkout already in flight is not restarted,
      // which would strand the first Stripe session.
      if (state.phase !== "plans" && state.phase !== "failed") return state
      return { phase: "starting", interval: event.interval, attemptId: event.attemptId }
    case "checkout_ready":
      if (state.phase !== "starting") return state
      if (!attemptIsCurrent(state, event.attemptId)) return state
      return { phase: "paying", interval: state.interval, attemptId: state.attemptId }
    case "checkout_failed":
      // A provider failure after the payment finished must not overwrite a verified
      // unlock, a pending payment or a paid-but-unprovisioned state — money outranks widget.
      if (
        state.phase === "unlocked" ||
        state.phase === "pending" ||
        state.phase === "provisioning"
      ) {
        return state
      }
      // …and a failure from an attempt the buyer already replaced must not overwrite the
      // live one (Y5).
      if (!attemptIsCurrent(state, event.attemptId)) return state
      return { phase: "failed", reason: event.reason }
    case "provider_completed":
      if (state.phase === "unlocked") return state
      if (!attemptIsCurrent(state, event.attemptId)) return state
      return {
        phase: "verifying",
        // A contextual redirect return re-enters the machine at `plans`, with no live
        // interval/attempt to carry — the session id is the only thing verification needs.
        interval: "interval" in state ? state.interval : "year",
        attemptId: "attemptId" in state ? state.attemptId : "",
        sessionId: event.sessionId,
      }
    case "verification_complete":
      if (!awaitsSession(state, event.sessionId)) return state
      return { phase: "unlocked", routineReady: event.routineReady }
    case "verification_pending":
      if (!awaitsSession(state, event.sessionId)) return state
      return { phase: "pending", sessionId: event.sessionId }
    case "verification_provisioning":
      if (!awaitsSession(state, event.sessionId)) return state
      return { phase: "provisioning", sessionId: event.sessionId, retryable: event.retryable }
    case "verification_failed":
      if (!awaitsSession(state, event.sessionId)) return state
      return { phase: "failed", reason: event.reason }
    case "returned_to_plans":
      // An unlocked purchase is terminal: the sheet is closing into the unlocked world and
      // must never fall back to showing plans the buyer has already paid for. A paid but
      // unprovisioned purchase is terminal for the same reason — the money moved.
      if (state.phase === "unlocked" || state.phase === "provisioning") return state
      return { phase: "plans" }
    default:
      return state
  }
}

/** The sheet's plan rows and CTA are interactive only while no payment is in flight. */
export function isPremiumSheetPlanSelectionActive(state: PremiumSheetPurchasePhase): boolean {
  return state.phase === "plans" || state.phase === "failed"
}

/** Escapes stay available throughout — a payment sheet must never trap the buyer. */
export function premiumSheetShowsCheckout(state: PremiumSheetPurchasePhase): boolean {
  return state.phase === "starting" || state.phase === "paying"
}

/**
 * The Session a verification poll should ask about, or `null` when nothing is outstanding.
 * `provisioning` polls only while the server called the failure retryable.
 */
export function premiumSheetPollableSessionId(state: PremiumSheetPurchasePhase): string | null {
  if (state.phase === "pending") return state.sessionId
  if (state.phase === "provisioning" && state.retryable) return state.sessionId
  return null
}

/**
 * Whether the purchase has reached a state that will not change on its own — the point at
 * which the remembered checkout context and the resumable Session id must be dropped.
 */
export function isPremiumSheetPurchaseTerminal(state: PremiumSheetPurchasePhase): boolean {
  if (state.phase === "unlocked" || state.phase === "failed") return true
  return state.phase === "provisioning" && !state.retryable
}
