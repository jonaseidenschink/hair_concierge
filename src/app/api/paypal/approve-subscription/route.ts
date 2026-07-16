import { NextResponse } from "next/server"
import { z } from "zod"
import { createAdminClient } from "@/lib/supabase/admin"
import { findBillingSubscriptionByProviderId } from "@/lib/billing/subscriptions"
import { captureCheckoutException } from "@/lib/observability/checkout"
import {
  bindPayPalCheckoutIntentToSubscription,
  type PayPalCheckoutIntentRow,
  findPayPalCheckoutIntentByToken,
  isPayPalCheckoutIntentExpired,
  PayPalCheckoutIntentBindingError,
} from "@/lib/paypal/checkout-intents"
import {
  cancelPayPalSubscription as defaultCancelPayPalSubscription,
  retrievePayPalSubscription,
  type PayPalSubscription,
} from "@/lib/paypal/subscriptions"
import {
  cancelAndMarkPayPalDuplicate,
  buildPayPalDuplicateCheckoutBody,
  findPayPalCheckoutDuplicateReason,
  PayPalDuplicateCancellationError,
} from "@/lib/paypal/duplicate-guard"

export const runtime = "nodejs"

const BodySchema = z.object({
  token: z.string().min(16),
  subscription_id: z.string().min(1),
})

export async function POST(request: Request) {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request" }, { status: 400 })
  }

  const { token, subscription_id } = parsed.data
  let checkoutSource: PayPalCheckoutIntentRow["source"] | undefined
  try {
    const admin = createAdminClient()
    const intent = await findPayPalCheckoutIntentByToken(admin, token)
    if (!intent || isPayPalCheckoutIntentExpired(intent)) {
      return NextResponse.json({ error: "paypal checkout expired" }, { status: 400 })
    }
    checkoutSource = intent.source

    const subscription = await retrievePayPalSubscription(subscription_id)
    if (!subscription.id) {
      return NextResponse.json({ error: "paypal subscription missing" }, { status: 400 })
    }
    if (subscription.custom_id?.trim() !== token) {
      return NextResponse.json({ error: "paypal token mismatch" }, { status: 400 })
    }
    if (intent.status === "duplicate") {
      try {
        await cancelAndMarkPayPalDuplicate({
          cancelPayPalSubscription: defaultCancelPayPalSubscription,
          reason: intent.duplicate_reason ?? "reactivation_reservation_race",
          retrievePayPalSubscription,
          subscriptionId: subscription.id,
          supabase: admin,
          token,
        })
      } catch (error) {
        if (error instanceof PayPalDuplicateCancellationError) {
          captureCheckoutException(error, {
            provider: "paypal",
            stage: "paypal_approve_subscription",
            source: checkoutSource,
            paypalSubscriptionId: subscription.id,
            paypalTokenPresent: true,
            status: 502,
            reason: "duplicate_cancel_failed",
          })
          return NextResponse.json({ error: "paypal_duplicate_cancel_failed" }, { status: 502 })
        }
        throw error
      }
      return createPayPalDuplicateCheckoutResponse(intent)
    }
    if (intent.provider_subscription_id && intent.provider_subscription_id !== subscription.id) {
      return NextResponse.json({ error: "paypal subscription mismatch" }, { status: 400 })
    }
    const existingBilling = await findBillingSubscriptionByProviderId(
      admin,
      "paypal",
      subscription.id,
    )
    if (existingBilling) {
      await bindPayPalCheckoutIntentToSubscription(
        admin,
        token,
        subscription.id,
        intent.email ?? getPayPalSubscriberEmail(subscription),
      )
      return NextResponse.json({ ok: true, token })
    }

    const email = getPayPalSubscriberEmail(subscription)
    let boundIntent: PayPalCheckoutIntentRow
    if (intent.provider_subscription_id === subscription.id) {
      boundIntent = intent
    } else {
      try {
        boundIntent = await bindPayPalCheckoutIntentToSubscription(
          admin,
          token,
          subscription.id,
          intent.email ?? email,
        )
      } catch (error) {
        if (error instanceof PayPalCheckoutIntentBindingError) {
          return NextResponse.json({ error: "paypal subscription mismatch" }, { status: 409 })
        }
        throw error
      }
    }
    const duplicateReason = await findPayPalCheckoutDuplicateReason(
      admin,
      boundIntent,
      subscription,
    )
    if (duplicateReason) {
      try {
        await cancelAndMarkPayPalDuplicate({
          cancelPayPalSubscription: defaultCancelPayPalSubscription,
          reason: duplicateReason,
          retrievePayPalSubscription,
          subscriptionId: subscription.id,
          supabase: admin,
          token,
        })
      } catch (error) {
        if (error instanceof PayPalDuplicateCancellationError) {
          console.error(
            "[paypal.approve-subscription] failed to cancel duplicate subscription:",
            error.cause,
          )
          captureCheckoutException(error, {
            provider: "paypal",
            stage: "paypal_approve_subscription",
            source: checkoutSource,
            paypalSubscriptionId: subscription.id,
            paypalTokenPresent: true,
            status: 502,
            reason: "duplicate_cancel_failed",
          })
          return NextResponse.json({ error: "paypal_duplicate_cancel_failed" }, { status: 502 })
        }
        throw error
      }
      return createPayPalDuplicateCheckoutResponse(boundIntent)
    }

    return NextResponse.json({ ok: true, token })
  } catch (error) {
    captureCheckoutException(error, {
      provider: "paypal",
      stage: "paypal_approve_subscription",
      source: checkoutSource,
      paypalSubscriptionId: subscription_id,
      paypalTokenPresent: true,
    })
    throw error
  }
}

export function createPayPalDuplicateCheckoutResponse(
  intent: Pick<PayPalCheckoutIntentRow, "email" | "lead_id">,
): NextResponse<ReturnType<typeof buildPayPalDuplicateCheckoutBody>> {
  return NextResponse.json(buildPayPalDuplicateCheckoutBody(intent), { status: 409 })
}

function getPayPalSubscriberEmail(subscription: PayPalSubscription): string | null {
  const email = subscription.subscriber?.email_address
  return typeof email === "string" && email.trim() !== "" ? email.trim() : null
}
