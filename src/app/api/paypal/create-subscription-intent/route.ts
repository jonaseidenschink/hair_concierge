import { NextResponse } from "next/server"
import { z } from "zod"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { assertCanStartCheckout, assertCanStartCheckoutForEmail } from "@/lib/billing/subscriptions"
import { captureCheckoutException } from "@/lib/observability/checkout"
import {
  createOrAdoptPayPalReactivationCheckoutIntent,
  createPayPalCheckoutIntent,
  findPayPalCheckoutIntentByReactivationReservationId,
  type PayPalCheckoutSource,
} from "@/lib/paypal/checkout-intents"
import type { BillingInterval } from "@/lib/billing/types"
import { getPayPalPlanId, resolvePayPalPlanId } from "@/lib/paypal/plans"
import { getStripePricingPlan } from "@/lib/stripe/pricing-plans"
import { isPersonalPlanLaunchPricingEnabled } from "@/lib/funnel/flags"
import {
  parseSubscriptionPricingCatalog,
  resolveSubscriptionPricingCatalog,
  STANDARD_PRICING_CATALOG,
  type SubscriptionPricingCatalog,
} from "@/lib/billing/pricing-catalog"
import { cookies } from "next/headers"
import { FUNNEL_SESSION_COOKIE, FUNNEL_TOUCH_COOKIE } from "@/lib/funnel/cookie"
import {
  recordFunnelEvent,
  resolveFunnelCookieContext,
  resolveFunnelContextForLead,
  resolvePendingFunnelTouchValue,
} from "@/lib/funnel/server"
import {
  acquireMembershipReactivationCheckout,
  bindMembershipReactivationProviderReference,
  claimMembershipReactivationProvider,
  MembershipReactivationCheckoutConflictError,
  type MembershipReactivationCheckoutReservation,
} from "@/lib/reactivation/checkout-reservations"
import { sanitizeReactivationReturnDestination } from "@/lib/reactivation/return-destination"

export const runtime = "nodejs"

export const PayPalSubscriptionIntentRequestSchema = z
  .object({
    interval: z.enum(["month", "quarter", "year"]),
    leadId: z.string().uuid().nullable().optional(),
    source: z.enum(["pricing_page", "quiz_result_offer", "premium_sheet"]),
    funnelEventId: z.string().uuid().optional(),
    checkoutAttemptId: z.string().uuid().optional(),
    checkoutContext: z.literal("membership_reactivation").optional(),
    returnDestination: z.string().max(500).optional(),
  })
  .strict()
  .superRefine(({ source, leadId, checkoutContext, returnDestination }, context) => {
    // Cleanup batch: mirror Stripe's `create-checkout-session` premium_sheet contract
    // (`StripeCheckoutSessionRequestSchema`'s `superRefine`). The Premium sheet sells
    // exactly one thing — a standard-catalog subscription for an already-authenticated
    // free user — and `leadId` (the lead/funnel offer contract) and `checkoutContext` /
    // `returnDestination` (membership reactivation's own protocol) belong to OTHER
    // checkout paths this endpoint speaks. `funnelEventId` and `checkoutAttemptId` stay
    // allowed: both are legitimately used for premium_sheet, same as on the Stripe route.
    if (source === "premium_sheet" && (leadId || checkoutContext || returnDestination)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "invalid Premium-sheet checkout contract",
        path: ["source"],
      })
    }
  })

const ACCESS_CONFLICT_ERROR = "checkout_access_already_exists"

/**
 * Docket rework R1 — the same pin Stripe's `create-checkout-session` applies for
 * `source: "premium_sheet"` (`resolveCheckoutPricingCatalog`).
 *
 * The Premium sheet renders the STANDARD catalog unconditionally
 * (`src/lib/premium-sheet/pricing.ts`, T13 §11 F06), so its PayPal plan must be resolved
 * from the standard catalog too — otherwise a live `PERSONAL_PLAN_LAUNCH_PRICING_ENABLED`
 * would hand a sheet buyer a 69,99/19,99/9,99 PayPal plan under a 99,99/34,99/14,99 row.
 * Every other entry point keeps following the flag exactly as before.
 */
export function resolvePayPalCheckoutPricingCatalog(
  source: PayPalCheckoutSource,
): SubscriptionPricingCatalog {
  if (source === "premium_sheet") return STANDARD_PRICING_CATALOG
  return resolveSubscriptionPricingCatalog(isPersonalPlanLaunchPricingEnabled())
}

export function resolveStoredPayPalCheckoutIntentPlan({
  intentInterval,
  metadata,
  requestedInterval,
}: {
  intentInterval: BillingInterval
  metadata: Record<string, unknown>
  requestedInterval: BillingInterval
}): { planId: string; pricingCatalog: SubscriptionPricingCatalog } {
  const planId = typeof metadata.paypal_plan_id === "string" ? metadata.paypal_plan_id.trim() : ""
  const pricingCatalog = parseSubscriptionPricingCatalog(metadata.pricing_catalog)
  const resolvedPlan = planId ? resolvePayPalPlanId(planId) : null

  if (
    !pricingCatalog ||
    !resolvedPlan ||
    intentInterval !== requestedInterval ||
    resolvedPlan.interval !== requestedInterval ||
    resolvedPlan.pricingCatalog !== pricingCatalog
  ) {
    throw new Error("stored PayPal checkout intent plan is invalid")
  }

  return { planId, pricingCatalog }
}

export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_PAYPAL_ENABLED !== "true") {
    return NextResponse.json({ error: "paypal disabled" }, { status: 404 })
  }

  const parsed = PayPalSubscriptionIntentRequestSchema.safeParse(
    await request.json().catch(() => null),
  )
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request" }, { status: 400 })
  }

  const {
    interval,
    leadId,
    source,
    funnelEventId,
    checkoutAttemptId,
    checkoutContext,
    returnDestination: rawReturnDestination,
  } = parsed.data
  try {
    const admin = createAdminClient()
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (
      checkoutContext === "membership_reactivation" &&
      (!user?.id || !checkoutAttemptId || leadId)
    ) {
      return NextResponse.json({ error: "authenticated reactivation required" }, { status: 401 })
    }

    let reactivationReservation: MembershipReactivationCheckoutReservation | null = null

    if (user?.id) {
      const conflict = await toConflictResponse(assertCanStartCheckout(admin, user.id), user.email)
      if (conflict) return conflict
    }

    let email = user?.email ?? null
    let resolvedLeadId: string | null = null
    let canExposeConflictEmail = Boolean(user?.email)
    if (leadId) {
      const { data, error } = await admin
        .from("leads")
        .select("email")
        .eq("id", leadId)
        .maybeSingle()
      if (error) throw error
      if (typeof data?.email === "string") {
        email = data.email
        resolvedLeadId = leadId
      }
      canExposeConflictEmail = false
    }

    if (email) {
      const conflict = await toConflictResponse(
        assertCanStartCheckoutForEmail(admin, email),
        canExposeConflictEmail ? email : null,
      )
      if (conflict) return conflict
    }

    const leadFunnelContext = resolvedLeadId
      ? await resolveFunnelContextForLead(resolvedLeadId)
      : null
    if (checkoutContext === "membership_reactivation" && user?.id && checkoutAttemptId) {
      try {
        reactivationReservation = await acquireMembershipReactivationCheckout(admin, {
          userId: user.id,
          checkoutAttemptId,
          interval: interval as BillingInterval,
          returnDestination: sanitizeReactivationReturnDestination(rawReturnDestination),
        })
        reactivationReservation = await claimMembershipReactivationProvider(
          admin,
          reactivationReservation.id,
          user.id,
          "paypal",
        )
      } catch (error) {
        if (error instanceof MembershipReactivationCheckoutConflictError) {
          return NextResponse.json({ error: "reactivation_checkout_in_progress" }, { status: 409 })
        }
        throw error
      }

      const existingIntent = await findPayPalCheckoutIntentByReactivationReservationId(
        admin,
        reactivationReservation.id,
      )
      if (existingIntent && !["expired", "duplicate"].includes(existingIntent.status)) {
        await bindMembershipReactivationProviderReference(
          admin,
          reactivationReservation.id,
          existingIntent.id,
        )
        try {
          const storedPlan = resolveStoredPayPalCheckoutIntentPlan({
            intentInterval: existingIntent.interval,
            metadata: existingIntent.metadata,
            requestedInterval: interval,
          })
          return NextResponse.json({ token: existingIntent.token, planId: storedPlan.planId })
        } catch (error) {
          captureCheckoutException(error, {
            provider: "paypal",
            stage: "paypal_create_subscription_intent",
            source,
            interval,
            leadId,
            status: 500,
            reason: "stored_intent_plan_invalid",
          })
          return NextResponse.json({ error: "paypal checkout intent invalid" }, { status: 500 })
        }
      }
    }

    const pricingCatalog = resolvePayPalCheckoutPricingCatalog(source)
    const analyticsPlan = getStripePricingPlan(interval, pricingCatalog)
    let planId: string
    try {
      planId = getPayPalPlanId(interval, pricingCatalog)
      const resolvedPlan = resolvePayPalPlanId(planId)
      if (resolvedPlan?.interval !== interval || resolvedPlan.pricingCatalog !== pricingCatalog) {
        throw new Error("PayPal plan is not recognized by the selected catalog")
      }
    } catch {
      captureCheckoutException(new Error("PayPal plan not configured"), {
        provider: "paypal",
        stage: "paypal_create_subscription_intent",
        source,
        interval,
        leadId,
        status: 500,
        reason: "plan_not_configured",
      })
      return NextResponse.json({ error: "paypal plan not configured" }, { status: 500 })
    }

    const cookieStore = await cookies()
    const funnelContext =
      (await resolveFunnelCookieContext(cookieStore.get(FUNNEL_SESSION_COOKIE)?.value)) ??
      leadFunnelContext
    const funnelTouch = funnelContext
      ? await resolvePendingFunnelTouchValue(
          cookieStore.get(FUNNEL_TOUCH_COOKIE)?.value,
          funnelContext,
        )
      : null
    const intentInput = {
      interval: interval as BillingInterval,
      source: source as PayPalCheckoutSource,
      leadId: resolvedLeadId,
      email,
      userId: user?.id ?? null,
      metadata: {
        paypal_plan_id: planId,
        pricing_catalog: pricingCatalog,
        ...(funnelContext
          ? {
              funnel_session_id: funnelContext.sessionId,
              funnel_package_key: funnelContext.packageKey,
              ...("isInternalTest" in funnelContext &&
              typeof funnelContext.isInternalTest === "boolean"
                ? { is_internal_test: funnelContext.isInternalTest }
                : {}),
            }
          : {}),
        ...(checkoutContext ? { checkout_context: checkoutContext } : {}),
        ...(reactivationReservation
          ? {
              return_destination: reactivationReservation.return_destination,
              reactivation_reservation_id: reactivationReservation.id,
            }
          : {}),
      },
    }
    const intent = reactivationReservation
      ? await createOrAdoptPayPalReactivationCheckoutIntent(admin, {
          ...intentInput,
          reactivationReservationId: reactivationReservation.id,
        })
      : await createPayPalCheckoutIntent(admin, intentInput)
    if (reactivationReservation) {
      if (["expired", "duplicate"].includes(intent.status)) {
        return NextResponse.json({ error: "reactivation_checkout_in_progress" }, { status: 409 })
      }
      await bindMembershipReactivationProviderReference(
        admin,
        reactivationReservation.id,
        intent.id,
      )
    }

    const funnelRecorded = funnelContext
      ? await recordFunnelEvent({
          context: funnelContext,
          eventId: funnelEventId ?? crypto.randomUUID(),
          milestone: "checkout_started",
          leadId: resolvedLeadId,
          userId: user?.id,
          checkoutProvider: "paypal",
          checkoutReference: intent.token,
          touch: funnelTouch,
          properties: {
            source,
            interval,
            ...(checkoutAttemptId ? { checkout_attempt_id: checkoutAttemptId } : {}),
            ...(checkoutContext ? { checkout_context: checkoutContext } : {}),
            currency: analyticsPlan.currency,
            plan_id: analyticsPlan.analyticsId,
            pricing_catalog: pricingCatalog,
            value: analyticsPlan.amount,
          },
        })
          .then(() => true)
          .catch((error) => {
            console.warn("[funnel] PayPal checkout tracking failed", error)
            return false
          })
      : false

    const response = NextResponse.json({ token: intent.token, planId })
    if (funnelTouch && funnelRecorded) {
      response.cookies.set(FUNNEL_TOUCH_COOKIE, "", { path: "/", maxAge: 0 })
    }
    return response
  } catch (error) {
    captureCheckoutException(error, {
      provider: "paypal",
      stage: "paypal_create_subscription_intent",
      source,
      interval,
      leadId,
    })
    throw error
  }
}

async function toConflictResponse(
  promise: Promise<void>,
  email?: string | null,
): Promise<NextResponse<{ error: typeof ACCESS_CONFLICT_ERROR; email?: string }> | null> {
  try {
    await promise
    return null
  } catch (error) {
    if (error instanceof Error && error.message.includes("already has access")) {
      return NextResponse.json(
        { error: ACCESS_CONFLICT_ERROR, ...(email ? { email } : {}) },
        { status: 409 },
      )
    }
    throw error
  }
}
