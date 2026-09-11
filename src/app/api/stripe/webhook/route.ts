import { after, NextResponse, type NextRequest } from "next/server"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { getStripe } from "@/lib/stripe/client"
import {
  CheckoutActivationError,
  type CheckoutAccountResult,
} from "@/lib/stripe/checkout-activation"
import {
  handleCheckoutSessionCompleted,
  handleOneTimeCheckoutSessionCompleted,
  handleOneTimeChargeDisputeCreated,
  handleOneTimeChargeRefunded,
  handleCheckoutSessionExpired,
  handleCheckoutSessionAsyncPaymentSucceeded,
  handleCheckoutSessionAsyncPaymentFailed,
  handleChargeDisputeCreated,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaymentFailed,
  findProfileByStripeCustomerId,
  freemiumCheckoutProvisioningUserId,
  runFreemiumCheckoutProvisioning,
  type StripeWebhookProvisioningDeps,
} from "@/lib/stripe/webhook-handlers"
import { PERSONAL_PLAN_ONCE_KIND } from "@/lib/billing/offer-products"
import { getStripeTierIds } from "@/lib/stripe/tier-ids"
import { linkQuizToProfile as defaultLinkQuizToProfile } from "@/lib/quiz/link-to-profile"
import type Stripe from "stripe"
import {
  billingAnalyticsEventKey,
  amountFromMinorUnits,
  normalizedCurrency,
} from "@/lib/billing/analytics-events"
import {
  parseSubscriptionPricingCatalog,
  STANDARD_PRICING_CATALOG,
} from "@/lib/billing/pricing-catalog"
import { getStripePricingPlan } from "@/lib/stripe/pricing-plans"
import {
  BILLING_ANALYTICS_EXTERNAL_DESTINATIONS,
  recordBillingAnalyticsEvent,
  type BillingAnalyticsEventInput,
} from "@/lib/billing/analytics-outbox"
import type { BillingAnalyticsDestination, BillingInterval } from "@/lib/billing/types"
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
import { isBillingFunnelDeliveryEnabled, isFunnelAttributionEnabled } from "@/lib/funnel/flags"
import { captureCheckoutException } from "@/lib/observability/checkout"
import type { PaymentFailureReporter } from "@/lib/observability/payment"
import { captureServerPaymentFailure } from "@/lib/observability/payment-server"
import { resolvePaymentRuntime } from "@/lib/billing/payment-runtime-config"

export const runtime = "nodejs" // raw body required; edge runtime buffers differently
/**
 * The function lifetime, which `after()` work runs inside too. T14 runs the freemium
 * Stage-2→4 provisioning chain here, and every other route that runs that chain —
 * `accept-ideal-plan`, the stage-2/3 routes, `freemium/purchase/complete` — already asks for
 * 60s. Since the Codex fix wave (Y1) that chain is awaited inside the response rather than
 * deferred, bounded by `FREEMIUM_WEBHOOK_PROVISIONING_BUDGET_MS`, so a slow chain gives up
 * and fails the delivery (claim released, 500, Stripe redelivers) instead of being killed
 * mid-flight with the event still claimed.
 */
export const maxDuration = 60

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

function stripeObjectIsInternalTest(object: unknown): boolean {
  if (!object || typeof object !== "object") return false
  const candidate = object as {
    metadata?: Record<string, string> | null
    parent?: { subscription_details?: { metadata?: Record<string, string> | null } | null } | null
  }
  return (
    candidate.metadata?.is_internal_test === "true" ||
    candidate.parent?.subscription_details?.metadata?.is_internal_test === "true"
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
  destinations?: BillingAnalyticsDestination[],
) {
  await recordBillingAnalyticsEvent(
    supabase,
    { ...input, provider: "stripe" },
    { defer, destinations },
  )
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
  if (interval !== "month" && interval !== "quarter" && interval !== "year") return
  const value = amountFromMinorUnits(session.amount_total)
  const currency = normalizedCurrency(session.currency)
  const purchasePricing = resolveStripeCheckoutPurchasePricing(session, interval)
  const { planId, pricingCatalog, providerPriceId } = purchasePricing
  const funnelSessionId = session.metadata?.funnel_session_id
  const funnelPackageKey = session.metadata?.funnel_package_key
  const purchaseEventKey = billingAnalyticsEventKey({
    provider: "stripe",
    eventName: "purchase_completed",
    sourceObjectId: session.id,
  })
  const purchaseDestinations = [...BILLING_ANALYTICS_EXTERNAL_DESTINATIONS]
  if (
    isFunnelAttributionEnabled() &&
    isBillingFunnelDeliveryEnabled() &&
    funnelSessionId &&
    funnelPackageKey
  ) {
    purchaseDestinations.push("funnel")
  }

  await recordStripeBillingAnalytics(
    supabase,
    defer,
    {
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
        checkout_reference: session.id,
        meta_event_id: session.id,
        value,
        currency,
        interval,
        plan_id: planId,
        pricing_catalog: pricingCatalog,
        stripe_price_id: providerPriceId,
        subscription_status: activation.subscriptionStatus,
        funnel_session_id: funnelSessionId,
        funnel_package_key: funnelPackageKey,
      },
    },
    purchaseDestinations,
  )

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
      pricing_catalog: pricingCatalog,
      stripe_price_id: providerPriceId,
      subscription_status: activation.subscriptionStatus,
    },
  })
}

export function resolveStripeCheckoutPurchasePricing(
  session: Pick<Stripe.Checkout.Session, "metadata">,
  interval: BillingInterval,
) {
  const pricingCatalog =
    parseSubscriptionPricingCatalog(
      session.metadata?.pricing_catalog ?? session.metadata?.checkout_preparation_pricing_catalog,
    ) ?? STANDARD_PRICING_CATALOG
  return {
    planId: getStripePricingPlan(interval, pricingCatalog).analyticsId,
    pricingCatalog,
    providerPriceId:
      session.metadata?.stripe_price_id ?? session.metadata?.checkout_preparation_price_id,
  }
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

type StripeWebhookEventDeps = StripeWebhookProvisioningDeps & {
  supabase: SupabaseClient
  stripe: Stripe
  defer?: (work: () => void | Promise<void>) => void
  getFreeTierId?: (supabase: SupabaseClient) => Promise<string>
  getPremiumTierId?: (supabase: SupabaseClient) => Promise<string>
  linkQuizToProfile?: typeof defaultLinkQuizToProfile
  recordBillingAnalytics?: boolean
  captureCheckoutException?: typeof captureCheckoutException
  capturePaymentFailure?: PaymentFailureReporter
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
    captureCheckoutException: captureCheckout = captureCheckoutException,
    capturePaymentFailure: capturePayment = captureServerPaymentFailure,
  } = deps
  const timestamp = stripeEventTimestamp(event)

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as unknown as Stripe.Checkout.Session
      if (
        session.metadata?.product_kind === PERSONAL_PLAN_ONCE_KIND &&
        session.mode === "payment"
      ) {
        await handleOneTimeCheckoutSessionCompleted(session, {
          supabase,
          stripe,
          premiumTierId: "",
          linkQuizToProfile,
          profileLinkMode: "defer",
          defer,
        })
        break
      }
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
        if (
          err instanceof CheckoutActivationError &&
          err.code === "checkout_preparation_unclaimed"
        ) {
          captureCheckout(err, {
            provider: "stripe",
            stage: "stripe_webhook_activation",
            stripeSessionId: session.id,
            stripeCustomerId: stripeId(session.customer),
            stripeSubscriptionId: stripeId(session.subscription),
            status: session.payment_status,
            reason: "checkout_preparation_unclaimed",
          })
          console.error("[stripe] checkout.session.completed not activated", {
            checkoutSessionId: session.id,
            paymentStatus: session.payment_status,
            reason: "checkout_preparation_unclaimed",
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
      // T14: the Premium sheet's own post-purchase provisioning, beside — never instead of
      // — the activation above. AWAITED, and last in this case, since it is the only step
      // here whose failure has to reach Stripe: it throws when the delivery must be retried
      // (Codex fix wave, Y1), and the POST catch below releases the event claim and answers
      // 500 so the redelivery is processable. Running it deferred, as it used to, put the
      // failure after the response — unreportable and unclaimable, i.e. a buyer who closed
      // the tab stayed paid-but-unprovisioned forever. Everything above has already run and
      // is dedupe-guarded, so a retried delivery repeats it harmlessly.
      if (freemiumCheckoutProvisioningUserId(session, deps)) {
        await runFreemiumCheckoutProvisioning(session, deps, activation)
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
        // The pending → complete path: an asynchronous payment that settled after the buyer
        // left the sheet. This is the lane where nobody is watching, so its durability is
        // the whole point — same awaited, retry-throwing contract as above.
        if (freemiumCheckoutProvisioningUserId(session, deps)) {
          await runFreemiumCheckoutProvisioning(session, deps, activation)
        }
      }
      break
    }
    case "checkout.session.async_payment_failed": {
      const session = event.data.object as unknown as Stripe.Checkout.Session
      capturePayment({
        signal: "provider_payment_failed",
        provider: "stripe",
        boundary: "webhook",
        errorFamily: "declined",
        commerceKind: session.mode === "payment" ? "one_time" : "subscription",
        origin: "webhook",
        method: "unknown",
        truth: "failed",
        live: paymentRuntime().stripeLive,
        isInternalTest: stripeObjectIsInternalTest(session),
        providerReferencePresent: Boolean(session.id),
      })
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
    case "payment_intent.payment_failed": {
      const paymentIntent = event.data.object as unknown as Stripe.PaymentIntent
      // Subscription failures are owned by invoice.payment_failed. Restrict this
      // lane to metadata-authenticated one-time payments to avoid double alerts.
      if (paymentIntent.metadata?.product_kind !== PERSONAL_PLAN_ONCE_KIND) break
      capturePayment({
        signal: "provider_payment_failed",
        provider: "stripe",
        boundary: "provider_outcome",
        errorFamily: "declined",
        commerceKind: "one_time",
        origin: "webhook",
        method: "unknown",
        truth: "failed",
        live: paymentRuntime().stripeLive,
        isInternalTest: stripeObjectIsInternalTest(paymentIntent),
        providerReferencePresent: Boolean(paymentIntent.id),
      })
      break
    }
    case "charge.dispute.created": {
      const dispute = event.data.object as unknown as Stripe.Dispute
      if (await handleOneTimeChargeDisputeCreated(dispute, { supabase, stripe })) break
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
        defer,
      })
      if (!result.matchedCurrentSubscription) break
      const customerId = stripeId(subscription.customer)
      const eventName =
        subscription.cancel_at_period_end ||
        subscription.cancel_at != null ||
        subscription.status === "canceled"
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
            cancel_at_period_end: Boolean(
              subscription.cancel_at_period_end || subscription.cancel_at != null,
            ),
            cancel_scheduled_at:
              typeof subscription.cancel_at === "number"
                ? new Date(subscription.cancel_at * 1000).toISOString()
                : subscription.cancel_at_period_end
                  ? subscription.items.data[0]?.current_period_end
                    ? new Date(subscription.items.data[0].current_period_end * 1000).toISOString()
                    : null
                  : null,
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
      capturePayment({
        signal: "provider_payment_failed",
        provider: "stripe",
        boundary: "webhook",
        errorFamily: "declined",
        commerceKind: "subscription",
        origin: "webhook",
        method: "unknown",
        truth: "failed",
        live: paymentRuntime().stripeLive,
        isInternalTest: stripeObjectIsInternalTest(invoice),
        providerReferencePresent: Boolean(invoice.id),
      })
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
      const oneTimeRefund = await handleOneTimeChargeRefunded(charge, { supabase })
      if (oneTimeRefund) {
        if (recordBillingAnalytics && oneTimeRefund.purchase.user_id)
          await recordStripeBillingAnalytics(supabase, defer, {
            eventKey: billingAnalyticsEventKey({
              provider: "stripe",
              eventName: "refund_completed",
              sourceObjectId: `${charge.id}:${event.id}`,
            }),
            eventName: "refund_completed",
            userId: oneTimeRefund.purchase.user_id,
            providerCustomerId: oneTimeRefund.purchase.provider_customer_id,
            providerSubscriptionId: null,
            sourceEventId: event.id,
            sourceObjectId: charge.id,
            occurredAt: timestamp,
            payload: {
              value: amountFromMinorUnits(oneTimeRefund.refundedDeltaMinor),
              currency: normalizedCurrency(charge.currency),
              interval: "one_time",
              plan_id: oneTimeRefund.purchase.product_kind,
              has_paid_access: oneTimeRefund.purchase.status === "paid",
            },
          })
        break
      }
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
    captureServerPaymentFailure({
      signal: "payment_webhook_processing_failed",
      provider: "stripe",
      boundary: "webhook",
      errorFamily: "webhook_processing",
      commerceKind: stripeWebhookCommerceKind(event),
      origin: "webhook",
      method: "unknown",
      truth: "unknown",
      live: paymentRuntime().stripeLive,
      isInternalTest: false,
      providerReferencePresent: Boolean(event.id),
    })
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

function stripeWebhookCommerceKind(event: Stripe.Event) {
  if (event.type === "checkout.session.async_payment_failed") {
    const session = event.data.object as Stripe.Checkout.Session
    return session.mode === "payment" ? "one_time" : "subscription"
  }
  if (event.type === "payment_intent.payment_failed") {
    const paymentIntent = event.data.object as Stripe.PaymentIntent
    return paymentIntent.metadata?.product_kind === PERSONAL_PLAN_ONCE_KIND ? "one_time" : "unknown"
  }
  return event.type === "invoice.payment_failed" ? "subscription" : "unknown"
}

function paymentRuntime() {
  return resolvePaymentRuntime({
    VERCEL_ENV: process.env.VERCEL_ENV,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    PAYPAL_ENVIRONMENT: process.env.PAYPAL_ENVIRONMENT,
  })
}
