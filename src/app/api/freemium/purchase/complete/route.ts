import { NextResponse } from "next/server"
import { z } from "zod"
import type Stripe from "stripe"

import { getPremiumTierId } from "@/lib/billing/tier-ids"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import { freemiumCheckoutUserId, isFreemiumCheckoutSession } from "@/lib/freemium/checkout-metadata"
import { createFreemiumProvisioningService } from "@/lib/freemium/plan-provisioning"
import type { FreemiumProvisioningResult } from "@/lib/freemium/plan-provisioning"
import { createFreemiumProvisioningSupabaseDependencies } from "@/lib/freemium/plan-provisioning-supabase"
import { captureCheckoutException } from "@/lib/observability/checkout"
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
 */

export const runtime = "nodejs"
export const maxDuration = 60

const rate: RateLimitConfig = {
  prefix: "freemium-purchase-complete",
  limit: 20,
  windowMs: 60_000,
}

const bodySchema = z.object({ sessionId: z.string().startsWith("cs_").max(200) }).strict()

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
  provision: (input: {
    userId: string
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

    let provisioning: FreemiumProvisioningResult
    try {
      provisioning = await deps.provision({ userId: user.id, providerReference: session.id })
    } catch (error) {
      deps.captureException?.(error, {
        provider: "stripe",
        stage: "stripe_webhook_activation",
        source: "premium_sheet",
        stripeSessionId: sessionId,
        reason: "freemium_provisioning_failed",
      })
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
      outcome: provisioning.outcome,
      routineAccepted:
        provisioning.outcome === "provisioned" ? provisioning.routineAccepted : false,
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
          provider: "stripe",
          stage: "stripe_webhook_activation",
          source: "premium_sheet",
          stripeSessionId: sessionId,
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
      provider: "stripe",
      stage: "stripe_webhook_activation",
      source: "premium_sheet",
      stripeSessionId: sessionId,
      reason: "freemium_provisioning_blocked",
    })
    return json({ status: "provisioning", retryable: false, reason })
  }
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
  provision: ({ userId, providerReference }) =>
    createFreemiumProvisioningService(
      createFreemiumProvisioningSupabaseDependencies(createAdminClient() as never),
    ).provisionAfterPurchase({ userId, provider: "stripe", providerReference }),
  captureException: captureCheckoutException,
})
