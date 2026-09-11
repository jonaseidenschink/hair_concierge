import type Stripe from "stripe"
import type {
  CheckoutAccountResult,
  CheckoutActivationDeps,
  OneTimeCheckoutActivationDeps,
} from "./checkout-activation"
import {
  ensureCheckoutAccount,
  ensureOneTimeCheckoutAccount,
  stripePricingMetadata,
  stripeEntitlementStatus,
  subPeriodEndIso,
} from "./checkout-activation"
import { intervalFromPrice } from "./intervals"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import { freemiumCheckoutUserId, isFreemiumCheckoutSession } from "@/lib/freemium/checkout-metadata"
import type { FreemiumProvisioningResult } from "@/lib/freemium/plan-provisioning"
import { captureCheckoutException } from "@/lib/observability/checkout"
import {
  findBillingSubscriptionByProviderId,
  upsertBillingSubscription,
} from "@/lib/billing/subscriptions"
import {
  findOneTimePurchaseByProviderTransactionId,
  updateOneTimePurchaseStatus,
} from "@/lib/billing/purchases"
import type { BillingOneTimePurchaseRow } from "@/lib/billing/types"
import { applyPlanChangeAtRenewal } from "@/lib/billing/plan-change"

export type HandlerDeps = CheckoutActivationDeps
type SubscriptionUpdateDeps = Pick<HandlerDeps, "supabase"> & {
  defer?: (work: () => void | Promise<void>) => void
}
type SubscriptionLifecycleResult = {
  matchedCurrentSubscription: boolean
  profileId?: string
}

function stripeObjectId(value: string | { id?: string } | null | undefined): string | null {
  if (typeof value === "string") return value
  return value?.id ?? null
}

type InvoiceWithSubscriptionDetails = {
  id?: string
  parent?: {
    subscription_details?: {
      subscription?: string | { id?: string } | null
    } | null
  } | null
}

function subscriptionIdFromInvoice(invoice: InvoiceWithSubscriptionDetails | null): string | null {
  return stripeObjectId(invoice?.parent?.subscription_details?.subscription)
}

async function updateProfileForCurrentSubscription(
  deps: SubscriptionUpdateDeps,
  input: {
    profileId: string
    subscriptionId: string
    patch: Record<string, unknown>
  },
) {
  const { data, error } = await deps.supabase
    .from("profiles")
    .update(input.patch)
    .eq("id", input.profileId)
    .eq("stripe_subscription_id", input.subscriptionId)
    .select("id")
    .maybeSingle()
  if (error) throw error
  return Boolean(data?.id)
}

async function subscriptionIdFromCharge(
  stripe: HandlerDeps["stripe"],
  charge: Stripe.Charge,
): Promise<string | null> {
  const paymentIntentId = stripeObjectId(charge.payment_intent)
  if (!paymentIntentId) return null

  const invoicePayments = await stripe.invoicePayments.list({
    payment: {
      type: "payment_intent",
      payment_intent: paymentIntentId,
    },
    limit: 1,
    expand: ["data.invoice.parent.subscription_details.subscription"],
  })
  const invoice = invoicePayments.data[0]?.invoice
  if (!invoice) return null
  if (typeof invoice !== "string") return subscriptionIdFromInvoice(invoice)

  const retrievedInvoice = (await stripe.invoices.retrieve(invoice, {
    expand: ["parent.subscription_details.subscription"],
  })) as InvoiceWithSubscriptionDetails
  return subscriptionIdFromInvoice(retrievedInvoice)
}

async function selectedSubscriptionPaymentMethodType(
  stripe: HandlerDeps["stripe"],
  session: Stripe.Checkout.Session,
): Promise<string | undefined> {
  const subscriptionId = stripeObjectId(session.subscription)
  if (subscriptionId) {
    const subscription = (await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["default_payment_method"],
    })) as unknown as {
      default_payment_method?: string | { id: string; type?: string } | null
    }
    const paymentMethod = subscription.default_payment_method
    if (typeof paymentMethod === "object" && paymentMethod !== null && paymentMethod.type) {
      return paymentMethod.type
    }
  }

  // Fallback only when Checkout offered a single method. `payment_method_types`
  // is an offered-method list, not proof of the method used.
  return session.payment_method_types?.length === 1 ? session.payment_method_types[0] : undefined
}

/**
 * What the webhook lane must do next with a freemium provisioning attempt.
 *
 * `retryable` is the load-bearing one (Codex fix wave, Y1). It is the caller's instruction
 * to FAIL the webhook delivery — release the event claim and answer Stripe with a 500 — so
 * the event is redelivered. Swallowing the failure here, which is what this function used
 * to do, left a verified-paid buyer permanently unprovisioned: the claim row was already
 * written, so no later delivery of the same event could ever be processed, and a buyer who
 * had closed the tab had no client lane left either.
 */
export type FreemiumWebhookProvisioningOutcome =
  /** Not a freemium checkout (or the flag is off) — nothing was attempted. */
  | { status: "skipped" }
  /** Admitted, pinned, derived and the Routine is active. Nothing left to do. */
  | { status: "provisioned" }
  /** Transient: the caller must make Stripe redeliver this event. */
  | { status: "retryable"; reason: string }
  /** A retry cannot help (no quiz artifact, foreign enrollment, identity mismatch). */
  | { status: "blocked"; reason: string }

/**
 * Freemium (Premium-sheet) post-purchase provisioning, run from the webhook lane
 * (freemium-scanner-first T14).
 *
 * The in-sheet completion callback already does this for a card payment that finishes while
 * the buyer is watching. This lane covers everything else: an asynchronous payment method
 * that settles minutes later, a buyer who closed the tab mid-payment, a failed completion
 * call. Both lanes run the SAME idempotent service, so whichever arrives first provisions
 * and the other one is a no-op.
 *
 * Inert unless the Session carries this program's marker, so no other checkout is affected.
 */
export async function provisionFreemiumCheckoutSession(
  session: Stripe.Checkout.Session,
  deps: Pick<
    StripeWebhookProvisioningDeps,
    "provisionFreemiumPurchase" | "freemiumEnabled" | "captureFreemiumProvisioningException"
  >,
  /**
   * The account the ACTIVATION resolved (by Stripe customer / email), which is independent
   * of the Session metadata. Fix round 1 (F7): the completion endpoint already refuses when
   * the two identities disagree; this lane must too, because the plan's
   * `enrollment_purchase_source_id` pin is permanent and never self-heals — pinning the
   * wrong account's plan cannot be undone afterwards.
   */
  activation: { userId: string },
): Promise<FreemiumWebhookProvisioningOutcome> {
  const userId = freemiumCheckoutProvisioningUserId(session, deps)
  if (!userId) return { status: "skipped" }
  const capture = deps.captureFreemiumProvisioningException ?? captureCheckoutException
  if (userId !== activation.userId) {
    console.error("[freemium] webhook provisioning identity mismatch", {
      checkoutSessionId: session.id,
    })
    capture(new Error("freemium webhook provisioning identity mismatch"), {
      provider: "stripe",
      stage: "stripe_webhook_activation",
      source: "premium_sheet",
      stripeSessionId: session.id,
      reason: "freemium_webhook_identity_mismatch",
    })
    // Redelivering cannot change which account the activation resolves to.
    return { status: "blocked", reason: "identity_mismatch" }
  }

  const provision = deps.provisionFreemiumPurchase ?? defaultProvisionFreemiumPurchase
  let result: FreemiumProvisioningResult
  try {
    result = await provision({ userId, providerReference: session.id })
  } catch (error) {
    // The provisioning service marks nothing "done" until it is done — admission is a
    // reused row, the initial need reuses its `(plan, input_hash)` row and acceptance is
    // CAS-guarded — so an interrupted run is safe to run again from the top.
    console.error("[freemium] webhook provisioning failed", {
      checkoutSessionId: session.id,
      error,
    })
    capture(error, {
      provider: "stripe",
      stage: "stripe_webhook_activation",
      source: "premium_sheet",
      stripeSessionId: session.id,
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

  console.error("[freemium] webhook provisioning incomplete", {
    checkoutSessionId: session.id,
    outcome: result.outcome,
    reason,
    retryable,
  })
  capture(new Error(`freemium webhook provisioning incomplete: ${reason}`), {
    provider: "stripe",
    stage: "stripe_webhook_activation",
    source: "premium_sheet",
    stripeSessionId: session.id,
    reason: retryable
      ? "freemium_webhook_provisioning_incomplete"
      : "freemium_webhook_provisioning_blocked",
  })
  return retryable ? { status: "retryable", reason } : { status: "blocked", reason }
}

/**
 * Thrown by `runFreemiumCheckoutProvisioning` when the delivery must be failed so Stripe
 * redelivers it. The webhook route's own catch is what turns this into the durable retry:
 * it releases the event claim and answers 500.
 */
export class FreemiumWebhookProvisioningRetryError extends Error {
  readonly checkoutSessionId: string | undefined
  readonly reason: string

  constructor(checkoutSessionId: string | undefined, reason: string) {
    super(`freemium provisioning must be retried (${reason})`)
    this.name = "FreemiumWebhookProvisioningRetryError"
    this.checkoutSessionId = checkoutSessionId
    this.reason = reason
  }
}

/**
 * How long the webhook will wait for provisioning before failing the delivery instead.
 *
 * Comfortably inside Stripe's own ~30s delivery timeout, and that gap is the point: if the
 * chain outran Stripe's timeout, the platform would kill the invocation with the event
 * still claimed — the redelivery would then be dropped as a duplicate and the buyer would
 * be stuck for good. Giving up first keeps the failure inside our own hands, where the
 * claim gets released. Every provisioning step is reuse-based, so the abandoned run costs
 * nothing: the retry resumes from wherever it got to.
 */
export const FREEMIUM_WEBHOOK_PROVISIONING_BUDGET_MS = 20_000

/**
 * Run the freemium provisioning for a verified-paid webhook event, and THROW when Stripe
 * has to try again (Codex fix wave, Y1).
 *
 * This is awaited inside the webhook's response, not deferred. Deferred work runs after the
 * response has been sent, which makes its failure unreportable to Stripe — and with the
 * event already claimed, unreachable by any redelivery. A buyer who closed the tab had no
 * other lane left. Bounded by `FREEMIUM_WEBHOOK_PROVISIONING_BUDGET_MS`.
 */
export async function runFreemiumCheckoutProvisioning(
  session: Stripe.Checkout.Session,
  deps: Pick<
    StripeWebhookProvisioningDeps,
    "provisionFreemiumPurchase" | "freemiumEnabled" | "captureFreemiumProvisioningException"
  >,
  activation: { userId: string },
  options: { budgetMs?: number } = {},
): Promise<FreemiumWebhookProvisioningOutcome> {
  const budgetMs = options.budgetMs ?? FREEMIUM_WEBHOOK_PROVISIONING_BUDGET_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    provisionFreemiumCheckoutSession(session, deps, activation).catch(
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
    throw new FreemiumWebhookProvisioningRetryError(session.id, outcome.reason)
  }
  return outcome
}

/**
 * The synchronous half of the guard above, so the webhook can decide whether there is any
 * freemium work at all BEFORE doing anything. Every non-freemium checkout must leave the
 * deferred-work queue exactly as it was pre-T14.
 */
export function freemiumCheckoutProvisioningUserId(
  session: Stripe.Checkout.Session,
  deps: Pick<StripeWebhookProvisioningDeps, "freemiumEnabled">,
): string | null {
  const enabled = deps.freemiumEnabled ?? isFreemiumScannerFirstEnabled
  if (!enabled()) return null
  if (!isFreemiumCheckoutSession(session)) return null
  return freemiumCheckoutUserId(session)
}

export type StripeWebhookProvisioningDeps = {
  freemiumEnabled?: () => boolean
  provisionFreemiumPurchase?: (input: {
    userId: string
    providerReference: string
  }) => Promise<FreemiumProvisioningResult>
  /** Test seam for the failure report above; production uses `captureCheckoutException`. */
  captureFreemiumProvisioningException?: typeof captureCheckoutException
}

async function defaultProvisionFreemiumPurchase(input: {
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
    provider: "stripe",
    providerReference: input.providerReference,
  })
}

export async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
  deps: HandlerDeps,
): Promise<CheckoutAccountResult> {
  return ensureCheckoutAccount(session, deps)
}

export async function handleOneTimeCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
  deps: OneTimeCheckoutActivationDeps,
) {
  return ensureOneTimeCheckoutAccount(session, deps)
}

export async function handleOneTimeChargeRefunded(
  charge: Stripe.Charge,
  deps: Pick<HandlerDeps, "supabase">,
): Promise<{
  purchase: BillingOneTimePurchaseRow
  refundedDeltaMinor: number
} | null> {
  const paymentIntentId = stripeObjectId(charge.payment_intent)
  if (!paymentIntentId) return null
  const purchase = await findOneTimePurchaseByProviderTransactionId(
    deps.supabase,
    "stripe",
    paymentIntentId,
  )
  if (!purchase) {
    if (charge.metadata?.product_kind === "personal_plan_once") {
      throw new Error(`One-time Stripe purchase ${paymentIntentId} is not ready for refund`)
    }
    return null
  }
  const previousRefundedAmount = purchase.refunded_amount_minor
  const refundedAmount = Math.max(previousRefundedAmount, charge.amount_refunded ?? 0)
  const updatedPurchase = await updateOneTimePurchaseStatus(deps.supabase, purchase, {
    status: refundedAmount >= purchase.amount_minor ? "refunded" : "paid",
    refunded_amount_minor: refundedAmount,
    refunded_at: new Date().toISOString(),
    metadata: { ...purchase.metadata, stripe_charge_id: charge.id },
  })
  return {
    purchase: updatedPurchase,
    refundedDeltaMinor: Math.max(0, refundedAmount - previousRefundedAmount),
  }
}

export async function handleOneTimeChargeDisputeCreated(
  dispute: Stripe.Dispute,
  deps: Pick<HandlerDeps, "supabase" | "stripe">,
): Promise<boolean> {
  const chargeId = stripeObjectId(dispute.charge)
  if (!chargeId) return false
  const charge = await deps.stripe.charges.retrieve(chargeId)
  const paymentIntentId = stripeObjectId(charge.payment_intent)
  if (!paymentIntentId) return false
  const purchase = await findOneTimePurchaseByProviderTransactionId(
    deps.supabase,
    "stripe",
    paymentIntentId,
  )
  if (!purchase) {
    if (charge.metadata?.product_kind === "personal_plan_once") {
      throw new Error(`One-time Stripe purchase ${paymentIntentId} is not ready for dispute`)
    }
    return false
  }
  await updateOneTimePurchaseStatus(deps.supabase, purchase, {
    status: "disputed",
    metadata: { ...purchase.metadata, stripe_charge_id: chargeId, stripe_dispute_id: dispute.id },
  })
  return true
}

export async function handleCheckoutSessionExpired(
  session: Stripe.Checkout.Session,
  deps: Pick<HandlerDeps, "supabase">,
): Promise<void> {
  void deps
  if (!session.id) return
  console.info("[stripe] checkout.session.expired acknowledged", {
    checkoutSessionId: session.id,
  })
}

export async function handleCheckoutSessionAsyncPaymentSucceeded(
  session: Stripe.Checkout.Session,
  deps: HandlerDeps,
): Promise<CheckoutAccountResult | null> {
  if (!session.id) return null
  const paymentMethodType = await selectedSubscriptionPaymentMethodType(deps.stripe, session)
  if (paymentMethodType === "sepa_debit") {
    console.info("[stripe] checkout.session.async_payment_succeeded skipped for SEPA sunset", {
      checkoutSessionId: session.id,
    })
    const subscriptionId = stripeObjectId(session.subscription)
    if (subscriptionId) {
      await cancelStripeSubscriptionBestEffort(
        deps.stripe,
        subscriptionId,
        "sepa_async_payment_succeeded_sunset",
      )
    }
    return null
  }

  return ensureCheckoutAccount(session, deps)
}

export async function handleCheckoutSessionAsyncPaymentFailed(
  session: Stripe.Checkout.Session,
  deps: Pick<HandlerDeps, "supabase" | "stripe"> & { freeTierId: string },
): Promise<void> {
  if (!session.id) return

  const customerId = stripeObjectId(session.customer)
  const subscriptionId = stripeObjectId(session.subscription)
  if (!customerId || !subscriptionId) return

  await revokeStripeAccessForCustomer(deps.supabase, {
    customerId,
    subscriptionId,
    freeTierId: deps.freeTierId,
    providerStatus: "payment_failed",
    reason: "async_payment_failed",
  })
  await cancelStripeSubscriptionBestEffort(deps.stripe, subscriptionId, "async_payment_failed")
}

export async function handleChargeDisputeCreated(
  dispute: Stripe.Dispute,
  deps: Pick<HandlerDeps, "supabase" | "stripe"> & { freeTierId: string },
): Promise<void> {
  const chargeId = stripeObjectId(dispute.charge)
  if (!chargeId) {
    console.warn("[stripe] charge.dispute.created missing charge", {
      disputeId: dispute.id,
    })
    return
  }

  const charge = await deps.stripe.charges.retrieve(chargeId)
  const customerId = stripeObjectId(charge.customer)
  if (!customerId) {
    console.warn("[stripe] disputed charge missing customer", {
      chargeId,
      disputeId: dispute.id,
    })
    return
  }

  const subscriptionId = await subscriptionIdFromCharge(deps.stripe, charge)
  if (!subscriptionId) {
    console.warn("[stripe] disputed charge missing subscription", {
      chargeId,
      customerId,
      disputeId: dispute.id,
    })
    return
  }

  const profile = await findProfileByStripeCustomerId(deps.supabase, customerId)
  if (!profile) return
  if (!profile.stripe_subscription_id) {
    console.warn("[stripe] disputed charge customer has no current subscription", {
      chargeId,
      customerId,
      disputeId: dispute.id,
      profileId: profile.id,
      disputedSubscriptionId: subscriptionId,
    })
  }

  await revokeStripeAccessForCustomer(deps.supabase, {
    customerId,
    subscriptionId,
    freeTierId: deps.freeTierId,
    providerStatus: "disputed",
    reason: "charge_dispute_created",
  })
  await cancelStripeSubscriptionBestEffort(deps.stripe, subscriptionId, "charge_dispute_created")
}

/** Narrow shape we read from a subscription event. */
interface UpdatedSub {
  id: string
  customer: string | { id: string } | null
  status: string
  current_period_end?: number
  cancel_at_period_end?: boolean
  cancel_at?: number | null
  items: {
    data: Array<{
      current_period_end?: number
      price: {
        id?: string
        recurring?: { interval: string; interval_count: number }
        interval?: string
        interval_count?: number
      }
    }>
  }
}

export async function handleSubscriptionUpdated(
  sub: Stripe.Subscription,
  deps: SubscriptionUpdateDeps,
): Promise<SubscriptionLifecycleResult> {
  const s = sub as unknown as UpdatedSub
  if (typeof s.customer !== "string") throw new Error("sub.customer not a string")
  const profile = await findProfileByStripeCustomerId(deps.supabase, s.customer)
  if (!profile) return handleSubscriptionUpdatedWithoutMatchedProfile(s, s.customer, deps)
  const price = s.items.data[0].price
  const interval = intervalFromPrice({
    interval: price.recurring?.interval ?? price.interval ?? "",
    interval_count: price.recurring?.interval_count ?? price.interval_count ?? 1,
  })
  const matchedCurrentSubscription =
    profile.stripe_subscription_id === s.id &&
    (await updateProfileForCurrentSubscription(deps, {
      profileId: profile.id,
      subscriptionId: s.id,
      patch: {
        subscription_status: s.status,
        subscription_interval: interval,
        current_period_end: subPeriodEndIso(s),
      },
    }))
  const entitlementStatus = matchedCurrentSubscription
    ? stripeEntitlementStatus(s.status)
    : "canceled"

  const periodEnd = subPeriodEndIso(s)
  const cancelScheduledAt =
    typeof s.cancel_at === "number"
      ? new Date(s.cancel_at * 1000).toISOString()
      : s.cancel_at_period_end
        ? periodEnd
        : null
  const billingRow = await upsertBillingSubscription(deps.supabase, {
    user_id: profile.id,
    provider: "stripe",
    provider_customer_id: s.customer,
    provider_subscription_id: s.id,
    provider_status: s.status,
    entitlement_status: entitlementStatus,
    interval,
    current_period_end: periodEnd,
    cancel_at_period_end: Boolean(s.cancel_at_period_end || s.cancel_at != null),
    cancel_scheduled_at: cancelScheduledAt,
    metadata: {
      ...stripePricingMetadata(price.id),
    },
  })
  await applyPlanChangeAtRenewal(deps.supabase, {
    subscription: billingRow,
    observedInterval: interval,
    occurredAt: new Date().toISOString(),
    deps: { defer: deps.defer },
  })
  return { matchedCurrentSubscription, profileId: profile.id }
}

/**
 * Falls back to a provider-id lookup when no profile carries this Stripe
 * customer id — e.g. profiles.stripe_customer_id was cleared or never
 * synced. Previously this returned silently (200 OK, no-op), so a real
 * subscription.updated event could leave billing_subscriptions stale
 * forever. Now it still updates the matching billing_subscriptions row from
 * provider truth, and only logs at error level (no silent 200) when even
 * that lookup misses — there is genuinely nothing local to reconcile.
 */
async function handleSubscriptionUpdatedWithoutMatchedProfile(
  s: UpdatedSub,
  customerId: string,
  deps: SubscriptionUpdateDeps,
): Promise<SubscriptionLifecycleResult> {
  const existingBilling = await findBillingSubscriptionByProviderId(deps.supabase, "stripe", s.id)
  if (!existingBilling) {
    console.error(
      "[stripe] subscription.updated: no profile or billing_subscriptions row matched this customer/subscription",
      { subscriptionId: s.id, customer: customerId },
    )
    return { matchedCurrentSubscription: false }
  }

  const price = s.items.data[0].price
  const interval = intervalFromPrice({
    interval: price.recurring?.interval ?? price.interval ?? "",
    interval_count: price.recurring?.interval_count ?? price.interval_count ?? 1,
  })
  const periodEnd = subPeriodEndIso(s)
  const cancelScheduledAt =
    typeof s.cancel_at === "number"
      ? new Date(s.cancel_at * 1000).toISOString()
      : s.cancel_at_period_end
        ? periodEnd
        : null

  await upsertBillingSubscription(deps.supabase, {
    user_id: existingBilling.user_id,
    provider: "stripe",
    provider_customer_id: customerId,
    provider_subscription_id: s.id,
    provider_status: s.status,
    entitlement_status: stripeEntitlementStatus(s.status),
    interval,
    current_period_end: periodEnd,
    cancel_at_period_end: Boolean(s.cancel_at_period_end || s.cancel_at != null),
    cancel_scheduled_at: cancelScheduledAt,
    metadata: {
      ...stripePricingMetadata(price.id),
    },
  })

  return { matchedCurrentSubscription: false }
}

export interface DeleteDeps {
  supabase: HandlerDeps["supabase"]
  freeTierId: string
}

export async function handleSubscriptionDeleted(
  sub: Stripe.Subscription,
  deps: DeleteDeps,
): Promise<SubscriptionLifecycleResult> {
  const customer = typeof sub.customer === "string" ? sub.customer : null
  if (!customer) throw new Error("sub.customer not a string")
  const profile = await findProfileByStripeCustomerId(deps.supabase, customer)
  if (!profile) return { matchedCurrentSubscription: false }
  const matchedCurrentSubscription =
    profile.stripe_subscription_id === sub.id &&
    (await updateProfileForCurrentSubscription(deps, {
      profileId: profile.id,
      subscriptionId: sub.id,
      patch: {
        subscription_status: "canceled",
        subscription_tier_id: deps.freeTierId,
        stripe_subscription_id: null,
        subscription_interval: null,
        current_period_end: null,
      },
    }))

  await upsertBillingSubscription(deps.supabase, {
    user_id: profile.id,
    provider: "stripe",
    provider_customer_id: customer,
    provider_subscription_id: sub.id,
    provider_status: sub.status ?? "canceled",
    entitlement_status: "canceled",
    cancelled_at: new Date().toISOString(),
  })
  return { matchedCurrentSubscription, profileId: profile.id }
}

export async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  console.warn("[stripe] invoice.payment_failed", {
    invoiceId: invoice.id,
    customer: invoice.customer,
    attempt: invoice.attempt_count,
  })
}

export async function revokeStripeAccessForCustomer(
  supabase: HandlerDeps["supabase"],
  input: {
    customerId: string
    subscriptionId: string
    freeTierId: string
    providerStatus: string
    reason: string
  },
): Promise<void> {
  const profile = await findProfileByStripeCustomerId(supabase, input.customerId)
  if (!profile) return

  const existingBilling = await findBillingSubscriptionByProviderId(
    supabase,
    "stripe",
    input.subscriptionId,
  )

  await upsertBillingSubscription(supabase, {
    user_id: profile.id,
    provider: "stripe",
    provider_customer_id: input.customerId,
    provider_subscription_id: input.subscriptionId,
    provider_status: input.providerStatus,
    entitlement_status: "canceled",
    cancelled_at: new Date().toISOString(),
    metadata: {
      ...((existingBilling?.metadata as Record<string, unknown> | null) ?? {}),
      reason: input.reason,
    },
  })

  if (profile.stripe_subscription_id !== input.subscriptionId) return

  await supabase
    .from("profiles")
    .update({
      subscription_status: "canceled",
      subscription_tier_id: input.freeTierId,
      stripe_subscription_id: null,
      subscription_interval: null,
      current_period_end: null,
    })
    .eq("id", profile.id)
    .eq("stripe_subscription_id", input.subscriptionId)
}

export async function cancelStripeSubscriptionBestEffort(
  stripe: HandlerDeps["stripe"],
  subscriptionId: string,
  reason: string,
): Promise<void> {
  try {
    await stripe.subscriptions.cancel(subscriptionId)
  } catch (error) {
    console.warn("[stripe] failed to cancel subscription", {
      subscriptionId,
      reason,
      error,
    })
  }
}

export type StripeCustomerProfile = {
  id: string
  email: string | null
  stripe_customer_id?: string | null
  stripe_subscription_id: string | null
  subscription_interval: string | null
  subscription_status: string | null
}

export async function findProfileByStripeCustomerId(
  supabase: HandlerDeps["supabase"],
  customerId: string,
): Promise<StripeCustomerProfile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select(
      "id,email,stripe_customer_id,stripe_subscription_id,subscription_interval,subscription_status",
    )
    .eq("stripe_customer_id", customerId)
    .maybeSingle()
  if (error) throw error
  return data as StripeCustomerProfile | null
}
