import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { createClient } from "@supabase/supabase-js"
import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { assertCanStartCheckout, assertCanStartCheckoutForEmail } from "@/lib/billing/subscriptions"
import { captureCheckoutException } from "@/lib/observability/checkout"
import { FUNNEL_SESSION_COOKIE, FUNNEL_TOUCH_COOKIE } from "@/lib/funnel/cookie"
import {
  recordFunnelEvent,
  resolveFunnelCookieContext,
  resolveFunnelContextForLead,
  resolvePendingFunnelTouchValue,
} from "@/lib/funnel/server"
import { getStripe, PRICE_IDS } from "@/lib/stripe/client"
import { buildStripeCheckoutSessionParams } from "@/lib/stripe/checkout-session-params"
import type { BillingInterval } from "@/lib/stripe/intervals"
import { getStripePricingPlan } from "@/lib/stripe/pricing-plans"
import {
  acquireMembershipReactivationCheckout,
  bindMembershipReactivationProviderReference,
  claimMembershipReactivationProvider,
  expireMembershipReactivationCheckoutReservation,
  markMembershipReactivationReconciliationRequired,
  MembershipReactivationCheckoutConflictError,
  type MembershipReactivationCheckoutReservation,
} from "@/lib/reactivation/checkout-reservations"
import { sanitizeReactivationReturnDestination } from "@/lib/reactivation/return-destination"

export const runtime = "nodejs"

const BodySchema = z.object({
  interval: z.enum(["month", "quarter", "year"]),
  // Accept null too — the client sends `leadId: null` when there's no ?lead=
  // in the URL (resubscribe path). `.optional()` alone rejects null.
  leadId: z.string().uuid().nullable().optional(),
  source: z.enum(["pricing_page", "quiz_result_offer"]).default("pricing_page"),
  funnelEventId: z.string().uuid().optional(),
  checkoutAttemptId: z.string().uuid().optional(),
  checkoutContext: z.literal("membership_reactivation").optional(),
  returnDestination: z.string().max(500).optional(),
})

export async function POST(req: NextRequest) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null))
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
  const analyticsPlan = getStripePricingPlan(interval)

  const priceId = PRICE_IDS[interval as BillingInterval]
  if (!priceId) {
    captureCheckoutException(new Error("Stripe price not configured"), {
      provider: "stripe",
      stage: "stripe_checkout_session_create",
      source: "pricing_page",
      interval,
      leadId,
      status: 500,
      reason: "price_not_configured",
    })
    return NextResponse.json({ error: "price not configured" }, { status: 500 })
  }

  try {
    // Identity resolution: prefer existing Stripe customer > email > 400
    // Priority: leadId email → authed user's stripe_customer_id → authed user's email → 400
    let customerId: string | undefined
    let customerEmail: string | undefined
    let resolvedLeadId: string | null = null

    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => cookieStore.getAll(),
          setAll: () => {},
        },
      },
    )
    const {
      data: { user },
    } = await supabase.auth.getUser()
    const authenticatedUserId = user?.id
    let adminSupabase: ReturnType<typeof createBillingAdminClient> | null = null
    const getAdminSupabase = () => {
      adminSupabase ??= createBillingAdminClient()
      return adminSupabase
    }
    let reactivationReservation: MembershipReactivationCheckoutReservation | null = null

    if (checkoutContext === "membership_reactivation") {
      if (!authenticatedUserId || !checkoutAttemptId || leadId) {
        return NextResponse.json({ error: "authenticated reactivation required" }, { status: 401 })
      }
    }

    if (authenticatedUserId) {
      const adminSupabase = getAdminSupabase()
      const conflictResponse = await createStripeCheckoutAccessConflictResponse(
        adminSupabase,
        authenticatedUserId,
        user.email,
      )
      if (conflictResponse) return conflictResponse
      if (user?.email) {
        const emailConflictResponse = await createStripeCheckoutEmailAccessConflictResponse(
          adminSupabase,
          user.email,
        )
        if (emailConflictResponse) return emailConflictResponse
      }

      if (checkoutContext === "membership_reactivation" && checkoutAttemptId) {
        const returnDestination = sanitizeReactivationReturnDestination(rawReturnDestination)
        try {
          reactivationReservation = await acquireMembershipReactivationCheckout(adminSupabase, {
            userId: authenticatedUserId,
            checkoutAttemptId,
            interval: interval as BillingInterval,
            returnDestination,
          })
          reactivationReservation = await claimMembershipReactivationProvider(
            adminSupabase,
            reactivationReservation.id,
            authenticatedUserId,
            "stripe",
          )
        } catch (error) {
          if (error instanceof MembershipReactivationCheckoutConflictError) {
            return NextResponse.json(
              { error: "reactivation_checkout_in_progress" },
              { status: 409 },
            )
          }
          throw error
        }
      }
    }

    if (leadId) {
      const adminSupabase = getAdminSupabase()
      const { data, error } = await adminSupabase
        .from("leads")
        .select("email")
        .eq("id", leadId)
        .maybeSingle()
      if (error) {
        console.error("[stripe] lead lookup failed before Checkout creation", {
          leadId,
          error,
        })
        captureCheckoutException(error, {
          provider: "stripe",
          stage: "stripe_checkout_session_create",
          source: "pricing_page",
          interval,
          leadId,
          status: 500,
          reason: "lead_lookup_failed",
        })
        return NextResponse.json({ error: "lead lookup failed" }, { status: 500 })
      }
      customerEmail = data?.email ?? undefined
      if (customerEmail) {
        resolvedLeadId = leadId
        const conflictResponse = await createStripeCheckoutEmailAccessConflictResponse(
          adminSupabase,
          customerEmail,
          { includeEmail: false },
        )
        if (conflictResponse) return conflictResponse
      }
    }

    if (!customerId && !customerEmail) {
      // Resubscribe, direct-entry, or stale lead path — lock to the authenticated user's identity.
      if (user?.id) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("stripe_customer_id")
          .eq("id", user.id)
          .single()

        if (profile?.stripe_customer_id) {
          customerId = profile.stripe_customer_id
        } else {
          customerEmail = user.email
        }
      } else {
        return NextResponse.json({ error: "identity required" }, { status: 400 })
      }
    }

    const origin = req.nextUrl.origin
    const stripe = getStripe()

    if (reactivationReservation?.provider_reference) {
      const providerReference = reactivationReservation.provider_reference
      try {
        const existingSession = await stripe.checkout.sessions.retrieve(providerReference)
        if (existingSession.status === "expired") {
          await expireMembershipReactivationCheckoutReservation(getAdminSupabase(), {
            reservationId: reactivationReservation.id,
            userId: authenticatedUserId!,
            providerReference,
          })
          return NextResponse.json({ error: "reactivation_checkout_terminal" }, { status: 409 })
        }
        if (!existingSession.client_secret) throw new Error("existing session has no client secret")
        return NextResponse.json({ client_secret: existingSession.client_secret })
      } catch (error) {
        if (isDefinitivelyMissingStripeResource(error)) {
          await expireMembershipReactivationCheckoutReservation(getAdminSupabase(), {
            reservationId: reactivationReservation.id,
            userId: authenticatedUserId!,
            providerReference,
          })
          return NextResponse.json({ error: "reactivation_checkout_terminal" }, { status: 409 })
        }
        await markMembershipReactivationReconciliationRequired(
          getAdminSupabase(),
          reactivationReservation.id,
        ).catch(() => {})
        captureCheckoutException(error, {
          provider: "stripe",
          stage: "stripe_checkout_session_create",
          source,
          interval,
          reason: "reactivation_session_reconciliation_required",
        })
        return NextResponse.json({ error: "reactivation_checkout_unavailable" }, { status: 409 })
      }
    }
    const funnelContext =
      (await resolveFunnelCookieContext(cookieStore.get(FUNNEL_SESSION_COOKIE)?.value)) ??
      (await resolveFunnelContextForLead(resolvedLeadId))
    const funnelTouch = funnelContext
      ? await resolvePendingFunnelTouchValue(
          cookieStore.get(FUNNEL_TOUCH_COOKIE)?.value,
          funnelContext,
        )
      : null

    const params = buildStripeCheckoutSessionParams({
      origin,
      priceId,
      customerId,
      customerEmail,
      leadId: resolvedLeadId,
      funnelSessionId: funnelContext?.sessionId,
      funnelPackageKey: funnelContext?.packageKey,
      checkoutContext,
      returnDestination: reactivationReservation?.return_destination,
      reactivationReservationId: reactivationReservation?.id,
    })
    const session = await stripe.checkout.sessions.create(
      params,
      reactivationReservation
        ? { idempotencyKey: `membership-reactivation:${reactivationReservation.id}` }
        : undefined,
    )
    if (reactivationReservation) {
      await bindMembershipReactivationProviderReference(
        getAdminSupabase(),
        reactivationReservation.id,
        session.id,
      )
    }

    const funnelRecorded = funnelContext
      ? await recordFunnelEvent({
          context: funnelContext,
          eventId: funnelEventId ?? crypto.randomUUID(),
          milestone: "checkout_started",
          leadId: resolvedLeadId,
          userId: user?.id,
          checkoutProvider: "stripe",
          checkoutReference: session.id,
          touch: funnelTouch,
          properties: {
            source,
            interval,
            ...(checkoutAttemptId ? { checkout_attempt_id: checkoutAttemptId } : {}),
            ...(checkoutContext ? { checkout_context: checkoutContext } : {}),
            currency: analyticsPlan.currency,
            plan_id: analyticsPlan.analyticsId,
            value: analyticsPlan.amount,
          },
        })
          .then(() => true)
          .catch((error) => {
            console.warn("[funnel] Stripe checkout tracking failed", error)
            return false
          })
      : false

    const response = NextResponse.json({ client_secret: session.client_secret })
    if (funnelTouch && funnelRecorded) {
      response.cookies.set(FUNNEL_TOUCH_COOKIE, "", { path: "/", maxAge: 0 })
    }
    return response
  } catch (error) {
    captureCheckoutException(error, {
      provider: "stripe",
      stage: "stripe_checkout_session_create",
      source: "pricing_page",
      interval,
      leadId,
    })
    throw error
  }
}

function isDefinitivelyMissingStripeResource(error: unknown) {
  if (!error || typeof error !== "object") return false
  const candidate = error as { code?: unknown; statusCode?: unknown }
  return candidate.code === "resource_missing" || candidate.statusCode === 404
}

export async function createStripeCheckoutEmailAccessConflictResponse(
  supabase: Parameters<typeof assertCanStartCheckoutForEmail>[0],
  email: string,
  options: { includeEmail?: boolean } = {},
): Promise<NextResponse<{ error: "checkout_access_already_exists"; email?: string }> | null> {
  try {
    await assertCanStartCheckoutForEmail(supabase, email)
    return null
  } catch (error) {
    if (error instanceof Error && error.message.includes("already has access")) {
      return NextResponse.json(
        {
          error: "checkout_access_already_exists",
          ...(options.includeEmail === false ? {} : { email }),
        },
        { status: 409 },
      )
    }
    throw error
  }
}

function createBillingAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false },
    },
  )
}

export async function createStripeCheckoutAccessConflictResponse(
  supabase: Parameters<typeof assertCanStartCheckout>[0],
  userId: string,
  email?: string | null,
): Promise<NextResponse<{ error: "checkout_access_already_exists"; email?: string }> | null> {
  try {
    await assertCanStartCheckout(supabase, userId)
    return null
  } catch (error) {
    if (error instanceof Error && error.message.includes("already has access")) {
      return NextResponse.json(
        { error: "checkout_access_already_exists", ...(email ? { email } : {}) },
        { status: 409 },
      )
    }
    throw error
  }
}
