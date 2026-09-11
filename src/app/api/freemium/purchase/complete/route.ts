import { NextResponse } from "next/server"
import { z } from "zod"
import type Stripe from "stripe"

import { getPremiumTierId } from "@/lib/billing/tier-ids"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import { freemiumCheckoutUserId, isFreemiumCheckoutSession } from "@/lib/freemium/checkout-metadata"
import { createFreemiumProvisioningService } from "@/lib/freemium/plan-provisioning"
import type {
  FreemiumProvisioningResult,
  FreemiumPurchaseProvider,
} from "@/lib/freemium/plan-provisioning"
import { createFreemiumProvisioningSupabaseDependencies } from "@/lib/freemium/plan-provisioning-supabase"
import { captureCheckoutException } from "@/lib/observability/checkout"
import {
  ensurePayPalCheckoutAccountForToken,
  PayPalCheckoutActivationError,
  type PayPalCheckoutAccountResult,
} from "@/lib/paypal/checkout-activation"
import { findPayPalCheckoutIntentByToken } from "@/lib/paypal/checkout-intents"
import { linkQuizToProfile } from "@/lib/quiz/link-to-profile"
import {
  checkRateLimit,
  fixedWindowRetryAfterSeconds,
  type RateLimitConfig,
} from "@/lib/rate-limit"
import {
  assertCheckoutSessionActivatable,
  CheckoutActivationError,
  ensureCheckoutAccount,
  retrieveCheckoutSessionForActivation,
  type CheckoutAccountResult,
} from "@/lib/stripe/checkout-activation"
import { getStripe } from "@/lib/stripe/client"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

/**
 * Contextual purchase completion for the Premium sheet (freemium-scanner-first T14).
 *
 * Stripe's embedded `onComplete` callback is a CLIENT signal — it says the payment form
 * finished, not that money moved, and a determined browser can call it whenever it likes.
 * So the sheet does not unlock anything on that callback; it calls this endpoint, which
 * re-reads the Checkout Session from Stripe and decides.
 *
 * Four outcomes the sheet can act on:
 *   - `complete`     — payment verified, account activated, plan admitted and provisioned.
 *     The sheet closes into the unlocked surface.
 *   - `provisioning` — payment verified and the entitlement is LIVE, but the plan itself
 *     could not be built on this call (Codex fix wave, Y1). Reporting `complete` here would
 *     be a lie: the buyer would be told „Alles freigeschaltet" over an empty Routine. The
 *     sheet says so instead and polls; `retryable` says whether polling can converge.
 *   - `pending`      — an asynchronous payment method is still settling (or the Session has
 *     no subscription yet). The sheet shows its processing state; the webhook lane finishes
 *     the same work when the payment lands, and a later poll flips to `complete`.
 *   - `failed`       — the Session is terminally unusable: expired, abandoned (Stripe still
 *     reports it `open`), or the wrong owner shape. The sheet returns to plan selection with
 *     the free session untouched and one retry.
 *
 * Ownership: the Session must carry this program's marker AND this user's id, and the
 * activation result must resolve to the same user. Anything else is a 403 — a completion
 * callback must never be able to admit somebody else's purchase.
 *
 * Everything after the payment check is idempotent (see `plan-provisioning.ts`), so a
 * double callback, a refresh mid-payment and the webhook all converge on one admission,
 * one plan pin and one Routine.
 *
 * **Two providers, one contract (docket rework R1).** The sheet's native PayPal button
 * produces different evidence — a checkout-intent token, not a Checkout Session id — so the
 * request carries `paypalToken` instead of `sessionId` and is verified the way `/welcome`
 * verifies PayPal today (`ensurePayPalCheckoutAccountForToken`, which re-reads the
 * subscription from PayPal). The security bar is identical: server-verified, ownership
 * checked before any classification, and the activation's own resolved user must match the
 * caller. Both lanes then share one provisioning tail, because a proven purchase is worth
 * the same whichever provider proved it.
 */

export const runtime = "nodejs"
export const maxDuration = 60

const rate: RateLimitConfig = {
  prefix: "freemium-purchase-complete",
  limit: 20,
  windowMs: 60_000,
}

/**
 * One request shape per provider — never both, never neither (docket rework R1). The
 * sheet's card lane hands back a Stripe Checkout Session id; its PayPal lane hands back
 * the checkout-intent token that the SAME PayPal button already gives `/welcome` today,
 * which is the only handle either surface has on a PayPal approval.
 */
const bodySchema = z.union([
  z.object({ sessionId: z.string().startsWith("cs_").max(200) }).strict(),
  z.object({ paypalToken: z.string().min(16).max(200) }).strict(),
])

/**
 * Activation codes that mean "not settled yet", as opposed to "will never settle".
 *
 * `checkout_session_incomplete` is deliberately NOT in this set any more (Codex fix wave,
 * Y4). It is raised for every Session whose `status` is not `complete` — including `expired`
 * and `open` — so treating it as pending told a buyer whose Session had expired, or who came
 * back without paying, that their payment was still being checked. Those two are classified
 * by the Session's own lifecycle status below, before activation is ever asserted; a Session
 * that reaches the assertion with no lifecycle status at all is the only remaining case, and
 * for that "still settling" is the safe reading.
 */
const PENDING_ACTIVATION_CODES = new Set([
  "checkout_session_unpaid",
  "checkout_session_incomplete",
  "checkout_session_subscription_missing",
])

export type FreemiumPurchaseCompletionResponse =
  | { status: "complete"; routineReady: boolean }
  | { status: "provisioning"; retryable: boolean; reason: string }
  | { status: "pending" }
  | { status: "failed"; reason: string }

export type FreemiumPurchaseCompletionDeps = {
  enabled: () => boolean
  getUser: () => Promise<{ id: string } | null>
  checkRateLimit: typeof checkRateLimit
  /** Raw retrieve — no payment-state assertions, so ownership can be checked first (F6). */
  retrieveSession: (sessionId: string) => Promise<Stripe.Checkout.Session>
  /** The assertion half: throws `CheckoutActivationError` for a Session that cannot activate. */
  assertActivatable: (session: Stripe.Checkout.Session) => void
  activate: (session: Stripe.Checkout.Session) => Promise<CheckoutAccountResult>
  /**
   * PayPal lane (docket rework R1). The intent row is the ownership record — it carries the
   * `user_id` the sheet's button created it for — and its bound subscription id is the
   * provider reference the plan is provisioned against.
   */
  findPayPalIntent: (token: string) => Promise<{
    userId: string | null
    providerSubscriptionId: string | null
  } | null>
  /**
   * Exactly what `/welcome` calls to verify a PayPal approval today
   * (`ensurePayPalCheckoutAccountForToken` behind `GET /api/paypal/activation-status`):
   * it re-reads the subscription from PayPal, and only an ACTIVE one activates an account.
   */
  activatePayPal: (token: string) => Promise<PayPalCheckoutAccountResult>
  provision: (input: {
    userId: string
    provider: FreemiumPurchaseProvider
    providerReference: string
  }) => Promise<FreemiumProvisioningResult>
  captureException?: typeof captureCheckoutException
}

function json(
  body: FreemiumPurchaseCompletionResponse | { error: string },
  status = 200,
  headers?: HeadersInit,
) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } })
}

export function createFreemiumPurchaseCompletionHandler(deps: FreemiumPurchaseCompletionDeps) {
  return async function POST(request: Request): Promise<NextResponse> {
    if (!deps.enabled()) return json({ error: "not_found" }, 404)
    const user = await deps.getUser()
    if (!user) return json({ error: "unauthorized" }, 401)

    const limited = await deps.checkRateLimit(user.id, rate)
    if (!limited.allowed) {
      const unavailable = limited.error === "service_unavailable"
      return json(
        { error: unavailable ? "temporarily_unavailable" : "rate_limited" },
        unavailable ? 503 : 429,
        unavailable ? undefined : { "Retry-After": String(fixedWindowRetryAfterSeconds(rate)) },
      )
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return json({ error: "invalid_request" }, 400)
    if ("paypalToken" in parsed.data) {
      return completePayPalPurchase(deps, user.id, parsed.data.paypalToken)
    }
    const { sessionId } = parsed.data

    let session: Stripe.Checkout.Session
    try {
      session = await deps.retrieveSession(sessionId)
    } catch (error) {
      deps.captureException?.(error, {
        provider: "stripe",
        stage: "checkout_return",
        source: "premium_sheet",
        stripeSessionId: sessionId,
        reason: "freemium_completion_session_unreadable",
      })
      return json({ error: "temporarily_unavailable" }, 503)
    }

    // Ownership FIRST, before the Session's payment state is classified (fix round 1, F6).
    // Both halves matter: the marker proves THIS app created the Session for the sheet, the
    // user id proves it was created for THIS user. Running the classification first would
    // turn this endpoint into an oracle — an authenticated caller could tell an unpaid
    // Session from a terminally unusable one for any `cs_…` id they can guess.
    if (!isFreemiumCheckoutSession(session) || freemiumCheckoutUserId(session) !== user.id) {
      return json({ error: "forbidden" }, 403)
    }

    // The Session's OWN lifecycle status decides retryability before any activation code is
    // consulted (Codex fix wave, Y4). Stripe's embedded checkout returns the buyer here for
    // every outcome, not just success: a Session the buyer abandoned is still `open`, and one
    // they left long enough is `expired`. Both are terminal for this attempt and both must
    // reach the sheet's failure screen, which offers a fresh checkout — reporting them as
    // `pending` left the buyer watching a spinner for a payment that will never happen.
    if (session.status === "expired") {
      return json({ status: "failed", reason: "checkout_session_expired" })
    }
    if (session.status === "open") {
      return json({ status: "failed", reason: "checkout_session_abandoned" })
    }

    try {
      deps.assertActivatable(session)
    } catch (error) {
      if (error instanceof CheckoutActivationError) {
        if (PENDING_ACTIVATION_CODES.has(error.code)) return json({ status: "pending" })
        return json({ status: "failed", reason: error.code })
      }
      deps.captureException?.(error, {
        provider: "stripe",
        stage: "checkout_return",
        source: "premium_sheet",
        stripeSessionId: sessionId,
        reason: "freemium_completion_session_unreadable",
      })
      return json({ error: "temporarily_unavailable" }, 503)
    }

    let account: CheckoutAccountResult
    try {
      account = await deps.activate(session)
    } catch (error) {
      if (error instanceof CheckoutActivationError) {
        if (PENDING_ACTIVATION_CODES.has(error.code)) return json({ status: "pending" })
        deps.captureException?.(error, {
          provider: "stripe",
          stage: "stripe_webhook_activation",
          source: "premium_sheet",
          stripeSessionId: sessionId,
          reason: error.code,
        })
        return json({ status: "failed", reason: error.code })
      }
      deps.captureException?.(error, {
        provider: "stripe",
        stage: "stripe_webhook_activation",
        source: "premium_sheet",
        stripeSessionId: sessionId,
        reason: "freemium_completion_activation_failed",
      })
      return json({ error: "temporarily_unavailable" }, 503)
    }

    // Activation resolves the account by Stripe customer/email, independently of the
    // metadata. If it lands on a different account than the caller, the two identities
    // disagree and nothing may be unlocked for either.
    if (account.userId !== user.id) return json({ error: "forbidden" }, 403)

    return provisionAndAnswer(deps, {
      userId: user.id,
      provider: "stripe",
      providerReference: session.id,
      reportTarget: {
        provider: "stripe",
        stage: "stripe_webhook_activation",
        stripeSessionId: sessionId,
      },
    })
  }
}

/**
 * The PayPal half of the contextual completion (docket rework R1).
 *
 * The sheet's PayPal button is the offer page's button, unchanged except for where it
 * routes when the approval comes back. So the evidence it produces is the offer page's
 * evidence — a checkout-intent token — and this lane verifies it exactly the way
 * `/welcome` does: `ensurePayPalCheckoutAccountForToken` re-reads the subscription from
 * PayPal and activates an account only for an ACTIVE one. Nothing here trusts the browser:
 * the token names an intent row, not an entitlement.
 *
 * Ownership is checked FIRST, for the same reason as the Stripe lane's marker check (F6):
 * without it an authenticated caller could probe arbitrary tokens for their settlement
 * state. The intent's `user_id` is written when the sheet creates the intent server-side,
 * and the activation's own resolved user must agree with it before anything is unlocked.
 */
async function completePayPalPurchase(
  deps: FreemiumPurchaseCompletionDeps,
  userId: string,
  token: string,
): Promise<NextResponse> {
  let intent: Awaited<ReturnType<FreemiumPurchaseCompletionDeps["findPayPalIntent"]>>
  try {
    intent = await deps.findPayPalIntent(token)
  } catch (error) {
    deps.captureException?.(error, {
      provider: "paypal",
      stage: "checkout_return",
      source: "premium_sheet",
      paypalTokenPresent: true,
      reason: "freemium_completion_paypal_intent_unreadable",
    })
    return json({ error: "temporarily_unavailable" }, 503)
  }

  // Ownership before classification. An unknown token and a foreign one answer alike.
  if (!intent || intent.userId !== userId) return json({ error: "forbidden" }, 403)

  // No subscription bound yet: the buyer has not finished the PayPal approval, or the
  // approve call has not landed. Nothing to verify, and nothing has failed.
  if (!intent.providerSubscriptionId) return json({ status: "pending" })

  let activation: PayPalCheckoutAccountResult
  try {
    activation = await deps.activatePayPal(token)
  } catch (error) {
    if (error instanceof PayPalCheckoutActivationError) {
      deps.captureException?.(error, {
        provider: "paypal",
        stage: "paypal_approve_subscription",
        source: "premium_sheet",
        paypalSubscriptionId: intent.providerSubscriptionId,
        paypalTokenPresent: true,
        reason: error.code,
      })
      return json({ status: "failed", reason: error.code })
    }
    deps.captureException?.(error, {
      provider: "paypal",
      stage: "paypal_approve_subscription",
      source: "premium_sheet",
      paypalSubscriptionId: intent.providerSubscriptionId,
      paypalTokenPresent: true,
      reason: "freemium_completion_paypal_activation_failed",
    })
    return json({ error: "temporarily_unavailable" }, 503)
  }

  // PayPal has the approval but the subscription is not ACTIVE yet — the same
  // "still settling" state the card lane reaches, and the sheet polls it the same way.
  if (activation.status === "pending") return json({ status: "pending" })
  // The duplicate guard already cancelled this subscription; the buyer keeps the access
  // they already had. Terminal for this attempt.
  if (activation.status === "duplicate") {
    return json({ status: "failed", reason: "paypal_duplicate_checkout" })
  }
  // Activation resolves the account from PayPal's own subscriber identity. If that is not
  // the caller, the two identities disagree and nothing is unlocked for either.
  if (activation.userId !== userId) return json({ error: "forbidden" }, 403)

  return provisionAndAnswer(deps, {
    userId,
    provider: "paypal",
    providerReference: intent.providerSubscriptionId,
    reportTarget: {
      provider: "paypal",
      stage: "paypal_approve_subscription",
      paypalSubscriptionId: intent.providerSubscriptionId,
      paypalTokenPresent: true,
    },
  })
}

/** Where a provisioning report points, per provider — never the other lane's coordinates. */
type FreemiumCompletionReportTarget =
  | { provider: "stripe"; stage: "stripe_webhook_activation"; stripeSessionId: string }
  | {
      provider: "paypal"
      stage: "paypal_approve_subscription"
      paypalSubscriptionId: string
      paypalTokenPresent: true
    }

/**
 * Everything after "the money is verified and the account is this caller's": admit the
 * buyer, build the plan, and answer honestly about what actually exists. Shared verbatim
 * by both lanes — a PayPal purchase and a card purchase differ in how they are PROVEN,
 * never in what a proven purchase is worth (docket rework R1).
 */
async function provisionAndAnswer(
  deps: FreemiumPurchaseCompletionDeps,
  input: {
    userId: string
    provider: FreemiumPurchaseProvider
    providerReference: string
    /** Provider-shaped Sentry coordinates, so neither lane reports as the other. */
    reportTarget: FreemiumCompletionReportTarget
  },
): Promise<NextResponse> {
  const report = { ...input.reportTarget, source: "premium_sheet" } as const
  let provisioning: FreemiumProvisioningResult
  try {
    provisioning = await deps.provision({
      userId: input.userId,
      provider: input.provider,
      providerReference: input.providerReference,
    })
  } catch (error) {
    deps.captureException?.(error, { ...report, reason: "freemium_provisioning_failed" })
    provisioning = { outcome: "temporarily_unavailable", stage: "admission" }
  }

  // The payment is real and the entitlement is live either way — a degraded provisioning
  // outcome must never present as a failed purchase.
  //
  // But it must not present as a COMPLETE one either (Codex fix wave, Y1). Before this,
  // every non-`provisioned` outcome returned `{status:"complete", routineReady:false}`,
  // which the sheet renders as „Alles freigeschaltet" plus a promise that the Routine is
  // being built — over a buyer who has no admission row, no plan and nothing being built.
  // `provisioning` is the honest state: access is recorded, content is not there yet, and
  // the sheet keeps asking (or stops, when asking cannot help).
  console.info("[freemium] purchase completion", {
    provider: input.provider,
    outcome: provisioning.outcome,
    routineAccepted: provisioning.outcome === "provisioned" ? provisioning.routineAccepted : false,
  })

  if (provisioning.outcome === "provisioned" && provisioning.routineAccepted) {
    return json({ status: "complete", routineReady: true })
  }

  // Admitted, pinned and derived, but the Routine is not ACTIVE yet — the webhook lane
  // (`provisionFreemiumCheckoutSession`) already calls this exact condition retryable
  // (`routine_not_accepted`), not complete. This endpoint used to answer `complete` here,
  // which told the sheet to toast „Alles freigeschaltet" and close over a gate that was
  // still locked (Codex fix wave round 2, R2). Reporting the same honest in-progress state
  // both lanes agree on keeps the sheet polling until the Routine is really there.
  if (provisioning.outcome === "provisioned") {
    return json({ status: "provisioning", retryable: true, reason: "routine_not_accepted" })
  }

  if (provisioning.outcome === "temporarily_unavailable") {
    deps.captureException?.(
      new Error(`freemium provisioning unavailable at ${provisioning.stage}`),
      {
        ...report,
        reason: "freemium_provisioning_unavailable",
      },
    )
    return json({ status: "provisioning", retryable: true, reason: provisioning.stage })
  }

  // `no_quiz_artifact` / `enrollment_conflict`: a retry changes nothing, so the sheet is
  // told to stop polling. The buyer keeps the entitlement they paid for; the report is
  // what gets a human to the plan that could not be built.
  const reason =
    provisioning.outcome === "enrollment_conflict"
      ? (provisioning.reasonCode ?? "enrollment_conflict")
      : provisioning.outcome
  deps.captureException?.(new Error(`freemium provisioning blocked: ${reason}`), {
    ...report,
    reason: "freemium_provisioning_blocked",
  })
  return json({ status: "provisioning", retryable: false, reason })
}

export const POST = createFreemiumPurchaseCompletionHandler({
  enabled: isFreemiumScannerFirstEnabled,
  getUser: async () => {
    const { data } = await (await createClient()).auth.getUser()
    return data.user ? { id: data.user.id } : null
  },
  checkRateLimit,
  retrieveSession: (sessionId) => retrieveCheckoutSessionForActivation(sessionId, getStripe()),
  assertActivatable: assertCheckoutSessionActivatable,
  activate: async (session) => {
    const admin = createAdminClient()
    return ensureCheckoutAccount(session, {
      supabase: admin,
      stripe: getStripe(),
      premiumTierId: await getPremiumTierId(admin),
      linkQuizToProfile,
    })
  },
  findPayPalIntent: async (token) => {
    const intent = await findPayPalCheckoutIntentByToken(createAdminClient(), token)
    if (!intent) return null
    return { userId: intent.user_id, providerSubscriptionId: intent.provider_subscription_id }
  },
  activatePayPal: async (token) => {
    const admin = createAdminClient()
    return ensurePayPalCheckoutAccountForToken(token, {
      supabase: admin,
      premiumTierId: await getPremiumTierId(admin),
      linkQuizToProfile,
    })
  },
  provision: ({ userId, provider, providerReference }) =>
    createFreemiumProvisioningService(
      createFreemiumProvisioningSupabaseDependencies(createAdminClient() as never),
    ).provisionAfterPurchase({ userId, provider, providerReference }),
  captureException: captureCheckoutException,
})
