import type Stripe from "stripe"
import { getStripePricingPlan } from "./pricing-plans"
import { PRICE_IDS } from "./client"
import { intervalFromPrice, type BillingInterval } from "./intervals"

export class StripePlanChangeConflictError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "StripePlanChangeConflictError"
  }
}

export class StripePlanChangePartialError extends Error {
  constructor(
    readonly scheduleId: string,
    readonly cleanupSucceeded: boolean,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = "StripePlanChangePartialError"
  }
}

export class StripePlanChangeAmbiguousError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "StripePlanChangeAmbiguousError"
  }
}

type StripePlanChangeInput = {
  stripe: Stripe
  subscriptionId: string
  currentInterval: BillingInterval
  targetInterval: BillingInterval
  operationId: string
  configuredTargetPriceId?: string
  expectedProductId?: string
}

type StripePlanChangeResult = {
  scheduleId: string
  targetPriceId: string
  effectiveAt: string
}

export async function scheduleStripePlanChange(
  input: StripePlanChangeInput,
): Promise<StripePlanChangeResult> {
  return ensureStripePlanChangeSchedule(input, null)
}

export async function reconcileStripePlanChange(
  input: StripePlanChangeInput & { scheduleId: string },
): Promise<
  ({ outcome: "scheduled" } & StripePlanChangeResult) | { outcome: "closed"; scheduleId: string }
> {
  try {
    const scheduled = await ensureStripePlanChangeSchedule(input, input.scheduleId)
    return { outcome: "scheduled", ...scheduled }
  } catch (error) {
    if (
      (error instanceof StripePlanChangePartialError && error.cleanupSucceeded) ||
      (error instanceof StripePlanChangeConflictError && error.code === "stripe_schedule_closed")
    ) {
      return { outcome: "closed", scheduleId: input.scheduleId }
    }
    throw error
  }
}

async function ensureStripePlanChangeSchedule(
  input: StripePlanChangeInput,
  reconciliationScheduleId: string | null,
): Promise<StripePlanChangeResult> {
  const { stripe, subscriptionId, currentInterval, targetInterval, operationId } = input
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price.product"],
  })
  if (subscription.status !== "active" && subscription.status !== "trialing") {
    throw new StripePlanChangeConflictError(
      "stripe_status_unmanageable",
      `Stripe subscription status ${subscription.status} is not manageable`,
    )
  }
  if (subscription.cancel_at_period_end) {
    throw new StripePlanChangeConflictError(
      "stripe_cancellation_scheduled",
      "Stripe subscription is scheduled to cancel",
    )
  }
  if (subscription.items.data.length !== 1) {
    throw new StripePlanChangeConflictError(
      "stripe_multi_item_unsupported",
      "Stripe subscriptions with multiple items cannot be changed automatically",
    )
  }
  const discountState = subscription as Stripe.Subscription & {
    discount?: unknown
    discounts?: unknown[]
  }
  if (discountState.discount || (discountState.discounts?.length ?? 0) > 0) {
    throw new StripePlanChangeConflictError(
      "stripe_discount_unsupported",
      "Discounted Stripe subscriptions cannot be changed automatically",
    )
  }

  const item = subscription.items.data[0]
  if (!item)
    throw new StripePlanChangeConflictError("stripe_item_missing", "Subscription item missing")
  const currentPrice = await resolvedPrice(stripe, item.price)
  const targetPriceId = input.configuredTargetPriceId ?? PRICE_IDS[targetInterval]
  if (!targetPriceId) {
    throw new StripePlanChangeConflictError(
      "stripe_target_unconfigured",
      `Stripe price is not configured for ${targetInterval}`,
    )
  }
  const targetPrice = await stripe.prices.retrieve(targetPriceId, { expand: ["product"] })
  validateStripePrice(currentPrice, currentInterval)
  validateStripePrice(targetPrice, targetInterval)

  const currentProductId = objectId(currentPrice.product)
  const targetProductId = objectId(targetPrice.product)
  const expectedProductId = input.expectedProductId ?? process.env.STRIPE_PRODUCT_ID?.trim()
  if (!currentProductId || currentProductId !== targetProductId) {
    throw new StripePlanChangeConflictError(
      "stripe_product_mismatch",
      "Current and target Stripe prices are not part of the same product",
    )
  }
  if (expectedProductId && currentProductId !== expectedProductId) {
    throw new StripePlanChangeConflictError(
      "stripe_product_unexpected",
      "Stripe price does not belong to the configured subscription product",
    )
  }

  const periodStart = item.current_period_start
  const periodEnd = item.current_period_end
  if (!periodStart || !periodEnd || periodEnd <= periodStart) {
    throw new StripePlanChangeConflictError(
      "stripe_period_missing",
      "Stripe subscription period is unavailable",
    )
  }

  const metadata = {
    chaarlie_plan_change_operation_id: operationId,
    chaarlie_plan_change_target_interval: targetInterval,
  }
  const attachedScheduleId = objectId(subscription.schedule)
  if (
    reconciliationScheduleId &&
    attachedScheduleId &&
    attachedScheduleId !== reconciliationScheduleId
  ) {
    throw new StripePlanChangeConflictError(
      "stripe_schedule_conflict",
      "Stripe subscription has a different subscription schedule attached",
    )
  }
  const existingScheduleId = reconciliationScheduleId ?? attachedScheduleId
  let schedule: Stripe.SubscriptionSchedule
  if (existingScheduleId) {
    try {
      schedule = await stripe.subscriptionSchedules.retrieve(existingScheduleId)
    } catch (error) {
      if (reconciliationScheduleId && isMissingStripeResource(error)) {
        throw new StripePlanChangeConflictError(
          "stripe_schedule_closed",
          "Feature-owned Stripe schedule no longer exists",
        )
      }
      if (isAmbiguousStripeMutationError(error)) throw new StripePlanChangeAmbiguousError(error)
      throw error
    }
    if (
      schedule.metadata?.chaarlie_plan_change_operation_id !== operationId ||
      schedule.metadata?.chaarlie_plan_change_target_interval !== targetInterval ||
      (objectId(schedule.subscription) ?? schedule.released_subscription) !== subscription.id
    ) {
      throw new StripePlanChangeConflictError(
        "stripe_schedule_conflict",
        "Stripe subscription already has an unrelated subscription schedule",
      )
    }
    if (["released", "canceled", "completed"].includes(schedule.status)) {
      throw new StripePlanChangeConflictError(
        "stripe_schedule_closed",
        "Feature-owned Stripe schedule is already closed",
      )
    }
  } else {
    try {
      schedule = await stripe.subscriptionSchedules.create(
        { from_subscription: subscription.id, metadata },
        { idempotencyKey: `plan-change:${operationId}:create` },
      )
    } catch (error) {
      if (isAmbiguousStripeMutationError(error)) throw new StripePlanChangeAmbiguousError(error)
      throw error
    }
  }

  try {
    const update = {
      end_behavior: "release" as const,
      phases: [
        {
          start_date: periodStart,
          end_date: periodEnd,
          items: [{ price: currentPrice.id, quantity: item.quantity ?? 1 }],
          proration_behavior: "none" as const,
        },
        {
          start_date: periodEnd,
          duration: stripeDuration(targetInterval),
          items: [{ price: targetPrice.id, quantity: item.quantity ?? 1 }],
          proration_behavior: "none" as const,
        },
      ],
      metadata,
    }
    if (reconciliationScheduleId) {
      await stripe.subscriptionSchedules.update(schedule.id, update)
    } else {
      await stripe.subscriptionSchedules.update(schedule.id, update, {
        idempotencyKey: `plan-change:${operationId}:update`,
      })
    }
  } catch (error) {
    let cleanupSucceeded = false
    try {
      if (reconciliationScheduleId) {
        await stripe.subscriptionSchedules.release(schedule.id)
      } else {
        await stripe.subscriptionSchedules.release(schedule.id, undefined, {
          idempotencyKey: `plan-change:${operationId}:cleanup`,
        })
      }
      cleanupSucceeded = true
    } catch {
      // The caller records reconciliation when the feature-owned schedule cannot be released.
    }
    throw new StripePlanChangePartialError(schedule.id, cleanupSucceeded, error)
  }

  return {
    scheduleId: schedule.id,
    targetPriceId: targetPrice.id,
    effectiveAt: new Date(periodEnd * 1000).toISOString(),
  }
}

function isAmbiguousStripeMutationError(error: unknown) {
  if (!error || typeof error !== "object") return true
  const candidate = error as { statusCode?: unknown; type?: unknown }
  if (candidate.type === "StripeConnectionError") return true
  if (typeof candidate.statusCode !== "number") return true
  return (
    candidate.statusCode === 408 ||
    candidate.statusCode === 409 ||
    candidate.statusCode === 429 ||
    candidate.statusCode >= 500
  )
}

function isMissingStripeResource(error: unknown) {
  if (!error || typeof error !== "object") return false
  const candidate = error as { code?: unknown; statusCode?: unknown }
  return candidate.code === "resource_missing" || candidate.statusCode === 404
}

export function validateStripePrice(price: Stripe.Price, interval: BillingInterval) {
  const expected = getStripePricingPlan(interval)
  if (!price.active) {
    throw new StripePlanChangeConflictError("stripe_price_inactive", "Stripe price is inactive")
  }
  if (price.currency.toUpperCase() !== expected.currency) {
    throw new StripePlanChangeConflictError(
      "stripe_currency_mismatch",
      `Stripe price currency must be ${expected.currency}`,
    )
  }
  if (price.unit_amount !== Math.round(expected.amount * 100)) {
    throw new StripePlanChangeConflictError(
      "stripe_amount_mismatch",
      "Stripe price does not match the canonical amount",
    )
  }
  if (!price.recurring || intervalFromPrice(price.recurring) !== interval) {
    throw new StripePlanChangeConflictError(
      "stripe_interval_mismatch",
      "Stripe price does not match the expected interval",
    )
  }
}

async function resolvedPrice(stripe: Stripe, price: Stripe.Price) {
  if (price.currency && price.recurring) return price
  return stripe.prices.retrieve(price.id, { expand: ["product"] })
}

function objectId(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : (value?.id ?? null)
}

function stripeDuration(interval: BillingInterval) {
  if (interval === "month") return { interval: "month" as const, interval_count: 1 }
  if (interval === "quarter") return { interval: "month" as const, interval_count: 3 }
  return { interval: "year" as const, interval_count: 1 }
}
