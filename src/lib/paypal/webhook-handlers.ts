import type { SupabaseClient } from "@supabase/supabase-js"
import {
  billingAnalyticsEventKey,
  billingSubscriptionPayload,
} from "@/lib/billing/analytics-events"
import { recordBillingAnalyticsEvent } from "@/lib/billing/analytics-outbox"
import { applyPlanChangeAtRenewal } from "@/lib/billing/plan-change"
import { mirrorBillingSubscriptionToProfile } from "@/lib/billing/entitlements"
import {
  findBillingSubscriptionByProviderId,
  upsertBillingSubscription,
} from "@/lib/billing/subscriptions"
import { claimWebhookEvent, releaseWebhookEventClaim } from "@/lib/billing/webhook-events"
import type {
  BillingAnalyticsEventName,
  BillingInterval,
  BillingSubscriptionInput,
  BillingSubscriptionRow,
} from "@/lib/billing/types"
import {
  bindPayPalCheckoutIntentToSubscription,
  findPayPalCheckoutIntentByProviderSubscriptionId,
  findPayPalCheckoutIntentByToken,
  isPayPalCheckoutIntentExpired,
  markPayPalCheckoutIntentActivated,
  markPayPalCheckoutIntentDuplicate,
  markPayPalCheckoutIntentExpired,
  PayPalCheckoutIntentBindingError,
} from "@/lib/paypal/checkout-intents"
import {
  ensurePayPalCheckoutAccount,
  type PayPalCheckoutAccountResult,
} from "@/lib/paypal/checkout-activation"
import {
  cancelAndMarkPayPalDuplicate,
  findPayPalCheckoutDuplicateReason,
} from "@/lib/paypal/duplicate-guard"
import type { PayPalSubscription } from "@/lib/paypal/subscription-shapes"
import { toBillingSubscriptionInputFromPayPal } from "@/lib/paypal/subscription-shapes"
import { getPayPalIntervalForPlanId } from "@/lib/paypal/plans"
import { recordFunnelPurchaseFromSession } from "@/lib/funnel/server"

export type PayPalWebhookEvent = {
  id?: string
  event_type?: string
  create_time?: string
  resource?: {
    id?: string
    billing_agreement_id?: string
    subscription_id?: string
    amount?: {
      total?: string
      value?: string
      currency?: string
      currency_code?: string
    }
  }
}

export interface PayPalWebhookDeps {
  supabase: SupabaseClient
  premiumTierId: string
  freeTierId: string
  retrievePayPalSubscription?: (subscriptionId: string) => Promise<PayPalSubscription>
  cancelPayPalSubscription?: (subscriptionId: string, reason: string) => Promise<void>
  defer?: (work: () => void | Promise<void>) => void
  linkQuizToProfile?: (userId: string, email: string | undefined, leadId?: string) => Promise<void>
  recordBillingAnalytics?: boolean
}

export type PayPalWebhookResult =
  | { handled: true; skipped?: false }
  | { handled: true; skipped: true }
  | { handled: false; skipped?: false }

type PayPalActivationOutcome =
  | { kind: "none" }
  | {
      kind: "active"
      billingRow: BillingSubscriptionRow
      firstPurchase: boolean
      funnelMetadata: Record<string, unknown> | null
    }

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
      case "BILLING.SUBSCRIPTION.ACTIVATED":
      case "PAYMENT.SALE.COMPLETED": {
        let outcome = await activateOrRefreshSubscription(subscription, deps)
        if (eventType === "PAYMENT.SALE.COMPLETED" && outcome.kind === "active") {
          const providerInterval = getPayPalIntervalForPlanId(subscription.plan_id)
          if (providerInterval) {
            const applied = await applyPlanChangeAtRenewal(deps.supabase, {
              subscription: outcome.billingRow,
              observedInterval: providerInterval,
              occurredAt: event.create_time ?? new Date().toISOString(),
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
        }
        if (deps.recordBillingAnalytics) {
          await recordPayPalSuccessfulPayment(event, deps, outcome, eventType)
        }
        return { handled: true }
      }
      case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
      case "BILLING.SUBSCRIPTION.SUSPENDED": {
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
    return { kind: "none" }
  }
  if (!existing && !intent) {
    throw new Error(`PayPal subscription ${subscription.id} has no checkout intent or local row`)
  }
  if (!existing && intent && isPayPalCheckoutIntentExpired(intent)) {
    await markPayPalCheckoutIntentExpired(deps.supabase, intent.token)
    const cancel = deps.cancelPayPalSubscription ?? cancelPayPalSubscriptionForWebhook
    await cancel(subscription.id, "PayPal checkout intent expired before activation")
    return { kind: "none" }
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
        return { kind: "none" }
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
      return { kind: "none" }
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
      return { kind: "none" }
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

  if (activation.status === "pending" || activation.status === "duplicate") return { kind: "none" }
  if (boundIntent) await markPayPalCheckoutIntentActivated(deps.supabase, boundIntent.token)
  const billingRow = await findBillingSubscriptionByProviderId(
    deps.supabase,
    "paypal",
    subscription.id,
  )
  if (!billingRow) return { kind: "none" }
  return {
    kind: "active",
    billingRow,
    firstPurchase: !existing,
    funnelMetadata: boundIntent?.metadata ?? null,
  }
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
  eventType: string,
) {
  if (outcome.kind !== "active") return
  const billingRow = outcome.billingRow
  const amount = payPalEventAmount(event)
  const currency = payPalEventCurrency(event)

  if (outcome.firstPurchase) {
    const purchaseEventKey = billingAnalyticsEventKey({
      provider: "paypal",
      eventName: "purchase_completed",
      sourceObjectId: billingRow.provider_subscription_id,
    })
    const funnelSessionId = stringMetadata(outcome.funnelMetadata, "funnel_session_id")
    const funnelPackageKey = stringMetadata(outcome.funnelMetadata, "funnel_package_key")
    await recordPayPalBillingAnalytics(deps, {
      eventKey: purchaseEventKey,
      eventName: "purchase_completed",
      billingRow,
      event,
      sourceObjectId: event.resource?.id ?? billingRow.provider_subscription_id,
      payload: {
        ...billingSubscriptionPayload(billingRow),
        value: amount,
        currency,
        payment_event_type: eventType,
        funnel_session_id: funnelSessionId,
        funnel_package_key: funnelPackageKey,
      },
    })
    await recordFunnelPurchaseFromSession({
      sessionId: funnelSessionId,
      packageKey: funnelPackageKey,
      eventId: purchaseEventKey,
      provider: "paypal",
      reference: billingRow.provider_subscription_id,
      userId: billingRow.user_id,
    }).catch((error) => console.warn("[funnel] PayPal purchase tracking failed", error))
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
      payload: billingSubscriptionPayload(billingRow, { payment_event_type: eventType }),
    })
    return
  }

  if (eventType === "PAYMENT.SALE.COMPLETED") {
    await recordPayPalBillingAnalytics(deps, {
      eventKey: billingAnalyticsEventKey({
        provider: "paypal",
        eventName: "payment_completed",
        sourceObjectId: event.resource?.id ?? event.id ?? billingRow.provider_subscription_id,
      }),
      eventName: "payment_completed",
      billingRow,
      event,
      sourceObjectId: event.resource?.id ?? event.id ?? billingRow.provider_subscription_id,
      payload: {
        ...billingSubscriptionPayload(billingRow),
        value: amount,
        currency,
        payment_event_type: eventType,
      },
    })
  }
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
    { defer: deps.defer },
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
