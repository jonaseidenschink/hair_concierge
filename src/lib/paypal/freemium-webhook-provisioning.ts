import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import type { FreemiumProvisioningResult } from "@/lib/freemium/plan-provisioning"
import { captureCheckoutException } from "@/lib/observability/checkout"
import type { PayPalCheckoutIntentRow } from "@/lib/paypal/checkout-intents"
// Type-only, so nothing of the Stripe lane is pulled into the PayPal bundle: the outcome
// union IS the shared durability contract, and both lanes answering in the same four words
// is the point (docket rework R1 follow-up). Duplicating it would let the two drift.
import type { FreemiumWebhookProvisioningOutcome } from "@/lib/stripe/webhook-handlers"

/**
 * Freemium (Premium-sheet) post-purchase provisioning, run from the **PayPal** webhook lane.
 *
 * Stripe's webhook has carried this since T14; PayPal's did not, and that gap was the one
 * open concern the R1 rework left behind. A buyer who approves in the PayPal popup and
 * closes the tab before the sheet's verification call lands got the entitlement — PayPal's
 * `BILLING.SUBSCRIPTION.ACTIVATED` activates the account either way — but no admission row,
 * no plan and no Routine, because only the sheet's own completion call provisioned those.
 * The card lane had a safety net for exactly that buyer; the PayPal lane had none.
 *
 * This module is that net, deliberately identical to `provisionFreemiumCheckoutSession` in
 * `@/lib/stripe/webhook-handlers` except for the provider-shaped identity:
 *
 *   - **Admission is never inferred.** A PayPal subscription becomes freemium work only when
 *     its checkout intent was created by the sheet (`source: "premium_sheet"`, which only
 *     `create-subscription-intent` writes) and only while the flag is on. Every legacy
 *     pricing-page and quiz-offer subscription takes exactly the path it took before.
 *   - **Identity must agree.** The intent's `user_id` is what the sheet recorded server-side;
 *     the activation resolves its own account from PayPal's subscriber identity. If those
 *     disagree, nothing is provisioned for either — the plan's
 *     `enrollment_purchase_source_id` pin is permanent and never self-heals.
 *   - **Failure must reach PayPal.** A retryable outcome throws, the webhook handler's own
 *     catch releases the event claim, and the route answers 500 so PayPal redelivers. That
 *     is the whole reason this is awaited inside the response rather than deferred: deferred
 *     work fails after the response, with the event already claimed, which is unreachable by
 *     any redelivery — i.e. permanently paid-and-unprovisioned.
 *   - **Redelivery is free.** Both lanes call the same reuse-based service, so whichever
 *     arrives first provisions and everything after it is a no-op.
 */

/** Only the two intent columns that decide admission — nothing else is read here. */
export type FreemiumPayPalWebhookIntent = Pick<PayPalCheckoutIntentRow, "source" | "user_id">

export type PayPalWebhookFreemiumProvisioningDeps = {
  freemiumEnabled?: () => boolean
  provisionFreemiumPurchase?: (input: {
    userId: string
    providerReference: string
  }) => Promise<FreemiumProvisioningResult>
  /** Test seam for the failure reports below; production uses `captureCheckoutException`. */
  captureFreemiumProvisioningException?: typeof captureCheckoutException
}

/**
 * The synchronous half of the guard, so the webhook can decide whether there is any freemium
 * work at all BEFORE doing anything — every legacy PayPal subscription must leave the
 * handler's behaviour exactly as it was.
 */
export function freemiumPayPalProvisioningUserId(
  intent: FreemiumPayPalWebhookIntent | null | undefined,
  deps: Pick<PayPalWebhookFreemiumProvisioningDeps, "freemiumEnabled">,
): string | null {
  const enabled = deps.freemiumEnabled ?? isFreemiumScannerFirstEnabled
  if (!enabled()) return null
  if (!intent || intent.source !== "premium_sheet") return null
  const userId = intent.user_id?.trim()
  return userId ? userId : null
}

/**
 * How long the webhook will wait for provisioning before failing the delivery instead.
 *
 * Same reasoning as the Stripe lane's budget, with the platform rather than the provider as
 * the binding clock: if the chain outran the function's `maxDuration`, the invocation would
 * be killed with the event still claimed — `releaseWebhookEventClaim` lives in a `catch` and
 * a kill is not catchable — and the redelivery would then be dropped as a duplicate. Giving
 * up first keeps the failure inside our own hands, where the claim gets released. Every
 * provisioning step is reuse-based, so the abandoned run costs nothing.
 */
export const FREEMIUM_PAYPAL_WEBHOOK_PROVISIONING_BUDGET_MS = 20_000

/**
 * Thrown by `runFreemiumPayPalSubscriptionProvisioning` when the delivery must be failed so
 * PayPal redelivers it. `handlePayPalWebhookEvent`'s own catch is what turns this into the
 * durable retry: it releases the event claim and rethrows, and the route answers 500.
 */
export class FreemiumPayPalWebhookProvisioningRetryError extends Error {
  readonly paypalSubscriptionId: string
  readonly reason: string

  constructor(paypalSubscriptionId: string, reason: string) {
    super(`freemium PayPal provisioning must be retried (${reason})`)
    this.name = "FreemiumPayPalWebhookProvisioningRetryError"
    this.paypalSubscriptionId = paypalSubscriptionId
    this.reason = reason
  }
}

export async function provisionFreemiumPayPalSubscription(
  intent: FreemiumPayPalWebhookIntent | null | undefined,
  deps: PayPalWebhookFreemiumProvisioningDeps,
  /**
   * What the ACTIVATION resolved: the account PayPal's own subscriber identity landed on,
   * and the subscription id that account is now paying through. The subscription id is also
   * the provider reference the plan is provisioned against — the same one the sheet's
   * completion endpoint uses, so the two lanes converge on one admission.
   */
  activation: { userId: string; subscriptionId: string },
): Promise<FreemiumWebhookProvisioningOutcome> {
  const userId = freemiumPayPalProvisioningUserId(intent, deps)
  if (!userId) return { status: "skipped" }
  const capture = deps.captureFreemiumProvisioningException ?? captureCheckoutException
  if (userId !== activation.userId) {
    console.error("[freemium] paypal webhook provisioning identity mismatch", {
      paypalSubscriptionId: activation.subscriptionId,
    })
    capture(new Error("freemium webhook provisioning identity mismatch"), {
      provider: "paypal",
      stage: "paypal_webhook_ingestion",
      source: "premium_sheet",
      paypalSubscriptionId: activation.subscriptionId,
      reason: "freemium_webhook_identity_mismatch",
    })
    // Redelivering cannot change which account the activation resolves to.
    return { status: "blocked", reason: "identity_mismatch" }
  }

  const provision = deps.provisionFreemiumPurchase ?? defaultProvisionFreemiumPayPalPurchase
  let result: FreemiumProvisioningResult
  try {
    result = await provision({ userId, providerReference: activation.subscriptionId })
  } catch (error) {
    // The provisioning service marks nothing "done" until it is done — admission is a reused
    // row, the initial need reuses its `(plan, input_hash)` row and acceptance is CAS-guarded
    // — so an interrupted run is safe to run again from the top.
    console.error("[freemium] paypal webhook provisioning failed", {
      paypalSubscriptionId: activation.subscriptionId,
      error,
    })
    capture(error, {
      provider: "paypal",
      stage: "paypal_webhook_ingestion",
      source: "premium_sheet",
      paypalSubscriptionId: activation.subscriptionId,
      reason: "freemium_webhook_provisioning_failed",
    })
    return { status: "retryable", reason: "provisioning_error" }
  }

  if (result.outcome === "provisioned" && result.routineAccepted) return { status: "provisioned" }

  // A plan that is admitted, pinned and derived but has no ACTIVE routine version does not
  // satisfy `resolvePersonalPlanJourneyAccess` — the buyer paid and still sees a gate. That
  // is a retry, not a success.
  const reason =
    result.outcome === "provisioned"
      ? "routine_not_accepted"
      : result.outcome === "temporarily_unavailable"
        ? `unavailable_${result.stage}`
        : result.outcome === "enrollment_conflict"
          ? (result.reasonCode ?? "enrollment_conflict")
          : result.outcome
  const retryable = result.outcome === "provisioned" || result.outcome === "temporarily_unavailable"

  console.error("[freemium] paypal webhook provisioning incomplete", {
    paypalSubscriptionId: activation.subscriptionId,
    outcome: result.outcome,
    reason,
    retryable,
  })
  capture(new Error(`freemium webhook provisioning incomplete: ${reason}`), {
    provider: "paypal",
    stage: "paypal_webhook_ingestion",
    source: "premium_sheet",
    paypalSubscriptionId: activation.subscriptionId,
    reason: retryable
      ? "freemium_webhook_provisioning_incomplete"
      : "freemium_webhook_provisioning_blocked",
  })
  return retryable ? { status: "retryable", reason } : { status: "blocked", reason }
}

/**
 * Run the freemium provisioning for a verified-active PayPal subscription, and THROW when
 * PayPal has to try again. Bounded by
 * `FREEMIUM_PAYPAL_WEBHOOK_PROVISIONING_BUDGET_MS`.
 */
export async function runFreemiumPayPalSubscriptionProvisioning(
  intent: FreemiumPayPalWebhookIntent | null | undefined,
  deps: PayPalWebhookFreemiumProvisioningDeps,
  activation: { userId: string; subscriptionId: string },
  options: { budgetMs?: number } = {},
): Promise<FreemiumWebhookProvisioningOutcome> {
  const budgetMs = options.budgetMs ?? FREEMIUM_PAYPAL_WEBHOOK_PROVISIONING_BUDGET_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    provisionFreemiumPayPalSubscription(intent, deps, activation).catch(
      (): FreemiumWebhookProvisioningOutcome => ({
        status: "retryable",
        reason: "provisioning_error",
      }),
    ),
    new Promise<FreemiumWebhookProvisioningOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: "retryable", reason: "provisioning_budget_exhausted" }),
        budgetMs,
      )
    }),
  ])
  if (timer) clearTimeout(timer)
  if (outcome.status === "retryable") {
    throw new FreemiumPayPalWebhookProvisioningRetryError(activation.subscriptionId, outcome.reason)
  }
  return outcome
}

async function defaultProvisionFreemiumPayPalPurchase(input: {
  userId: string
  providerReference: string
}): Promise<FreemiumProvisioningResult> {
  const [
    { createFreemiumProvisioningService },
    { createFreemiumProvisioningSupabaseDependencies },
    { createAdminClient },
  ] = await Promise.all([
    import("@/lib/freemium/plan-provisioning"),
    import("@/lib/freemium/plan-provisioning-supabase"),
    import("@/lib/supabase/admin"),
  ])
  return createFreemiumProvisioningService(
    createFreemiumProvisioningSupabaseDependencies(createAdminClient() as never),
  ).provisionAfterPurchase({
    userId: input.userId,
    provider: "paypal",
    providerReference: input.providerReference,
  })
}
