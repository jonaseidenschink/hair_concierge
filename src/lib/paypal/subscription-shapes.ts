import type {
  BillingEntitlementStatus,
  BillingInterval,
  BillingSubscriptionInput,
} from "../billing/types"
import { EXPECTED_PAYPAL_PLAN_SHAPES, type ExpectedPayPalPlanShape } from "./plans"

export type PayPalSubscription = {
  id?: string
  status?: string
  plan_id?: string
  custom_id?: string
  subscriber?: {
    payer_id?: string
    email_address?: string
  }
  billing_info?: {
    next_billing_time?: string
  }
  links?: Array<{ href?: string; rel?: string; method?: string }>
}

export type PayPalPlan = {
  id?: string
  product_id?: string
  status?: string
  payment_preferences?: {
    setup_fee?: {
      value?: string
      currency_code?: string
    }
  }
  taxes?: {
    percentage?: string
    inclusive?: boolean
  }
  billing_cycles?: Array<{
    tenure_type?: string
    total_cycles?: number
    frequency?: {
      interval_unit?: string
      interval_count?: number
    }
    pricing_scheme?: {
      fixed_price?: {
        value?: string
        currency_code?: string
      }
    }
  }>
}

export class PayPalPlanPairValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "PayPalPlanPairValidationError"
  }
}

export function mapPayPalSubscriptionStatus(status: string): BillingEntitlementStatus {
  if (status === "ACTIVE") return "active"
  if (status === "APPROVAL_PENDING" || status === "APPROVED") return "incomplete"
  if (status === "SUSPENDED") return "past_due"
  if (status === "CANCELLED" || status === "EXPIRED") return "canceled"
  return "incomplete"
}

export function derivePayPalPaidThroughDate(subscription: PayPalSubscription): string | null {
  return subscription.billing_info?.next_billing_time ?? null
}

export function toBillingSubscriptionInputFromPayPal(
  subscription: PayPalSubscription,
  userId: string,
  interval: BillingInterval,
): BillingSubscriptionInput {
  if (!subscription.id) throw new Error("PayPal subscription is missing id")
  const entitlementStatus = mapPayPalSubscriptionStatus(subscription.status ?? "")
  const paidThrough = derivePayPalPaidThroughDate(subscription)
  const isProviderCancellation =
    subscription.status === "CANCELLED" || subscription.status === "EXPIRED"
  const providerSubscriberEmail =
    subscription.subscriber?.email_address?.trim().toLowerCase() || undefined

  return {
    user_id: userId,
    provider: "paypal",
    provider_customer_id: subscription.subscriber?.payer_id ?? null,
    provider_subscriber_email: providerSubscriberEmail,
    provider_subscription_id: subscription.id,
    provider_status: subscription.status ?? "UNKNOWN",
    entitlement_status: entitlementStatus,
    interval,
    current_period_end: paidThrough,
    cancel_at_period_end: isProviderCancellation && Boolean(paidThrough),
    cancelled_at: isProviderCancellation ? new Date().toISOString() : null,
    metadata: {
      plan_id: subscription.plan_id ?? null,
    },
  }
}

export function validatePayPalPlanShape(plan: PayPalPlan, interval: BillingInterval): void {
  const expected = EXPECTED_PAYPAL_PLAN_SHAPES[interval]
  if (plan.status !== "ACTIVE") {
    throw new Error(
      `PayPal plan ${plan.id ?? "<unknown>"} expected ACTIVE status but received ${plan.status ?? "<missing>"}`,
    )
  }

  const regularCycle = findRegularBillingCycle(plan)
  if (!regularCycle)
    throw new Error(`PayPal plan ${plan.id ?? "<unknown>"} is missing a regular billing cycle`)

  validatePrice(plan, regularCycle, expected)
  validateInterval(plan, regularCycle, expected)
  validateOngoingPlan(plan, regularCycle)
  validateNoSetupFee(plan)
  validateNoTaxes(plan)
}

export function validatePayPalPlanPair(input: {
  currentPlan: PayPalPlan
  targetPlan: PayPalPlan
  currentInterval: BillingInterval
  targetInterval: BillingInterval
  expectedProductId?: string | null
}) {
  try {
    validatePayPalPlanShape(input.currentPlan, input.currentInterval)
    validatePayPalPlanShape(input.targetPlan, input.targetInterval)
  } catch (error) {
    throw new PayPalPlanPairValidationError(
      "paypal_plan_shape_mismatch",
      error instanceof Error ? error.message : String(error),
    )
  }
  const currentProduct = input.currentPlan.product_id
  const targetProduct = input.targetPlan.product_id
  if (!currentProduct || currentProduct !== targetProduct) {
    throw new PayPalPlanPairValidationError(
      "paypal_product_mismatch",
      "Current and target PayPal plans are not part of the same product",
    )
  }
  if (input.expectedProductId && currentProduct !== input.expectedProductId) {
    throw new PayPalPlanPairValidationError(
      "paypal_product_unexpected",
      "PayPal plan does not belong to the configured subscription product",
    )
  }
}

function findRegularBillingCycle(
  plan: PayPalPlan,
): NonNullable<PayPalPlan["billing_cycles"]>[number] | null {
  return (
    plan.billing_cycles?.find(
      (cycle) => cycle.tenure_type === "REGULAR" && cycle.pricing_scheme?.fixed_price,
    ) ?? null
  )
}

function validatePrice(
  plan: PayPalPlan,
  cycle: NonNullable<PayPalPlan["billing_cycles"]>[number],
  expected: ExpectedPayPalPlanShape,
) {
  const price = cycle.pricing_scheme?.fixed_price
  const amount = price?.value
  const currency = price?.currency_code

  if (amount !== expected.amount) {
    throw new Error(
      `PayPal plan ${plan.id ?? "<unknown>"} expected amount ${expected.amount} but received ${amount ?? "<missing>"}`,
    )
  }
  if (currency !== expected.currency) {
    throw new Error(
      `PayPal plan ${plan.id ?? "<unknown>"} expected currency ${expected.currency} but received ${currency ?? "<missing>"}`,
    )
  }
}

function validateInterval(
  plan: PayPalPlan,
  cycle: NonNullable<PayPalPlan["billing_cycles"]>[number],
  expected: ExpectedPayPalPlanShape,
) {
  const unit = cycle.frequency?.interval_unit
  const count = cycle.frequency?.interval_count

  if (unit !== expected.intervalUnit || count !== expected.intervalCount) {
    throw new Error(
      `PayPal plan ${plan.id ?? "<unknown>"} expected interval ${expected.intervalUnit} x${expected.intervalCount} but received ${unit ?? "<missing>"} x${count ?? "<missing>"}`,
    )
  }
}

function validateOngoingPlan(
  plan: PayPalPlan,
  cycle: NonNullable<PayPalPlan["billing_cycles"]>[number],
) {
  if (cycle.total_cycles !== 0) {
    throw new Error(
      `PayPal plan ${plan.id ?? "<unknown>"} expected infinite regular billing cycles but received ${cycle.total_cycles ?? "<missing>"}`,
    )
  }
}

function validateNoSetupFee(plan: PayPalPlan) {
  const setupFee = plan.payment_preferences?.setup_fee
  if (!setupFee) return

  const amount = decimalNumber(setupFee.value)
  if (amount !== 0) {
    throw new Error(
      `PayPal plan ${plan.id ?? "<unknown>"} expected no setup fee but received ${setupFee.value ?? "<missing>"}`,
    )
  }
}

function validateNoTaxes(plan: PayPalPlan) {
  if (!plan.taxes) return

  const percentage = decimalNumber(plan.taxes.percentage)
  if (percentage !== 0) {
    throw new Error(
      `PayPal plan ${plan.id ?? "<unknown>"} expected no PayPal plan taxes but received ${plan.taxes.percentage ?? "<missing>"}`,
    )
  }
}

function decimalNumber(value: string | undefined): number {
  if (typeof value !== "string" || value.trim() === "") return Number.NaN
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}
