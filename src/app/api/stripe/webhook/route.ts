import { after, NextResponse, type NextRequest } from "next/server"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { getStripe } from "@/lib/stripe/client"
import {
  CheckoutActivationError,
  type CheckoutAccountResult,
} from "@/lib/stripe/checkout-activation"
import {
  handleCheckoutSessionCompleted,
  handleCheckoutSessionExpired,
  handleCheckoutSessionAsyncPaymentSucceeded,
  handleCheckoutSessionAsyncPaymentFailed,
  handleChargeDisputeCreated,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaymentFailed,
  findProfileByStripeCustomerId,
} from "@/lib/stripe/webhook-handlers"
import { getStripeTierIds } from "@/lib/stripe/tier-ids"
import { linkQuizToProfile as defaultLinkQuizToProfile } from "@/lib/quiz/link-to-profile"
import type Stripe from "stripe"
import {
  amountFromMinorUnits,
  billingAnalyticsEventKey,
  normalizedCurrency,
  planIdForInterval,
} from "@/lib/billing/analytics-events"
import {
  recordBillingAnalyticsEvent,
  type BillingAnalyticsEventInput,
} from "@/lib/billing/analytics-outbox"
import {
  identifyCustomerIoServerPerson,
  logCustomerIoServerResult,
  trackCustomerIoServerEvent,
  type CustomerIoServerProperties,
} from "@/lib/customerio/server"
import {
  buildCustomerIoCheckoutCompletedSync,
  buildCustomerIoInvoicePaymentFailedSync,
  buildCustomerIoSubscriptionLifecycleSync,
  type CustomerIoLifecycleEvent,
} from "@/lib/customerio/stripe-lifecycle"
import { claimWebhookEvent, releaseWebhookEventClaim } from "@/lib/billing/webhook-events"
import { recordFunnelPurchaseFromSession } from "@/lib/funnel/server"

export const runtime = "nodejs" // raw body required; edge runtime buffers differently

async function getPremiumTierId(supabase: SupabaseClient) {
  return (await getStripeTierIds(supabase)).premiumTierId
}

async function getFreeTierId(supabase: SupabaseClient) {
  return (await getStripeTierIds(supabase)).freeTierId
}

function stripeId(value: string | { id?: string } | null | undefined) {
  if (typeof value === "string") return value
  return value?.id
}

function stripeEventTimestamp(event: Stripe.Event) {
  return typeof event.created === "number"
    ? new Date(event.created * 1000).toISOString()
    : new Date().toISOString()
}

function invoiceSubscriptionId(invoice: Stripe.Invoice) {
  const candidate = invoice as Stripe.Invoice & {
    subscription?: string | { id?: string } | null
    parent?: {
      subscription_details?: { subscription?: string | { id?: string } | null } | null
    } | null
  }
  return (
    stripeId(candidate.subscription) ??
    stripeId(candidate.parent?.subscription_details?.subscription)
  )
}

export function shouldRecordStripePaymentCompleted(invoice: Stripe.Invoice) {
  const candidate = invoice as Stripe.Invoice & { billing_reason?: string | null }
  return candidate.billing_reason !== "subscription_create"
}

function stripeChargeCustomerId(charge: Stripe.Charge) {
  return stripeId(charge.customer)
}

async function recordStripeBillingAnalytics(
  supabase: SupabaseClient,
  defer: (work: () => void | Promise<void>) => void,
  input: Omit<BillingAnalyticsEventInput, "provider">,
) {
  await recordBillingAnalyticsEvent(supabase, { ...input, provider: "stripe" }, { defer })
}

async function recordStripeCheckoutAnalytics(input: {
  activation: CheckoutAccountResult
  defer: (work: () => void | Promise<void>) => void
  eventId: string
  session: Stripe.Checkout.Session
  supabase: SupabaseClient
  timestamp: string
}) {
  const { activation, defer, eventId, session, supabase, timestamp } = input
  if (!activation.stripeSubscriptionId || !activation.stripeCustomerId) return

  const interval = activation.subscriptionInterval
  const value = amountFromMinorUnits(session.amount_total)
  const currency = normalizedCurrency(session.currency)
  const planId = planIdForInterval(interval)
  const funnelSessionId = session.metadata?.funnel_session_id
  const funnelPackageKey = session.metadata?.funnel_package_key
  const purchaseEventKey = billingAnalyticsEventKey({
    provider: "stripe",
    eventName: "purchase_completed",
    sourceObjectId: session.id,
  })

  await recordStripeBillingAnalytics(supabase, defer, {
    eventKey: purchaseEventKey,
    eventName: "purchase_completed",
    userId: activation.userId,
    providerCustomerId: activation.stripeCustomerId,
    providerSubscriptionId: activation.stripeSubscriptionId,
    sourceEventId: eventId,
    sourceObjectId: session.id,
    occurredAt: timestamp,
    payload: {
      checkout_session_id: session.id,
      meta_event_id: session.id,
      value,
      currency,
      interval,
      plan_id: planId,
      subscription_status: activation.subscriptionStatus,
      funnel_session_id: funnelSessionId,
      funnel_package_key: funnelPackageKey,
    },
  })

  await recordFunnelPurchaseFromSession({
    sessionId: funnelSessionId,
    packageKey: funnelPackageKey,
    eventId: purchaseEventKey,
    provider: "stripe",
    reference: session.id,
    userId: activation.userId,
  }).catch((error) => console.warn("[funnel] Stripe purchase tracking failed", error))

  await recordStripeBillingAnalytics(supabase, defer, {
    eventKey: billingAnalyticsEventKey({
      provider: "stripe",
      eventName: "subscription_started",
      sourceObjectId: activation.stripeSubscriptionId,
    }),
    eventName: "subscription_started",
    userId: activation.userId,
    providerCustomerId: activation.stripeCustomerId,
    providerSubscriptionId: activation.stripeSubscriptionId,
    sourceEventId: eventId,
    sourceObjectId: activation.stripeSubscriptionId,
    occurredAt: timestamp,
    payload: {
      checkout_session_id: session.id,
      interval,
      plan_id: planId,
      subscription_status: activation.subscriptionStatus,
    },
  })
}

function scheduleCustomerIoLifecycle(
  defer: (work: () => void | Promise<void>) => void,
  label: string,
  work: () => Promise<void>,
) {
  defer(async () => {
    try {
      await work()
    } catch (error) {
      console.warn("[customerio:stripe]", label, error)
    }
  })
}

async function dispatchCustomerIoLifecycle(sync: {
  userId: string
  identifyTraits?: CustomerIoServerProperties
  identifyMessageId?: string
  events?: CustomerIoLifecycleEvent[]
}) {
  if (sync.identifyTraits && sync.identifyMessageId) {
    const identifyResult = await identifyCustomerIoServerPerson({
      userId: sync.userId,
      traits: sync.identifyTraits,
      messageId: sync.identifyMessageId,
      timestamp: sync.events?.[0]?.timestamp,
    })
    logCustomerIoServerResult(`identify ${sync.identifyMessageId}`, identifyResult)
  }

  for (const event of sync.events ?? []) {
    const eventResult = await trackCustomerIoServerEvent({
      userId: sync.userId,
      event: event.event,
      properties: event.properties,
      messageId: event.messageId,
      timestamp: event.timestamp,
    })
    logCustomerIoServerResult(`track ${event.event} ${event.messageId}`, eventResult)
  }
}

function scheduleCheckoutCompletedSync(input: {
  activation: CheckoutAccountResult
  defer: (work: () => void | Promise<void>) => void
  eventId: string
  session: Stripe.Checkout.Session
  timestamp: string
}) {
  const { activation, defer, eventId, session, timestamp } = input
  scheduleCustomerIoLifecycle(defer, `checkout ${session.id}`, async () => {
    if (
      !activation.subscriptionInterval ||
      !activation.stripeCustomerId ||
      !activation.stripeSubscriptionId ||
      !activation.subscriptionStatus
    ) {
      return
    }
    const sync = buildCustomerIoCheckoutCompletedSync({
      email: activation.email,
      interval: activation.subscriptionInterval,
      planId: `premium_${activation.subscriptionInterval}`,
      session,
      stripeEventId: eventId,
      subscriptionStatus: activation.subscriptionStatus,
      timestamp,
      userId: activation.userId,
    })
    await dispatchCustomerIoLifecycle(sync)
  })
}

type StripeWebhookEventDeps = {
  supabase: SupabaseClient
  stripe: Stripe
  defer?: (work: () => void | Promise<void>) => void
  getFreeTierId?: (supabase: SupabaseClient) => Promise<string>
  getPremiumTierId?: (supabase: SupabaseClient) => Promise<string>
  linkQuizToProfile?: typeof defaultLinkQuizToProfile
  recordBillingAnalytics?: boolean
}

export async function handleStripeWebhookEvent(event: Stripe.Event, deps: StripeWebhookEventDeps) {
  const {
    supabase,
    stripe,
    defer = after,
    getFreeTierId: resolveFreeTierId = getFreeTierId,
    getPremiumTierId: resolvePremiumTierId = getPremiumTierId,
    linkQuizToProfile = defaultLinkQuizToProfile,
    recordBillingAnalytics = false,
  } = deps
  const timestamp = stripeEventTimestamp(event)

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as unknown as Stripe.Checkout.Session
      let activation
      try {
        activation = await handleCheckoutSessionCompleted(session, {
          supabase,
          stripe,
          premiumTierId: await resolvePremiumTierId(supabase),
          linkQuizToProfile,
          profileLinkMode: "defer",
          defer,
        })
      } catch (err) {
        if (err instanceof CheckoutActivationError && err.code === "checkout_session_unpaid") {
          console.info("[stripe] checkout.session.completed not activated", {
            checkoutSessionId: session.id,
            paymentStatus: session.payment_status,
          })
          break
        }
        throw err
      }
      if (!recordBillingAnalytics) {
        scheduleCheckoutCompletedSync({ activation, defer, eventId: event.id, session, timestamp })
      }
      if (recordBillingAnalytics) {
        await recordStripeCheckoutAnalytics({
          activation,
          defer,
          eventId: event.id,
          session,
          supabase,
          timestamp,
        })
      }
      break
    }
    case "checkout.session.expired": {
      const session = event.data.object as unknown as Stripe.Checkout.Session
      await handleCheckoutSessionExpired(session, { supabase })
      break
    }
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as unknown as Stripe.Checkout.Session
      const activation = await handleCheckoutSessionAsyncPaymentSucceeded(session, {
        supabase,
        stripe,
        premiumTierId: await resolvePremiumTierId(supabase),
        linkQuizToProfile,
        profileLinkMode: "defer",
        defer,
      })
      if (activation) {
        if (!recordBillingAnalytics) {
          scheduleCheckoutCompletedSync({
            activation,
            defer,
            eventId: event.id,
            session,
            timestamp,
          })
        }
        if (recordBillingAnalytics) {
          await recordStripeCheckoutAnalytics({
            activation,
            defer,
            eventId: event.id,
            session,
            supabase,
            timestamp,
          })
        }
      }
      break
    }
    case "checkout.session.async_payment_failed": {
      const session = event.data.object as unknown as Stripe.Checkout.Session
      await handleCheckoutSessionAsyncPaymentFailed(session, {
        supabase,
        stripe,
        freeTierId: await resolveFreeTierId(supabase),
      })
      const customerId = stripeId(session.customer)
      const subscriptionId = stripeId(session.subscription)
      if (customerId && subscriptionId) {
        const profile = await findProfileByStripeCustomerId(supabase, customerId)
        if (profile?.id && recordBillingAnalytics) {
          await recordStripeBillingAnalytics(supabase, defer, {
            eventKey: billingAnalyticsEventKey({
              provider: "stripe",
              eventName: "payment_failed",
              sourceObjectId: session.id,
            }),
            eventName: "payment_failed",
            userId: profile.id,
            providerCustomerId: customerId,
            providerSubscriptionId: subscriptionId,
            sourceEventId: event.id,
            sourceObjectId: session.id,
            occurredAt: timestamp,
            payload: {
              checkout_session_id: session.id,
              subscription_status: "canceled",
              reason: "async_payment_failed",
            },
          })
        }
      }
      break
    }
    case "charge.dispute.created": {
      const dispute = event.data.object as unknown as Stripe.Dispute
      await handleChargeDisputeCreated(dispute, {
        supabase,
        stripe,
        freeTierId: await resolveFreeTierId(supabase),
      })
      break
    }
    case "customer.subscription.updated": {
      const eventSubscription = event.data.object as unknown as Stripe.Subscription
      // Stripe can deliver subscription events out of order. Re-read provider truth
      // before updating local entitlement and interval state so a delayed snapshot
      // cannot overwrite a newer plan change.
      const subscription = await stripe.subscriptions.retrieve(eventSubscription.id, {
        expand: ["items.data.price"],
      })
      const result = await handleSubscriptionUpdated(subscription, {
        supabase,
      })
      if (!result.matchedCurrentSubscription) break
      const customerId = stripeId(subscription.customer)
      const eventName =
        subscription.cancel_at_period_end || subscription.status === "canceled"
          ? "subscription_cancelled"
          : "subscription_updated"
      if (customerId && result.profileId && recordBillingAnalytics) {
        await recordStripeBillingAnalytics(supabase, defer, {
          eventKey: billingAnalyticsEventKey({
            provider: "stripe",
            eventName,
            sourceObjectId: `${subscription.id}:${event.id}`,
          }),
          eventName,
          userId: result.profileId,
          providerCustomerId: customerId,
          providerSubscriptionId: subscription.id,
          sourceEventId: event.id,
          sourceObjectId: subscription.id,
          occurredAt: timestamp,
          payload: {
            subscription_status: subscription.status,
            cancel_at_period_end: subscription.cancel_at_period_end ?? false,
          },
        })
      }
      if (!recordBillingAnalytics)
        scheduleCustomerIoLifecycle(defer, `subscription updated ${subscription.id}`, async () => {
          const customerId = stripeId(subscription.customer)
          if (!customerId) return
          const profile = await findProfileByStripeCustomerId(supabase, customerId)
          if (!profile?.id) return
          const sync = buildCustomerIoSubscriptionLifecycleSync({
            email: profile.email,
            eventType: "subscription_updated",
            interval: profile.subscription_interval,
            status: profile.subscription_status ?? subscription.status,
            stripeCustomerId: customerId,
            stripeEventId: event.id,
            stripeSubscriptionId: subscription.id,
            timestamp,
            userId: profile.id,
          })
          await dispatchCustomerIoLifecycle({
            userId: sync.userId,
            identifyTraits: sync.identifyTraits,
            identifyMessageId: sync.identifyMessageId,
            events: [sync.event],
          })
        })
      break
    }
    case "customer.subscription.deleted": {
      const subscription = event.data.object as unknown as Stripe.Subscription
      const result = await handleSubscriptionDeleted(subscription, {
        supabase,
        freeTierId: await resolveFreeTierId(supabase),
      })
      if (!result.matchedCurrentSubscription) break
      const customerId = stripeId(subscription.customer)
      if (customerId && result.profileId && recordBillingAnalytics) {
        await recordStripeBillingAnalytics(supabase, defer, {
          eventKey: billingAnalyticsEventKey({
            provider: "stripe",
            eventName: "subscription_cancelled",
            sourceObjectId: `${subscription.id}:${event.id}`,
          }),
          eventName: "subscription_cancelled",
          userId: result.profileId,
          providerCustomerId: customerId,
          providerSubscriptionId: subscription.id,
          sourceEventId: event.id,
          sourceObjectId: subscription.id,
          occurredAt: timestamp,
          payload: {
            subscription_status: "canceled",
            cancel_at_period_end: false,
          },
        })
      }
      if (!recordBillingAnalytics)
        scheduleCustomerIoLifecycle(defer, `subscription deleted ${subscription.id}`, async () => {
          const customerId = stripeId(subscription.customer)
          if (!customerId) return
          const profile = await findProfileByStripeCustomerId(supabase, customerId)
          if (!profile?.id) return
          const sync = buildCustomerIoSubscriptionLifecycleSync({
            email: profile.email,
            eventType: "subscription_cancelled",
            interval: profile.subscription_interval,
            status: profile.subscription_status ?? "canceled",
            stripeCustomerId: customerId,
            stripeEventId: event.id,
            stripeSubscriptionId: subscription.id,
            timestamp,
            userId: profile.id,
          })
          await dispatchCustomerIoLifecycle({
            userId: sync.userId,
            identifyTraits: sync.identifyTraits,
            identifyMessageId: sync.identifyMessageId,
            events: [sync.event],
          })
        })
      break
    }
    case "invoice.payment_succeeded": {
      const invoice = event.data.object as unknown as Stripe.Invoice
      if (!shouldRecordStripePaymentCompleted(invoice)) break
      const customerId = stripeId(invoice.customer)
      if (!customerId) break
      const profile = await findProfileByStripeCustomerId(supabase, customerId)
      if (!profile?.id) break
      const subscriptionId = invoiceSubscriptionId(invoice) ?? profile.stripe_subscription_id
      if (recordBillingAnalytics)
        await recordStripeBillingAnalytics(supabase, defer, {
          eventKey: billingAnalyticsEventKey({
            provider: "stripe",
            eventName: "payment_completed",
            sourceObjectId: invoice.id,
          }),
          eventName: "payment_completed",
          userId: profile.id,
          providerCustomerId: customerId,
          providerSubscriptionId: subscriptionId,
          sourceEventId: event.id,
          sourceObjectId: invoice.id,
          occurredAt: timestamp,
          payload: {
            value: amountFromMinorUnits(invoice.amount_paid),
            currency: normalizedCurrency(invoice.currency),
            subscription_status: profile.subscription_status,
            interval: profile.subscription_interval,
            invoice_id: invoice.id,
          },
        })
      break
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as unknown as Stripe.Invoice
      await handleInvoicePaymentFailed(invoice)
      const customerId = stripeId(invoice.customer)
      if (!customerId) break
      const profile = await findProfileByStripeCustomerId(supabase, customerId)
      if (!profile?.id) break
      if (recordBillingAnalytics)
        await recordStripeBillingAnalytics(supabase, defer, {
          eventKey: billingAnalyticsEventKey({
            provider: "stripe",
            eventName: "payment_failed",
            sourceObjectId: invoice.id,
          }),
          eventName: "payment_failed",
          userId: profile.id,
          providerCustomerId: customerId,
          providerSubscriptionId: invoiceSubscriptionId(invoice) ?? profile.stripe_subscription_id,
          sourceEventId: event.id,
          sourceObjectId: invoice.id,
          occurredAt: timestamp,
          payload: {
            amount_due: amountFromMinorUnits(invoice.amount_due),
            currency: normalizedCurrency(invoice.currency),
            attempt_count: invoice.attempt_count,
            subscription_status: profile.subscription_status,
            interval: profile.subscription_interval,
          },
        })
      if (!recordBillingAnalytics)
        scheduleCustomerIoLifecycle(defer, `payment failed ${invoice.id}`, async () => {
          const sync = buildCustomerIoInvoicePaymentFailedSync({
            email: profile.email,
            invoice,
            stripeEventId: event.id,
            timestamp,
            userId: profile.id,
          })
          await dispatchCustomerIoLifecycle({
            userId: sync.userId,
            identifyTraits: sync.identifyTraits,
            identifyMessageId: sync.identifyMessageId,
            events: [sync.event],
          })
        })
      break
    }
    case "charge.refunded": {
      const charge = event.data.object as unknown as Stripe.Charge
      const customerId = stripeChargeCustomerId(charge)
      if (!customerId) {
        console.warn("[stripe] charge.refunded missing customer", { chargeId: charge.id })
        break
      }
      const profile = await findProfileByStripeCustomerId(supabase, customerId)
      if (!profile?.id) {
        console.warn("[stripe] charge.refunded has no linked profile", {
          chargeId: charge.id,
          customerId,
        })
        break
      }
      if (recordBillingAnalytics)
        await recordStripeBillingAnalytics(supabase, defer, {
          eventKey: billingAnalyticsEventKey({
            provider: "stripe",
            eventName: "refund_completed",
            sourceObjectId: charge.id,
          }),
          eventName: "refund_completed",
          userId: profile.id,
          providerCustomerId: customerId,
          providerSubscriptionId: profile.stripe_subscription_id,
          sourceEventId: event.id,
          sourceObjectId: charge.id,
          occurredAt: timestamp,
          payload: {
            value: amountFromMinorUnits(charge.amount_refunded),
            currency: normalizedCurrency(charge.currency),
            subscription_status: profile.subscription_status,
            interval: profile.subscription_interval,
          },
        })
      break
    }
    default:
      console.warn("[stripe] unhandled event type:", event.type)
  }
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  const sig = req.headers.get("stripe-signature")
  const body = await req.text()
  if (!sig) return new NextResponse("missing signature", { status: 400 })

  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) return new NextResponse("server misconfigured", { status: 500 })

  const stripe = getStripe()
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret)
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown"
    return new NextResponse(`signature verification failed: ${message}`, { status: 400 })
  }

  const supabase: SupabaseClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  const claimed = await claimWebhookEvent(supabase, "stripe", event.id, event.type)
  if (!claimed) {
    console.info("[stripe:webhook] duplicate skipped", {
      eventId: event.id,
      type: event.type,
      durationMs: Date.now() - startedAt,
    })
    return NextResponse.json({ received: true, duplicate: true })
  }

  try {
    await handleStripeWebhookEvent(event, { supabase, stripe, recordBillingAnalytics: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown"
    await releaseWebhookEventClaim(supabase, "stripe", event.id)
    console.error("[stripe] handler error:", err)
    return new NextResponse(`handler error: ${message}`, { status: 500 })
  }

  console.info("[stripe:webhook] handled", {
    eventId: event.id,
    type: event.type,
    durationMs: Date.now() - startedAt,
  })

  return NextResponse.json({ received: true })
}
