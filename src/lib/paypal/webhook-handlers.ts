import type { SupabaseClient } from "@supabase/supabase-js"
import {
  billingAnalyticsEventKey,
  billingSubscriptionPayload,
} from "@/lib/billing/analytics-events"
import {
  parseSubscriptionPricingCatalog,
  STANDARD_PRICING_CATALOG,
} from "@/lib/billing/pricing-catalog"
import { getStripePricingPlan } from "@/lib/stripe/pricing-plans"
import {
  BILLING_ANALYTICS_EXTERNAL_DESTINATIONS,
  findBillingAnalyticsEventByKey,
  recordBillingAnalyticsEvent,
} from "@/lib/billing/analytics-outbox"
import { applyPlanChangeAtRenewal } from "@/lib/billing/plan-change"
import { mirrorBillingSubscriptionToProfile } from "@/lib/billing/entitlements"
import {
  findBillingSubscriptionByProviderId,
  upsertBillingSubscription,
} from "@/lib/billing/subscriptions"
import { claimWebhookEvent, releaseWebhookEventClaim } from "@/lib/billing/webhook-events"
import type {
  BillingAnalyticsEventName,
  BillingAnalyticsDestination,
  BillingInterval,
  BillingSubscriptionInput,
  BillingSubscriptionRow,
} from "@/lib/billing/types"
import {
  bindPayPalCheckoutIntentToSubscription,
  findPayPalCheckoutIntentByProviderSubscriptionId,
  findPayPalCheckoutIntentByToken,
  isPayPalCheckoutIntentExpired,
  isPayPalCheckoutIntentEligibleForInitialPayment,
  markPayPalCheckoutIntentActivated,
  markPayPalCheckoutIntentDuplicate,
  markPayPalCheckoutIntentExpired,
  PayPalCheckoutIntentBindingError,
  type PayPalCheckoutIntentRow,
} from "@/lib/paypal/checkout-intents"
import {
  ensurePayPalCheckoutAccount,
  type PayPalCheckoutAccountResult,
} from "@/lib/paypal/checkout-activation"
import {
  freemiumPayPalProvisioningUserId,
  runFreemiumPayPalSubscriptionProvisioning,
  type PayPalWebhookFreemiumProvisioningDeps,
} from "@/lib/paypal/freemium-webhook-provisioning"
import {
  cancelAndMarkPayPalDuplicate,
  findPayPalCheckoutDuplicateReason,
} from "@/lib/paypal/duplicate-guard"
import type { PayPalSubscription } from "@/lib/paypal/subscription-shapes"
import { toBillingSubscriptionInputFromPayPal } from "@/lib/paypal/subscription-shapes"
import { getPayPalIntervalForPlanId } from "@/lib/paypal/plans"
import type { PaymentFailureDetails, PaymentFailureReporter } from "@/lib/observability/payment"
import { captureServerPaymentFailure } from "@/lib/observability/payment-server"
import { resolvePaymentRuntime } from "@/lib/billing/payment-runtime-config"
import { isBillingFunnelDeliveryEnabled, isFunnelAttributionEnabled } from "@/lib/funnel/flags"
import {
  findOneTimePurchaseByProviderTransactionId,
  updateOneTimePurchaseStatus,
} from "@/lib/billing/purchases"
import {
  findPayPalOrderIntentByProviderReference,
  findPayPalOrderIntentByToken as findPayPalOrderIntentByTokenV2,
  PAYPAL_PERSONAL_PLAN_ONCE_AMOUNT,
  PAYPAL_PERSONAL_PLAN_ONCE_CURRENCY,
  type PayPalOrderIntentRow,
} from "@/lib/paypal/order-intents"
import {
  activateVerifiedPayPalOrderIntent,
  retrieveProviderPayPalOrder,
  type VerifiedPayPalCapture,
  tryMarkPayPalOrderIntentCaptured,
  validateCapturedPayPalOrder,
  verifiedPayPalCaptureFromWebhook,
} from "@/lib/paypal/order-activation"
import { PERSONAL_PLAN_ONCE_PRODUCT } from "@/lib/billing/offer-products"

export type PayPalWebhookEvent = {
  id?: string
  event_type?: string
  create_time?: string
  resource?: {
    id?: string
    custom_id?: string
    create_time?: string
    billing_agreement_id?: string
    subscription_id?: string
    payee?: { merchant_id?: string }
    amount?: {
      total?: string
      value?: string
      currency?: string
      currency_code?: string
    }
    status?: string
    supplementary_data?: {
      related_ids?: {
        capture_id?: string
        order_id?: string
      }
    }
    disputed_transactions?: Array<{
      seller_transaction_id?: string
      transaction_info?: {
        seller_transaction_id?: string
      }
    }>
    dispute_outcome?: {
      outcome_code?: string
    }
  }
}

export interface PayPalWebhookDeps extends PayPalWebhookFreemiumProvisioningDeps {
  supabase: SupabaseClient
  premiumTierId: string
  freeTierId: string
  retrievePayPalSubscription?: (subscriptionId: string) => Promise<PayPalSubscription>
  cancelPayPalSubscription?: (subscriptionId: string, reason: string) => Promise<void>
  defer?: (work: () => void | Promise<void>) => void
  linkQuizToProfile?: (userId: string, email: string | undefined, leadId?: string) => Promise<void>
  recordBillingAnalytics?: boolean
  sendOneTimeConfirmation?: Parameters<
    typeof activateVerifiedPayPalOrderIntent
  >[2]["sendConfirmation"]
  finalizeOneTimeLockedPlan?: Parameters<
    typeof activateVerifiedPayPalOrderIntent
  >[2]["finalizeLockedPlan"]
  capturePaymentFailure?: PaymentFailureReporter
}

export type PayPalWebhookResult =
  | { handled: true; skipped?: false }
  | { handled: true; skipped: true }
  | { handled: false; skipped?: false }

type PayPalActivationOutcome =
  | { kind: "none"; reason: "duplicate" | "expired" | "quarantined" }
  | { kind: "pending" }
  | {
      kind: "active"
      billingRow: BillingSubscriptionRow
      checkoutIntent: PayPalCheckoutIntentRow | null
      funnelMetadata: Record<string, unknown> | null
    }

type PayPalPaymentClassification = "initial" | "renewal" | "historical_noop"

const MUTATING_EVENTS = new Set([
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "PAYMENT.SALE.COMPLETED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.EXPIRED",
])

const KNOWN_LOG_ONLY_EVENTS = new Set([
  "BILLING.SUBSCRIPTION.CREATED",
  "BILLING.SUBSCRIPTION.UPDATED",
  "PAYMENT.SALE.REFUNDED",
  "PAYMENT.SALE.REVERSED",
])
const ORDER_CAPTURE_EVENTS = new Set([
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
])
const DISPUTE_EVENTS = new Set([
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
])
const MERCHANT_FAVOR_DISPUTE_OUTCOMES = new Set([
  "RESOLVED_SELLER_FAVOUR",
  "RESOLVED_WITH_PAYOUT",
  "CANCELED_BY_BUYER",
  "DENIED",
])

export async function handlePayPalWebhookEvent(
  event: PayPalWebhookEvent,
  deps: PayPalWebhookDeps,
): Promise<PayPalWebhookResult> {
  const eventId = event.id
  const eventType = event.event_type
  if (!eventId || !eventType) throw new Error("PayPal webhook event is missing id or event_type")

  const subscriptionId = MUTATING_EVENTS.has(eventType)
    ? getEventSubscriptionId(event, eventType)
    : null
  const claimed = await claimWebhookEvent(deps.supabase, "paypal", eventId, eventType)
  if (!claimed) return { handled: true, skipped: true }

  try {
    if (ORDER_CAPTURE_EVENTS.has(eventType)) {
      await reconcilePayPalOrderCaptureEvent(event, deps)
      return { handled: true }
    }
    if (DISPUTE_EVENTS.has(eventType)) {
      const handled = await reconcilePayPalOneTimeDisputeEvent(event, deps)
      return handled ? { handled: true } : { handled: false }
    }
    if (
      deps.recordBillingAnalytics &&
      (eventType === "PAYMENT.SALE.REFUNDED" || eventType === "PAYMENT.SALE.REVERSED")
    ) {
      await recordLinkedPayPalRefund(event, deps)
      return { handled: true }
    }

    if (KNOWN_LOG_ONLY_EVENTS.has(eventType)) {
      console.info("[paypal:webhook] known log-only event", { eventId, eventType })
      return { handled: false }
    }

    if (!MUTATING_EVENTS.has(eventType)) {
      console.warn("[paypal:webhook] unhandled event type", { eventId, eventType })
      return { handled: false }
    }

    if (!subscriptionId) throw new Error("PayPal webhook event is missing subscription id")
    const retrieve = deps.retrievePayPalSubscription ?? retrievePayPalSubscriptionForWebhook
    const subscription = await retrieve(subscriptionId)

    switch (eventType) {
      case "BILLING.SUBSCRIPTION.ACTIVATED": {
        const outcome = await activateOrRefreshSubscription(subscription, deps)
        // The Premium sheet's own post-purchase provisioning, beside — never instead of —
        // the activation above, and LAST, because it is the only step here whose failure has
        // to reach PayPal: it throws when the delivery must be retried, and the catch below
        // releases the event claim so the redelivery is processable. This is the lane for the
        // buyer who approved and closed the tab; without it that buyer is paid, entitled and
        // planless forever. Everything above has already run and is dedupe-guarded, so a
        // retried delivery repeats it harmlessly.
        await provisionPremiumSheetPurchase(outcome, deps)
        return { handled: true }
      }
      case "PAYMENT.SALE.COMPLETED": {
        let outcome = await activateOrRefreshSubscription(subscription, deps)
        if (outcome.kind === "pending") {
          throw new Error(`PayPal subscription ${subscriptionId} is not active yet`)
        }
        if (outcome.kind === "none") return { handled: true }
        const sale = assertValidPayPalSaleEvent(event)
        const providerInterval = getPayPalIntervalForPlanId(subscription.plan_id)
        if (providerInterval) {
          const applied = await applyPlanChangeAtRenewal(deps.supabase, {
            subscription: outcome.billingRow,
            observedInterval: providerInterval,
            occurredAt: sale.occurredAt,
            deps: { defer: deps.defer },
          })
          if (applied) {
            await mirrorBillingSubscriptionToProfile(
              deps.supabase,
              applied.subscription,
              deps.premiumTierId,
              { freeTierId: deps.freeTierId },
            )
            outcome = { ...outcome, billingRow: applied.subscription }
          }
        }
        if (deps.recordBillingAnalytics) {
          await recordPayPalSuccessfulPayment(event, deps, outcome, sale)
        }
        // The second chance for the same purchase: the sale that pays for the checkout the
        // sheet started, in case `BILLING.SUBSCRIPTION.ACTIVATED` never arrived or gave up
        // retrying. Gated on the SAME "is this the initial payment" predicate the analytics
        // classification uses, so a renewal months later — whose intent is long expired —
        // never re-enters provisioning, while a redelivery of this sale still does.
        if (
          outcome.checkoutIntent &&
          isPayPalCheckoutIntentEligibleForInitialPayment(outcome.checkoutIntent, {
            providerSubscriptionId: outcome.billingRow.provider_subscription_id,
            eventCreatedAt: sale.occurredAt,
          })
        ) {
          await provisionPremiumSheetPurchase(outcome, deps)
        }
        return { handled: true }
      }
      case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
      case "BILLING.SUBSCRIPTION.SUSPENDED": {
        const checkoutIntent = await findPayPalCheckoutIntentByProviderSubscriptionId(
          deps.supabase,
          subscriptionId,
        ).catch(() => null)
        reportPayPalWebhookPaymentFailure(deps, {
          signal: "provider_payment_failed",
          provider: "paypal",
          boundary: "webhook",
          errorFamily: "declined",
          commerceKind: "subscription",
          origin: "webhook",
          method: "paypal",
          truth: "failed",
          live: paymentRuntime().paypalLive,
          isInternalTest: checkoutIntent?.metadata?.is_internal_test === true,
          providerReferencePresent: Boolean(eventId),
        })
        const billingRow = await updateExistingSubscription(subscription, deps, {
          provider_status: subscription.status ?? "SUSPENDED",
          entitlement_status: "past_due",
        })
        if (deps.recordBillingAnalytics && billingRow) {
          await recordPayPalLifecycleEvent(event, deps, billingRow, "payment_failed")
        }
        return { handled: true }
      }
      case "BILLING.SUBSCRIPTION.CANCELLED": {
        const billingRow = await updateExistingSubscription(subscription, deps, {
          provider_status: "CANCELLED",
          entitlement_status: "canceled",
          cancel_at_period_end: true,
          cancelled_at: new Date().toISOString(),
        })
        if (deps.recordBillingAnalytics && billingRow) {
          await recordPayPalLifecycleEvent(event, deps, billingRow, "subscription_cancelled")
        }
        return { handled: true }
      }
      case "BILLING.SUBSCRIPTION.EXPIRED": {
        const billingRow = await updateExistingSubscription(subscription, deps, {
          provider_status: "EXPIRED",
          entitlement_status: "canceled",
          current_period_end: subscription.billing_info?.next_billing_time ?? null,
          cancel_at_period_end: false,
          cancelled_at: new Date().toISOString(),
        })
        if (deps.recordBillingAnalytics && billingRow) {
          await recordPayPalLifecycleEvent(event, deps, billingRow, "subscription_expired")
        }
        return { handled: true }
      }
      default:
        return { handled: false }
    }
  } catch (error) {
    await releaseWebhookEventClaim(deps.supabase, "paypal", eventId)
    throw error
  }
}

async function reconcilePayPalOneTimeDisputeEvent(
  event: PayPalWebhookEvent,
  deps: PayPalWebhookDeps,
): Promise<boolean> {
  const captureIds = payPalDisputeCaptureIdsForWebhook(event)
  if (captureIds.length === 0) {
    console.warn("[paypal:webhook] dispute has no seller transaction id", {
      eventId: event.id,
      eventType: event.event_type,
    })
    return false
  }

  let handled = false
  for (const captureId of captureIds) {
    const purchase = await findOneTimePurchaseByProviderTransactionId(
      deps.supabase,
      "paypal",
      captureId,
    )
    if (!purchase) continue
    handled = true
    const outcome = event.resource?.dispute_outcome?.outcome_code?.trim()
    const restored =
      event.event_type === "CUSTOMER.DISPUTE.RESOLVED" &&
      Boolean(outcome && MERCHANT_FAVOR_DISPUTE_OUTCOMES.has(outcome))
    const terminalStatus =
      purchase.status === "refunded" || purchase.status === "reversed" ? purchase.status : null
    await updateOneTimePurchaseStatus(deps.supabase, purchase, {
      status: terminalStatus ?? (restored ? "paid" : "disputed"),
      metadata: {
        ...purchase.metadata,
        paypal_dispute_event_type: event.event_type,
        paypal_dispute_id: event.resource?.id ?? null,
        paypal_dispute_outcome: outcome ?? null,
      },
    })
  }
  return handled
}

async function reconcilePayPalOrderCaptureEvent(
  event: PayPalWebhookEvent,
  deps: PayPalWebhookDeps,
) {
  const isCompleted = event.event_type === "PAYMENT.CAPTURE.COMPLETED"
  const captureId = payPalCaptureIdForWebhook(event)
  if (!captureId) throw new Error("PayPal capture webhook is missing capture id")
  if (isCompleted) assertValidPayPalOneTimeCaptureEvent(event)
  let purchase = await findOneTimePurchaseByProviderTransactionId(
    deps.supabase,
    "paypal",
    captureId,
  )
  if (!purchase && isCompleted) {
    const token = event.resource?.custom_id?.trim()
    const orderId = event.resource?.supplementary_data?.related_ids?.order_id?.trim()
    const intent = token
      ? await findPayPalOrderIntentByTokenV2(deps.supabase, token)
      : await findPayPalOrderIntentByProviderReference(deps.supabase, { orderId })
    if (intent) {
      validatePayPalCaptureCompletedWebhook(event, intent, captureId)
      const verifiedCapture = await verifiedPayPalWebhookCaptureWithMerchantCheck(
        event,
        intent,
        captureId,
      )
      const capturedIntent = intent.provider_capture_id
        ? intent
        : await tryMarkPayPalOrderIntentCaptured(
            deps.supabase,
            intent.token,
            verifiedCapture.orderId,
            captureId,
          )
      await activateVerifiedPayPalOrderIntent(capturedIntent, verifiedCapture, {
        supabase: deps.supabase,
        linkQuizToProfile: deps.linkQuizToProfile,
        sendConfirmation: deps.sendOneTimeConfirmation,
        finalizeLockedPlan: deps.finalizeOneTimeLockedPlan,
        defer: deps.defer,
        capturePaymentFailure: deps.capturePaymentFailure,
      })
      purchase = await findOneTimePurchaseByProviderTransactionId(
        deps.supabase,
        "paypal",
        captureId,
      )
    }
  }
  if (!purchase) {
    if (!isCompleted) {
      throw new Error(`PayPal capture ${captureId} has no one-time purchase to reconcile`)
    }
    return
  }
  if (event.event_type === "PAYMENT.CAPTURE.REVERSED") {
    await updateOneTimePurchaseStatus(deps.supabase, purchase, { status: "reversed" })
    return
  }
  if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
    const raw = event.resource?.amount?.value ?? event.resource?.amount?.total
    const refund =
      raw && Number.isFinite(Number(raw)) ? Math.round(Number(raw) * 100) : purchase.amount_minor
    const cumulative = Math.min(purchase.amount_minor, purchase.refunded_amount_minor + refund)
    await updateOneTimePurchaseStatus(deps.supabase, purchase, {
      status: cumulative >= purchase.amount_minor ? "refunded" : "paid",
      refunded_amount_minor: cumulative,
      refunded_at: new Date().toISOString(),
    })
  }
}

function paymentRuntime() {
  return resolvePaymentRuntime({
    VERCEL_ENV: process.env.VERCEL_ENV,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    PAYPAL_ENVIRONMENT: process.env.PAYPAL_ENVIRONMENT,
  })
}

function reportPayPalWebhookPaymentFailure(
  deps: PayPalWebhookDeps,
  failure: PaymentFailureDetails,
) {
  try {
    const report = deps.capturePaymentFailure ?? captureServerPaymentFailure
    report(failure)
  } catch {
    // Observability must not alter webhook reconciliation behavior.
  }
}

export function payPalCaptureIdForWebhook(event: PayPalWebhookEvent): string | null {
  const value =
    event.event_type === "PAYMENT.CAPTURE.COMPLETED"
      ? event.resource?.id
      : event.resource?.supplementary_data?.related_ids?.capture_id
  return value?.trim() || null
}

export function payPalDisputeCaptureIdsForWebhook(event: PayPalWebhookEvent): string[] {
  return [
    ...new Set(
      (event.resource?.disputed_transactions ?? [])
        .map(
          (transaction) =>
            transaction.seller_transaction_id ??
            transaction.transaction_info?.seller_transaction_id,
        )
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ]
}

export function validatePayPalCaptureCompletedWebhook(
  event: PayPalWebhookEvent,
  intent: PayPalOrderIntentRow,
  captureId: string,
  expectedMerchantId = process.env.PAYPAL_MERCHANT_ID,
) {
  const resource = event.resource
  const amount = resource?.amount
  const eventOrderId = resource?.supplementary_data?.related_ids?.order_id?.trim()
  const eventToken = resource?.custom_id?.trim()
  const eventMerchantId = resource?.payee?.merchant_id?.trim()
  const currency = (amount?.currency_code ?? amount?.currency)?.trim().toUpperCase()
  const value = amount?.value ?? amount?.total

  if (
    !expectedMerchantId?.trim() ||
    event.event_type !== "PAYMENT.CAPTURE.COMPLETED" ||
    resource?.id?.trim() !== captureId ||
    resource?.status !== "COMPLETED" ||
    currency !== PAYPAL_PERSONAL_PLAN_ONCE_CURRENCY ||
    value !== PAYPAL_PERSONAL_PLAN_ONCE_AMOUNT ||
    !eventOrderId ||
    !intent.provider_order_id ||
    eventOrderId !== intent.provider_order_id ||
    !eventToken ||
    eventToken !== intent.token ||
    (eventMerchantId && eventMerchantId !== expectedMerchantId.trim())
  ) {
    throw new Error("PayPal one-time capture webhook failed validation")
  }
}

async function verifiedPayPalWebhookCaptureWithMerchantCheck(
  event: PayPalWebhookEvent,
  intent: PayPalOrderIntentRow,
  captureId: string,
): Promise<VerifiedPayPalCapture> {
  if (event.resource?.payee?.merchant_id?.trim()) {
    return verifiedPayPalCaptureFromWebhook(event, captureId)
  }

  const order = await retrieveProviderPayPalOrder(intent.provider_order_id!)
  return validateCapturedPayPalOrder(order, intent, undefined, { expectedCaptureId: captureId })
}

export function assertValidPayPalOneTimeCaptureEvent(event: PayPalWebhookEvent): void {
  const amount = event.resource?.amount
  const value = amount?.value ?? amount?.total
  const currency = amount?.currency_code ?? amount?.currency
  if (
    value !== PERSONAL_PLAN_ONCE_PRODUCT.amount.toFixed(2) ||
    currency?.toUpperCase() !== PERSONAL_PLAN_ONCE_PRODUCT.currency
  ) {
    throw new Error("PayPal one-time capture amount or currency does not match the offer")
  }
}

async function activateOrRefreshSubscription(
  subscription: PayPalSubscription,
  deps: PayPalWebhookDeps,
): Promise<PayPalActivationOutcome> {
  if (!subscription.id) throw new Error("PayPal subscription is missing id")

  const token = subscription.custom_id?.trim()
  const intent = token ? await findPayPalCheckoutIntentByToken(deps.supabase, token) : null
  const existing = await findBillingSubscriptionByProviderId(
    deps.supabase,
    "paypal",
    subscription.id,
  )

  if (intent?.status === "duplicate") {
    await cancelAndMarkPayPalDuplicate({
      cancelPayPalSubscription: deps.cancelPayPalSubscription ?? cancelPayPalSubscriptionForWebhook,
      reason: intent.duplicate_reason ?? "reactivation_reservation_race",
      subscriptionId: subscription.id,
      supabase: deps.supabase,
      token: intent.token,
    })
    return { kind: "none", reason: "quarantined" }
  }
  if (!existing && !intent) {
    throw new Error(`PayPal subscription ${subscription.id} has no checkout intent or local row`)
  }
  if (!existing && intent && isPayPalCheckoutIntentExpired(intent)) {
    await markPayPalCheckoutIntentExpired(deps.supabase, intent.token)
    const cancel = deps.cancelPayPalSubscription ?? cancelPayPalSubscriptionForWebhook
    await cancel(subscription.id, "PayPal checkout intent expired before activation")
    return { kind: "none", reason: "expired" }
  }

  let boundIntent = intent
  if (token && intent && !intent.provider_subscription_id) {
    try {
      boundIntent = await bindPayPalCheckoutIntentToSubscription(
        deps.supabase,
        token,
        subscription.id,
        intent.email ?? null,
      )
    } catch (error) {
      if (error instanceof PayPalCheckoutIntentBindingError && !existing) {
        const cancel = deps.cancelPayPalSubscription ?? cancelPayPalSubscriptionForWebhook
        await cancel(
          subscription.id,
          "Duplicate PayPal subscription reused an existing Chaarlie checkout token",
        )
        return { kind: "none", reason: "duplicate" }
      }
      throw error
    }
  } else if (token && intent && intent.provider_subscription_id !== subscription.id) {
    if (!existing) {
      const cancel = deps.cancelPayPalSubscription ?? cancelPayPalSubscriptionForWebhook
      await cancel(
        subscription.id,
        "Duplicate PayPal subscription reused an existing Chaarlie checkout token",
      )
      return { kind: "none", reason: "duplicate" }
    }
    boundIntent = null
  }

  if (!existing && boundIntent) {
    const fallbackAccountEmail = boundIntent.email ?? subscription.subscriber?.email_address ?? null
    const duplicateReason = await findPayPalCheckoutDuplicateReason(
      deps.supabase,
      boundIntent,
      subscription,
      { fallbackAccountEmail },
    )
    if (duplicateReason) {
      await cancelAndMarkPayPalDuplicate({
        cancelPayPalSubscription:
          deps.cancelPayPalSubscription ?? cancelPayPalSubscriptionForWebhook,
        reason: duplicateReason,
        retrievePayPalSubscription:
          deps.retrievePayPalSubscription ?? retrievePayPalSubscriptionForWebhook,
        subscriptionId: subscription.id,
        supabase: deps.supabase,
        token: boundIntent.token,
      })
      return { kind: "none", reason: "duplicate" }
    }
  }

  const activation: PayPalCheckoutAccountResult = await ensurePayPalCheckoutAccount(subscription, {
    supabase: deps.supabase,
    premiumTierId: deps.premiumTierId,
    activationKey: boundIntent?.token,
    accountEmail: boundIntent?.email ?? null,
    interval: boundIntent?.interval ?? existing?.interval ?? intervalFromMetadata(subscription),
    leadId: boundIntent?.lead_id ?? null,
    linkQuizToProfile: deps.linkQuizToProfile,
  })

  if (activation.status === "pending") return { kind: "pending" }
  if (activation.status === "duplicate") return { kind: "none", reason: "duplicate" }
  if (
    boundIntent &&
    (["created", "approved", "activated"] as PayPalCheckoutIntentRow["status"][]).includes(
      boundIntent.status,
    )
  ) {
    await markPayPalCheckoutIntentActivated(deps.supabase, boundIntent.token)
  }
  const billingRow = await findBillingSubscriptionByProviderId(
    deps.supabase,
    "paypal",
    subscription.id,
  )
  if (!billingRow) {
    throw new Error(
      `PayPal subscription ${subscription.id} activation did not create a billing row`,
    )
  }
  return {
    kind: "active",
    billingRow,
    checkoutIntent: boundIntent,
    funnelMetadata: boundIntent?.metadata ?? null,
  }
}

/**
 * The Premium sheet's freemium lane, hung off an activation that actually produced an active
 * subscription (docket rework — closing T14's one open concern).
 *
 * Inert for everything else: a subscription whose checkout intent is not the sheet's, and
 * every subscription at all while the flag is off, leaves this function without touching a
 * single row. Identity is the intent's `user_id` versus the account the activation itself
 * resolved, and the provider reference is the subscription id — the same one the sheet's
 * completion endpoint provisions against, so the two lanes share one admission row.
 */
async function provisionPremiumSheetPurchase(
  outcome: PayPalActivationOutcome,
  deps: PayPalWebhookDeps,
): Promise<void> {
  if (outcome.kind !== "active") return
  const intent = outcome.checkoutIntent
  if (!freemiumPayPalProvisioningUserId(intent, deps)) return
  await runFreemiumPayPalSubscriptionProvisioning(intent, deps, {
    userId: outcome.billingRow.user_id,
    subscriptionId: outcome.billingRow.provider_subscription_id,
  })
}

async function updateExistingSubscription(
  subscription: PayPalSubscription,
  deps: PayPalWebhookDeps,
  patch: Partial<BillingSubscriptionInput>,
): Promise<BillingSubscriptionRow | null> {
  if (!subscription.id) throw new Error("PayPal subscription is missing id")

  const existing = await findBillingSubscriptionByProviderId(
    deps.supabase,
    "paypal",
    subscription.id,
  )
  if (!existing) {
    const intentByProvider = await findPayPalCheckoutIntentByProviderSubscriptionId(
      deps.supabase,
      subscription.id,
    )
    const intent =
      intentByProvider ??
      (subscription.custom_id?.trim()
        ? await findPayPalCheckoutIntentByToken(deps.supabase, subscription.custom_id.trim())
        : null)
    if (intent?.status === "duplicate") {
      await markPayPalCheckoutIntentDuplicate(
        deps.supabase,
        intent.token,
        intent.duplicate_reason ?? "reactivation_reservation_race",
        subscription.id,
      )
      return null
    }
    throw new Error(`PayPal billing subscription ${subscription.id} has no local billing row`)
  }

  const input = {
    ...toBillingSubscriptionInputFromPayPal(
      subscription,
      existing.user_id,
      existing.interval ?? intervalFromMetadata(subscription),
    ),
    current_period_end:
      subscription.billing_info?.next_billing_time ?? existing.current_period_end ?? null,
    ...(patch.cancel_at_period_end === true && patch.cancel_scheduled_at === undefined
      ? { cancel_scheduled_at: existing.current_period_end }
      : {}),
    ...patch,
  }
  const billingRow = await upsertBillingSubscription(deps.supabase, input)
  await mirrorBillingSubscriptionToProfile(deps.supabase, billingRow, deps.premiumTierId, {
    freeTierId: deps.freeTierId,
  })
  return billingRow
}

async function recordPayPalSuccessfulPayment(
  event: PayPalWebhookEvent,
  deps: PayPalWebhookDeps,
  outcome: PayPalActivationOutcome,
  sale: PayPalSaleIdentity,
) {
  if (outcome.kind !== "active") return
  const billingRow = outcome.billingRow
  const saleId = sale.saleId
  const amount = payPalEventAmount(event)
  const currency = payPalEventCurrency(event)
  const classification = await classifyPayPalSuccessfulPayment(event, deps, outcome, saleId)

  console.info("[paypal:webhook] payment classified", {
    eventId: event.id,
    subscriptionId: billingRow.provider_subscription_id,
    saleId,
    classification,
    intentStatus: outcome.checkoutIntent?.status ?? "missing",
  })

  if (classification === "historical_noop") return

  if (classification === "initial") {
    const purchaseEventKey = billingAnalyticsEventKey({
      provider: "paypal",
      eventName: "purchase_completed",
      sourceObjectId: billingRow.provider_subscription_id,
    })
    const funnelSessionId = stringMetadata(outcome.funnelMetadata, "funnel_session_id")
    const funnelPackageKey = stringMetadata(outcome.funnelMetadata, "funnel_package_key")
    const pricingCatalog =
      parseSubscriptionPricingCatalog(stringMetadata(billingRow.metadata, "pricing_catalog")) ??
      parseSubscriptionPricingCatalog(stringMetadata(outcome.funnelMetadata, "pricing_catalog")) ??
      STANDARD_PRICING_CATALOG
    const planId = billingRow.interval
      ? getStripePricingPlan(billingRow.interval, pricingCatalog).analyticsId
      : undefined
    const paypalPlanId =
      stringMetadata(billingRow.metadata, "paypal_plan_id") ??
      stringMetadata(outcome.funnelMetadata, "paypal_plan_id")
    const purchaseDestinations = [...BILLING_ANALYTICS_EXTERNAL_DESTINATIONS]
    if (
      isFunnelAttributionEnabled() &&
      isBillingFunnelDeliveryEnabled() &&
      funnelSessionId &&
      funnelPackageKey
    ) {
      purchaseDestinations.push("funnel")
    }
    await recordPayPalBillingAnalytics(deps, {
      eventKey: purchaseEventKey,
      eventName: "purchase_completed",
      billingRow,
      event,
      sourceObjectId: saleId,
      payload: {
        ...billingSubscriptionPayload(billingRow),
        value: amount,
        currency,
        payment_event_type: event.event_type,
        checkout_reference: billingRow.provider_subscription_id,
        funnel_session_id: funnelSessionId,
        funnel_package_key: funnelPackageKey,
        plan_id: planId,
        pricing_catalog: pricingCatalog,
        paypal_plan_id: paypalPlanId,
      },
      destinations: purchaseDestinations,
    })
    await recordPayPalBillingAnalytics(deps, {
      eventKey: billingAnalyticsEventKey({
        provider: "paypal",
        eventName: "subscription_started",
        sourceObjectId: billingRow.provider_subscription_id,
      }),
      eventName: "subscription_started",
      billingRow,
      event,
      sourceObjectId: billingRow.provider_subscription_id,
      payload: billingSubscriptionPayload(billingRow, {
        payment_event_type: event.event_type,
        plan_id: planId,
        pricing_catalog: pricingCatalog,
        paypal_plan_id: paypalPlanId,
      }),
    })
    return
  }

  await recordPayPalBillingAnalytics(deps, {
    eventKey: billingAnalyticsEventKey({
      provider: "paypal",
      eventName: "payment_completed",
      sourceObjectId: saleId,
    }),
    eventName: "payment_completed",
    billingRow,
    event,
    sourceObjectId: saleId,
    payload: {
      ...billingSubscriptionPayload(billingRow),
      value: amount,
      currency,
      payment_event_type: event.event_type,
    },
  })
}

async function classifyPayPalSuccessfulPayment(
  event: PayPalWebhookEvent,
  deps: PayPalWebhookDeps,
  outcome: Extract<PayPalActivationOutcome, { kind: "active" }>,
  saleId: string,
): Promise<PayPalPaymentClassification> {
  const subscriptionId = outcome.billingRow.provider_subscription_id
  const purchaseEventKey = billingAnalyticsEventKey({
    provider: "paypal",
    eventName: "purchase_completed",
    sourceObjectId: subscriptionId,
  })
  const existingPurchase = await findBillingAnalyticsEventByKey(deps.supabase, purchaseEventKey)
  if (existingPurchase) {
    return existingPurchase.source_object_id === saleId ? "initial" : "renewal"
  }

  const paymentEventKey = billingAnalyticsEventKey({
    provider: "paypal",
    eventName: "payment_completed",
    sourceObjectId: saleId,
  })
  const existingPayment = await findBillingAnalyticsEventByKey(deps.supabase, paymentEventKey)
  if (existingPayment?.source_object_id === saleId) return "historical_noop"

  if (
    outcome.checkoutIntent &&
    isPayPalCheckoutIntentEligibleForInitialPayment(outcome.checkoutIntent, {
      providerSubscriptionId: subscriptionId,
      eventCreatedAt: event.create_time!,
    })
  ) {
    return "initial"
  }

  return "renewal"
}

type PayPalSaleIdentity = { saleId: string; occurredAt: string }

function assertValidPayPalSaleEvent(event: PayPalWebhookEvent): PayPalSaleIdentity {
  const saleId = event.resource?.id?.trim()
  if (!saleId) throw new Error("PayPal sale webhook is missing sale id")
  if (!event.create_time || !Number.isFinite(Date.parse(event.create_time))) {
    throw new Error("PayPal sale webhook has invalid create_time")
  }
  return { saleId, occurredAt: event.create_time }
}

function stringMetadata(metadata: Record<string, unknown> | null, key: string) {
  const value = metadata?.[key]
  return typeof value === "string" && value ? value : undefined
}

async function recordPayPalLifecycleEvent(
  event: PayPalWebhookEvent,
  deps: PayPalWebhookDeps,
  billingRow: BillingSubscriptionRow,
  eventName: BillingAnalyticsEventName,
) {
  await recordPayPalBillingAnalytics(deps, {
    eventKey: billingAnalyticsEventKey({
      provider: "paypal",
      eventName,
      sourceObjectId: `${billingRow.provider_subscription_id}:${event.id}`,
    }),
    eventName,
    billingRow,
    event,
    sourceObjectId: billingRow.provider_subscription_id,
    payload: billingSubscriptionPayload(billingRow, {
      payment_event_type: event.event_type,
    }),
  })
}

async function recordLinkedPayPalRefund(event: PayPalWebhookEvent, deps: PayPalWebhookDeps) {
  let subscriptionId: string
  try {
    subscriptionId = getEventSubscriptionId(event, event.event_type ?? "")
  } catch {
    throw new Error(
      `PayPal refund/reversal ${event.id ?? "unknown"} is missing a subscription link`,
    )
  }

  const billingRow = await findBillingSubscriptionByProviderId(
    deps.supabase,
    "paypal",
    subscriptionId,
  )
  if (!billingRow) {
    throw new Error(
      `PayPal refund/reversal ${event.id ?? "unknown"} has no local billing row for ${subscriptionId}`,
    )
  }

  await recordPayPalBillingAnalytics(deps, {
    eventKey: billingAnalyticsEventKey({
      provider: "paypal",
      eventName: "refund_completed",
      sourceObjectId: event.resource?.id ?? event.id ?? subscriptionId,
    }),
    eventName: "refund_completed",
    billingRow,
    event,
    sourceObjectId: event.resource?.id ?? event.id ?? subscriptionId,
    payload: {
      ...billingSubscriptionPayload(billingRow),
      value: payPalEventAmount(event),
      currency: payPalEventCurrency(event),
      payment_event_type: event.event_type,
    },
  })
}

async function recordPayPalBillingAnalytics(
  deps: PayPalWebhookDeps,
  input: {
    eventKey: string
    eventName: BillingAnalyticsEventName
    billingRow: BillingSubscriptionRow
    event: PayPalWebhookEvent
    sourceObjectId: string
    payload: Record<string, unknown>
    destinations?: BillingAnalyticsDestination[]
  },
) {
  await recordBillingAnalyticsEvent(
    deps.supabase,
    {
      eventKey: input.eventKey,
      eventName: input.eventName,
      userId: input.billingRow.user_id,
      provider: "paypal",
      providerCustomerId: input.billingRow.provider_customer_id,
      providerSubscriptionId: input.billingRow.provider_subscription_id,
      sourceEventId: input.event.id ?? null,
      sourceObjectId: input.sourceObjectId,
      occurredAt: payPalEventTimestamp(input.event),
      payload: input.payload,
    },
    { defer: deps.defer, destinations: input.destinations },
  )
}

function payPalEventTimestamp(event: PayPalWebhookEvent) {
  return event.create_time ?? new Date().toISOString()
}

function payPalEventAmount(event: PayPalWebhookEvent) {
  const value = event.resource?.amount?.value ?? event.resource?.amount?.total
  if (!value) return undefined
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : undefined
}

function payPalEventCurrency(event: PayPalWebhookEvent) {
  const value = event.resource?.amount?.currency_code ?? event.resource?.amount?.currency
  return value?.trim().toUpperCase() || undefined
}

function getEventSubscriptionId(event: PayPalWebhookEvent, eventType: string): string {
  const id = eventType.startsWith("PAYMENT.")
    ? (event.resource?.billing_agreement_id ?? event.resource?.subscription_id)
    : (event.resource?.subscription_id ?? event.resource?.id)
  if (!id) throw new Error("PayPal webhook event is missing subscription id")
  return id
}

function intervalFromMetadata(subscription: PayPalSubscription): BillingInterval {
  const configuredInterval = getPayPalIntervalForPlanId(subscription.plan_id)
  if (configuredInterval) return configuredInterval

  const interval = subscription.plan_id?.toLowerCase()
  if (interval?.includes("quarter")) return "quarter"
  if (interval?.includes("year") || interval?.includes("annual")) return "year"
  return "month"
}

async function retrievePayPalSubscriptionForWebhook(
  subscriptionId: string,
): Promise<PayPalSubscription> {
  const { retrievePayPalSubscription } = await import("@/lib/paypal/subscriptions")
  return retrievePayPalSubscription(subscriptionId)
}

async function cancelPayPalSubscriptionForWebhook(
  subscriptionId: string,
  reason: string,
): Promise<void> {
  const { cancelPayPalSubscription } = await import("@/lib/paypal/subscriptions")
  return cancelPayPalSubscription(subscriptionId, reason)
}
