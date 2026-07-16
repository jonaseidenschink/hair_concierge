import type { BillingInterval } from "@/lib/billing/types"
import { getPayPalPlanId } from "./plans"
import { PayPalRequestError, paypalRequest } from "./client"
import {
  type PayPalSubscription,
  PayPalPlanPairValidationError,
  validatePayPalPlanPair,
  validatePayPalPlanShape,
} from "./subscription-shapes"
import { retrievePayPalPlan, retrievePayPalSubscription } from "./subscriptions"

export class PayPalPlanChangeConflictError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "PayPalPlanChangeConflictError"
  }
}

export class PayPalPlanChangeAmbiguousError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "PayPalPlanChangeAmbiguousError"
  }
}

type PayPalRevisionResponse = PayPalSubscription & {
  links?: Array<{ href?: string; rel?: string; method?: string }>
}

export async function initiatePayPalPlanChange(input: {
  subscriptionId: string
  currentInterval: BillingInterval
  targetInterval: BillingInterval
  operationId: string
  returnUrl: string
  cancelUrl: string
}): Promise<{ approvalUrl: string; targetPlanId: string; effectiveAt: string }> {
  const subscription = await retrievePayPalSubscription(input.subscriptionId)
  if (subscription.status !== "ACTIVE") {
    throw new PayPalPlanChangeConflictError(
      "paypal_status_unmanageable",
      `PayPal subscription status ${subscription.status ?? "UNKNOWN"} is not manageable`,
    )
  }
  if (!subscription.plan_id) {
    throw new PayPalPlanChangeConflictError("paypal_current_plan_missing", "PayPal plan is missing")
  }
  const currentPlan = await retrievePayPalPlan(subscription.plan_id)
  const targetPlanId = getPayPalPlanId(input.targetInterval)
  const targetPlan = await retrievePayPalPlan(targetPlanId)
  try {
    validatePayPalPlanPair({
      currentPlan,
      targetPlan,
      currentInterval: input.currentInterval,
      targetInterval: input.targetInterval,
      expectedProductId: process.env.PAYPAL_PRODUCT_ID?.trim(),
    })
  } catch (error) {
    if (error instanceof PayPalPlanPairValidationError) {
      throw new PayPalPlanChangeConflictError(error.code, error.message)
    }
    throw error
  }

  const effectiveAt = subscription.billing_info?.next_billing_time
  if (!effectiveAt || !Number.isFinite(Date.parse(effectiveAt))) {
    throw new PayPalPlanChangeConflictError(
      "paypal_billing_time_missing",
      "PayPal next billing time is unavailable",
    )
  }

  let revision: PayPalRevisionResponse
  try {
    revision = await paypalRequest<PayPalRevisionResponse>(
      `/v1/billing/subscriptions/${encodeURIComponent(input.subscriptionId)}/revise`,
      {
        method: "POST",
        headers: { "PayPal-Request-Id": `plan-change-${input.operationId}` },
        body: JSON.stringify({
          plan_id: targetPlanId,
          application_context: {
            brand_name: "Chaarlie",
            user_action: "CONTINUE",
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
          },
        }),
      },
    )
  } catch (error) {
    if (isAmbiguousPayPalMutationError(error)) {
      throw new PayPalPlanChangeAmbiguousError(error)
    }
    throw error
  }
  const approvalUrl = revision.links?.find((link) => link.rel === "approve")?.href
  if (!approvalUrl) {
    throw new PayPalPlanChangeAmbiguousError(
      new Error("PayPal accepted the revision without returning an approval URL"),
    )
  }
  return { approvalUrl, targetPlanId, effectiveAt }
}

function isAmbiguousPayPalMutationError(error: unknown) {
  if (!(error instanceof PayPalRequestError)) return false
  return (
    error.status === null || error.status === 408 || error.status === 429 || error.status >= 500
  )
}

export async function verifyApprovedPayPalPlanChange(input: {
  subscriptionId: string
  targetPlanId: string
  targetInterval: BillingInterval
}): Promise<PayPalSubscription> {
  const subscription = await retrievePayPalSubscription(input.subscriptionId)
  if (subscription.plan_id !== input.targetPlanId) {
    throw new PayPalPlanChangeConflictError(
      "paypal_revision_not_applied",
      "PayPal has not confirmed the approved target plan",
    )
  }
  const targetPlan = await retrievePayPalPlan(input.targetPlanId)
  validatePayPalPlanShape(targetPlan, input.targetInterval)
  return subscription
}
