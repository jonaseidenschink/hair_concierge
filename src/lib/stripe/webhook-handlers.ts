import type Stripe from "stripe"
import type { CheckoutAccountResult, CheckoutActivationDeps } from "./checkout-activation"
import {
  ensureCheckoutAccount,
  stripeEntitlementStatus,
  subPeriodEndIso,
} from "./checkout-activation"
import { intervalFromPrice } from "./intervals"
import {
  findBillingSubscriptionByProviderId,
  upsertBillingSubscription,
} from "@/lib/billing/subscriptions"
import { applyPlanChangeAtRenewal } from "@/lib/billing/plan-change"

export type HandlerDeps = CheckoutActivationDeps
type SubscriptionUpdateDeps = Pick<HandlerDeps, "supabase">
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

export async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
  deps: HandlerDeps,
): Promise<CheckoutAccountResult> {
  return ensureCheckoutAccount(session, deps)
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
  items: {
    data: Array<{
      current_period_end?: number
      price: {
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
  if (!profile) return { matchedCurrentSubscription: false }
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

  const billingRow = await upsertBillingSubscription(deps.supabase, {
    user_id: profile.id,
    provider: "stripe",
    provider_customer_id: s.customer,
    provider_subscription_id: s.id,
    provider_status: s.status,
    entitlement_status: entitlementStatus,
    interval,
    current_period_end: subPeriodEndIso(s),
    cancel_at_period_end: s.cancel_at_period_end ?? false,
  })
  await applyPlanChangeAtRenewal(deps.supabase, {
    subscription: billingRow,
    observedInterval: interval,
    occurredAt: new Date().toISOString(),
  })
  return { matchedCurrentSubscription, profileId: profile.id }
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
