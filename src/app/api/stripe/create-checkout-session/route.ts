import { after, NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { createClient } from "@supabase/supabase-js"
import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { assertCanStartCheckout, assertCanStartCheckoutForEmail } from "@/lib/billing/subscriptions"
import { resolvePaymentRuntime } from "@/lib/billing/payment-runtime-config"
import { captureCheckoutException, type CheckoutInterval } from "@/lib/observability/checkout"
import {
  captureServerPaymentFailure,
  flushServerPaymentTelemetry,
} from "@/lib/observability/payment-server"
import { FUNNEL_SESSION_COOKIE, FUNNEL_TOUCH_COOKIE } from "@/lib/funnel/cookie"
import type { FunnelCookieContext } from "@/lib/funnel/cookie"
import {
  recordFunnelEvent,
  assertPersonalPlanOneTimeCheckoutAuthorized,
  PersonalPlanOneTimeCheckoutAuthorizationError,
  resolveFunnelCookieContext,
  resolveFunnelContextForLead,
  resolvePendingFunnelTouchValue,
} from "@/lib/funnel/server"
import { isPersonalPlanLaunchPricingEnabled } from "@/lib/funnel/flags"
import {
  resolveSubscriptionPricingCatalog,
  STANDARD_PRICING_CATALOG,
  type SubscriptionPricingCatalog,
} from "@/lib/billing/pricing-catalog"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import { buildFreemiumCheckoutReturnUrl } from "@/lib/freemium/checkout-return"
import {
  FREEMIUM_CHECKOUT_MARKER_KEY,
  FREEMIUM_CHECKOUT_MARKER_VALUE,
  FREEMIUM_CHECKOUT_USER_KEY,
} from "@/lib/freemium/checkout-metadata"
import {
  bindPersonalPlanOneTimeConsentProviderReference,
  createPersonalPlanOneTimeCheckoutConsent,
} from "@/lib/billing/personal-plan-one-time-consents"
import { getStripe, getStripePriceId, resolveStripePriceId } from "@/lib/stripe/client"
import { buildStripeCheckoutSessionParams } from "@/lib/stripe/checkout-session-params"
import type { BillingInterval } from "@/lib/stripe/intervals"
import { getStripePricingPlan } from "@/lib/stripe/pricing-plans"
import {
  getPersonalPlanOnceStripePriceId,
  PERSONAL_PLAN_ONCE_KIND,
  PERSONAL_PLAN_ONCE_PRODUCT,
} from "@/lib/billing/offer-products"
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
import { createHash, timingSafeEqual } from "node:crypto"
import type Stripe from "stripe"

const PREPARED_CHECKOUT_MINIMUM_TTL_SECONDS = 30 * 60
const PREPARED_CHECKOUT_EXPIRY_MARGIN_SECONDS = 60
export const PREPARED_SESSION_UNAVAILABLE = "prepared_checkout_unavailable"
type CheckoutCommerceInterval = BillingInterval | "one_time"
type CheckoutAnalyticsPlan =
  | ReturnType<typeof getStripePricingPlan>
  | typeof PERSONAL_PLAN_ONCE_PRODUCT

export const runtime = "nodejs"

/**
 * freemium-scanner-first T14: `"premium_sheet"` is the third checkout entry point — the
 * Premium sheet a free user opens from a gate. It is the ONLY source whose price catalog
 * is pinned server-side (always `standard`, whatever `PERSONAL_PLAN_LAUNCH_PRICING_ENABLED`
 * says — see the catalog resolution below), because the sheet renders standard prices
 * unconditionally (`src/lib/premium-sheet/pricing.ts`) and a launch-pricing rollout must
 * never charge a different amount than the sheet showed. The two pre-existing values keep
 * the flag-aware resolver, so every legacy flow is unchanged.
 */
export type CheckoutRequestSource = "pricing_page" | "quiz_result_offer" | "premium_sheet"

export const StripeCheckoutSessionRequestSchema = z
  .object({
    interval: z.enum(["month", "quarter", "year"]).optional(),
    purchaseKind: z.literal(PERSONAL_PLAN_ONCE_KIND).optional(),
    funnelSessionId: z.string().uuid().optional(),
    // Accept null too — the client sends `leadId: null` when there's no ?lead=
    // in the URL (resubscribe path). `.optional()` alone rejects null.
    leadId: z.string().uuid().nullable().optional(),
    source: z.enum(["pricing_page", "quiz_result_offer", "premium_sheet"]).default("pricing_page"),
    funnelEventId: z.string().uuid().optional(),
    checkoutAttemptId: z.string().uuid().optional(),
    checkoutSessionAttemptId: z.string().uuid().optional(),
    checkoutContext: z.literal("membership_reactivation").optional(),
    returnDestination: z.string().max(500).optional(),
    presentation: z.literal("offer_overlay_elements").optional(),
    action: z.enum(["create", "prepare", "claim"]).default("create"),
    preparationId: z.string().uuid().optional(),
    preparationToken: z.string().min(32).max(256).optional(),
    preparedSessionId: z.string().startsWith("cs_").optional(),
    /**
     * T14, `source: "premium_sheet"` only: the app surface the sheet was opened from, so a
     * redirect-based payment method returns THERE instead of `/welcome`. Untrusted —
     * `sanitizeFreemiumCheckoutReturnPath` reduces it to an allowlisted app path.
     */
    returnPath: z.string().max(200).optional(),
  })
  .strict()
  .superRefine(
    (
      {
        action,
        checkoutAttemptId,
        checkoutSessionAttemptId,
        checkoutContext,
        funnelEventId,
        funnelSessionId,
        interval,
        leadId,
        preparationId,
        preparationToken,
        preparedSessionId,
        presentation,
        purchaseKind,
        returnDestination,
        returnPath,
        source,
      },
      context,
    ) => {
      // T14: the Premium sheet sells exactly one thing — a standard-catalog subscription,
      // created in one step for an already-authenticated free user. Every other protocol
      // this endpoint speaks (one-time product, lead/funnel offer contract, prepared/claim,
      // reactivation, Elements presentation) is refused here rather than silently ignored,
      // so the new source can never reach a legacy branch.
      if (source === "premium_sheet") {
        if (
          purchaseKind ||
          presentation ||
          action !== "create" ||
          leadId ||
          funnelSessionId ||
          preparationId ||
          preparationToken ||
          preparedSessionId ||
          checkoutSessionAttemptId ||
          checkoutContext ||
          returnDestination
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "invalid Premium-sheet checkout contract",
            path: ["source"],
          })
        }
      } else if (returnPath !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "returnPath is limited to Premium-sheet checkout",
          path: ["returnPath"],
        })
      }
      if (purchaseKind === PERSONAL_PLAN_ONCE_KIND) {
        if (interval !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "one-time checkout cannot include a subscription interval",
            path: ["interval"],
          })
        }
        const hasValidActionContract =
          action === "prepare"
            ? Boolean(
                preparationId && !checkoutAttemptId && !checkoutSessionAttemptId && !funnelEventId,
              )
            : action === "claim"
              ? Boolean(
                  preparationId &&
                  preparationToken &&
                  preparedSessionId &&
                  checkoutAttemptId &&
                  !checkoutSessionAttemptId &&
                  funnelEventId,
                )
              : false
        if (
          source !== "quiz_result_offer" ||
          presentation !== "offer_overlay_elements" ||
          !leadId ||
          !funnelSessionId ||
          !hasValidActionContract ||
          checkoutContext ||
          returnDestination
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "invalid one-time personal-plan checkout contract",
            path: ["purchaseKind"],
          })
        }
      } else if (!interval) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "subscription checkout requires an interval",
          path: ["interval"],
        })
      }
      if (presentation === "offer_overlay_elements" && source !== "quiz_result_offer") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "offer Elements presentation requires quiz_result_offer source",
          path: ["presentation"],
        })
      }
      if (
        presentation === "offer_overlay_elements" &&
        (checkoutContext === "membership_reactivation" || returnDestination !== undefined)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "offer Elements presentation cannot be used for reactivation",
          path: ["presentation"],
        })
      }
      if (
        checkoutSessionAttemptId &&
        (action !== "create" ||
          source !== "quiz_result_offer" ||
          purchaseKind === PERSONAL_PLAN_ONCE_KIND ||
          !checkoutAttemptId)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "checkout Session attempts are limited to direct membership offer creation",
          path: ["checkoutSessionAttemptId"],
        })
      }
      // Membership clients no longer initiate prepare/claim. The schema temporarily
      // accepts those actions so an already-loaded production asset can finish its
      // checkout; remove that compatibility after the 14-day zero-use drain in the
      // cold-checkout rollout plan. One-time checkout still owns this protocol.
      if (action === "prepare") {
        if (presentation !== "offer_overlay_elements" || source !== "quiz_result_offer") {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "prepared checkout is limited to the offer Elements presentation",
            path: ["action"],
          })
        }
        if (!preparationId || !preparationToken) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "prepared checkout requires a preparation credential",
            path: preparationId ? ["preparationToken"] : ["preparationId"],
          })
        }
        if (
          checkoutAttemptId ||
          checkoutSessionAttemptId ||
          funnelEventId ||
          checkoutContext ||
          returnDestination
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "prepared checkout cannot claim an attempt or reactivation",
            path: ["action"],
          })
        }
      }
      if (action === "claim") {
        if (presentation !== "offer_overlay_elements" || source !== "quiz_result_offer") {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "prepared checkout claims are limited to the offer Elements presentation",
            path: ["action"],
          })
        }
        if (
          !preparationId ||
          !preparationToken ||
          !preparedSessionId ||
          !checkoutAttemptId ||
          !funnelEventId
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "prepared checkout claim is incomplete",
            path: ["action"],
          })
        }
        if (checkoutContext || returnDestination) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "prepared checkout claims cannot reactivate memberships",
            path: ["action"],
          })
        }
      }
    },
  )

export function isOfferElementsCheckoutEnabled(
  environment: {
    NEXT_PUBLIC_OFFER_PAYMENT_OVERLAY_ENABLED?: string
    NEXT_PUBLIC_STRIPE_EXPRESS_CHECKOUT_ENABLED?: string
  } = {
    NEXT_PUBLIC_OFFER_PAYMENT_OVERLAY_ENABLED:
      process.env.NEXT_PUBLIC_OFFER_PAYMENT_OVERLAY_ENABLED,
    NEXT_PUBLIC_STRIPE_EXPRESS_CHECKOUT_ENABLED:
      process.env.NEXT_PUBLIC_STRIPE_EXPRESS_CHECKOUT_ENABLED,
  },
) {
  return (
    environment.NEXT_PUBLIC_OFFER_PAYMENT_OVERLAY_ENABLED === "true" &&
    environment.NEXT_PUBLIC_STRIPE_EXPRESS_CHECKOUT_ENABLED === "true"
  )
}

export function shouldRecordFunnelForCheckoutAction(action: "create" | "prepare" | "claim") {
  return action !== "prepare"
}

export function resolveCheckoutFunnelContext<
  TLead extends { sessionId: string },
  TCookie extends { sessionId: string },
>({
  shouldRecord,
  exactOfferFunnelSessionId,
  leadFunnelContext,
  cookieFunnelContext,
}: {
  shouldRecord: boolean
  exactOfferFunnelSessionId?: string
  leadFunnelContext: TLead | null
  cookieFunnelContext: TCookie | null
}): TLead | TCookie | null {
  if (!shouldRecord) return null
  if (!exactOfferFunnelSessionId) return cookieFunnelContext ?? leadFunnelContext
  if (leadFunnelContext?.sessionId === exactOfferFunnelSessionId) return leadFunnelContext
  if (cookieFunnelContext?.sessionId === exactOfferFunnelSessionId) return cookieFunnelContext
  return null
}

export function reportMissingExactOfferFunnelContext(
  {
    exactOfferFunnelSessionId,
    funnelContext,
    interval,
    shouldRecord,
  }: {
    exactOfferFunnelSessionId?: string
    funnelContext: unknown | null
    interval: CheckoutInterval
    shouldRecord: boolean
  },
  capture: typeof captureCheckoutException = captureCheckoutException,
  warn: (message: string, error: unknown) => void = console.warn,
) {
  if (!shouldRecord || !exactOfferFunnelSessionId || funnelContext) return false
  try {
    capture(new Error("quiz offer funnel context unavailable"), {
      provider: "stripe",
      stage: "stripe_checkout_session_create",
      source: "quiz_result_offer",
      interval,
      reason: "funnel_context_unavailable",
    })
  } catch (error) {
    warn("[funnel] missing-context observability failed", error)
  }
  return true
}

/**
 * Which price catalog a checkout SUBMITS (freemium-scanner-first T14, carry-forward from
 * T13).
 *
 * The Premium sheet renders standard prices unconditionally
 * (`src/lib/premium-sheet/pricing.ts`), so the price it charges is pinned to the same
 * catalog here — a launch-pricing rollout must never charge 69,99 behind a 99,99 sheet.
 * Every other source keeps the flag-aware resolver exactly as before.
 *
 * Exported because this is the one assertion worth making in both flag states.
 */
export function resolveCheckoutPricingCatalog({
  source,
  launchPricingEnabled,
}: {
  source: CheckoutRequestSource
  launchPricingEnabled: boolean
}): SubscriptionPricingCatalog {
  if (source === "premium_sheet") return STANDARD_PRICING_CATALOG
  return resolveSubscriptionPricingCatalog(launchPricingEnabled)
}

export function resolveStripeCheckoutSessionCreateOptions({
  reactivationReservationId,
  isPreparation,
  preparationId,
  isOneTimePurchase,
  source,
  checkoutAttemptId,
  checkoutSessionAttemptId,
}: {
  reactivationReservationId?: string
  isPreparation: boolean
  preparationId?: string
  isOneTimePurchase: boolean
  source: CheckoutRequestSource
  checkoutAttemptId?: string
  checkoutSessionAttemptId?: string
}) {
  if (reactivationReservationId) {
    return { idempotencyKey: `membership-reactivation:${reactivationReservationId}` }
  }
  if (isPreparation && preparationId) {
    return { idempotencyKey: preparedCheckoutCreateIdempotencyKey(preparationId) }
  }
  if (isOneTimePurchase && checkoutAttemptId) {
    return { idempotencyKey: `personal-plan-once:${checkoutAttemptId}` }
  }
  if (source === "quiz_result_offer" && checkoutAttemptId) {
    return {
      idempotencyKey: quizOfferMembershipCreateIdempotencyKey(
        checkoutSessionAttemptId ?? checkoutAttemptId,
      ),
    }
  }
  // T14: a re-mounted sheet (React strict mode, a retry after a network blip) must recover
  // the SAME Session rather than leave a trail of open ones behind the same CTA press.
  if (source === "premium_sheet" && checkoutAttemptId) {
    return { idempotencyKey: `premium-sheet:${checkoutAttemptId}` }
  }
  return undefined
}

export function reusableOneTimeStripeSessionClientSecret(
  session: Pick<Stripe.Checkout.Session, "client_secret" | "status">,
): string | null {
  return session.status === "open" && typeof session.client_secret === "string"
    ? session.client_secret
    : null
}

export function classifyOneTimeStripeSessionRecovery(
  session: Pick<Stripe.Checkout.Session, "client_secret" | "status">,
):
  | { type: "reuse"; clientSecret: string }
  | { type: "replace" }
  | { type: "complete" }
  | { type: "invalid" } {
  const clientSecret = reusableOneTimeStripeSessionClientSecret(session)
  if (clientSecret) return { type: "reuse", clientSecret }
  if (session.status === "expired") return { type: "replace" }
  if (session.status === "complete") return { type: "complete" }
  return { type: "invalid" }
}

export function preparedCheckoutExpiresAt(nowSeconds = Math.floor(Date.now() / 1000)) {
  // Stripe rejects Checkout Session expiries at its exact 30-minute floor when request latency
  // advances the server clock. Keep the user-facing lifetime short while retaining a safe margin.
  return (
    nowSeconds + PREPARED_CHECKOUT_MINIMUM_TTL_SECONDS + PREPARED_CHECKOUT_EXPIRY_MARGIN_SECONDS
  )
}

export function preparedCheckoutApplicationExpiresAt(
  stripeExpiresAt: number,
  applicationWindowStartedAt = Math.floor(Date.now() / 1000),
) {
  return Math.min(stripeExpiresAt, preparedCheckoutExpiresAt(applicationWindowStartedAt))
}

export async function POST(req: NextRequest) {
  const parsed = StripeCheckoutSessionRequestSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request" }, { status: 400 })
  }
  const {
    interval,
    purchaseKind,
    funnelSessionId,
    leadId,
    source,
    funnelEventId,
    checkoutAttemptId,
    checkoutSessionAttemptId,
    checkoutContext,
    action,
    preparationId,
    preparationToken,
    preparedSessionId,
    returnDestination: rawReturnDestination,
    returnPath: rawReturnPath,
    presentation,
  } = parsed.data
  const isOneTimePurchase = purchaseKind === PERSONAL_PLAN_ONCE_KIND
  const isPremiumSheetCheckout = source === "premium_sheet"
  if (presentation === "offer_overlay_elements" && !isOfferElementsCheckoutEnabled()) {
    return NextResponse.json({ error: "bad request" }, { status: 400 })
  }
  // Flag-off byte-identity: with the freemium restructure disabled this source does not
  // exist at all, exactly as before T14.
  if (isPremiumSheetCheckout && !isFreemiumScannerFirstEnabled()) {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  const isPreparation = action === "prepare"
  const subscriptionInterval = interval as BillingInterval
  const commerceInterval = isOneTimePurchase ? "one_time" : subscriptionInterval
  let checkoutIsInternalTest: boolean | undefined
  try {
    // Identity resolution: prefer existing Stripe customer > email > 400
    // Priority: leadId email → authed user's stripe_customer_id → authed user's email → 400
    let customerId: string | undefined
    let customerEmail: string | undefined
    let resolvedLeadId: string | null = null
    const preparedControlContext = () => ({
      commerceKind: isOneTimePurchase ? ("one_time" as const) : ("subscription" as const),
      isInternalTest: checkoutIsInternalTest ?? false,
      leadId: resolvedLeadId ?? leadId,
      checkoutAttemptId,
      source,
    })

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
    let oneTimeConsentId: string | null = null
    let oneTimeProviderLocked: "stripe" | null = null

    if (isOneTimePurchase) {
      // Re-fetches the persisted arm; browser fields only select this guarded path.
      let authorization
      try {
        authorization = await assertPersonalPlanOneTimeCheckoutAuthorized({
          leadId: leadId!,
          funnelSessionId,
        })
      } catch (error) {
        if (
          !(error instanceof PersonalPlanOneTimeCheckoutAuthorizationError) ||
          error.reason !== "not_authorized"
        ) {
          throw error
        }
        return isPreparation
          ? await preparedCheckoutUnavailable({
              ...preparedControlContext(),
              cause: "authorization_unavailable",
            })
          : NextResponse.json({ error: "not found" }, { status: 404 })
      }
      checkoutIsInternalTest = authorization.isInternalTest
      if (isPreparation) {
        const { data: existing, error: lookupError } = await getAdminSupabase()
          .from("personal_plan_one_time_checkout_consents")
          .select("id, stripe_checkout_session_id, paypal_order_id")
          .eq("lead_id", authorization.leadId)
          .eq("funnel_session_id", authorization.sessionId)
          .eq("product_kind", PERSONAL_PLAN_ONCE_KIND)
          .maybeSingle()
        if (lookupError) throw lookupError
        if (existing?.paypal_order_id) {
          await preparedCheckoutProviderLocked(preparedControlContext(), "paypal")
          return NextResponse.json(
            { error: "payment provider already selected", provider_locked: "paypal" },
            { status: 409 },
          )
        }
        if (existing?.stripe_checkout_session_id) {
          oneTimeProviderLocked = "stripe"
          const existingSession = await getStripe().checkout.sessions.retrieve(
            existing.stripe_checkout_session_id,
          )
          const recovery = classifyOneTimeStripeSessionRecovery(existingSession)
          if (recovery.type === "reuse") {
            return NextResponse.json({
              status: "recovered",
              client_secret: recovery.clientSecret,
              session_id: existingSession.id,
              expires_at: preparedCheckoutApplicationExpiresAt(existingSession.expires_at),
              provider_locked: "stripe",
            })
          }
          if (recovery.type === "complete") {
            return NextResponse.json({ error: "checkout already completed" }, { status: 409 })
          }
          if (recovery.type !== "replace") {
            throw new Error("Existing one-time Stripe Session is not recoverable")
          }
        }
      } else {
        try {
          const consent = await createPersonalPlanOneTimeCheckoutConsent(getAdminSupabase(), {
            leadId: authorization.leadId,
            funnelSessionId: authorization.sessionId,
            offerVariant: authorization.offerVariant,
            userId: authenticatedUserId ?? null,
          })
          oneTimeConsentId = consent.id
        } catch (error) {
          // A retry must recover the immutable evidence/session, never create a second consent.
          const { data: existing, error: lookupError } = await getAdminSupabase()
            .from("personal_plan_one_time_checkout_consents")
            .select("id, stripe_checkout_session_id, paypal_order_id")
            .eq("lead_id", authorization.leadId)
            .eq("funnel_session_id", authorization.sessionId)
            .eq("product_kind", PERSONAL_PLAN_ONCE_KIND)
            .maybeSingle()
          if (lookupError || !existing) throw error
          if (existing.paypal_order_id) {
            await preparedCheckoutProviderLocked(preparedControlContext(), "paypal")
            return NextResponse.json(
              { error: "payment provider already selected", provider_locked: "paypal" },
              { status: 409 },
            )
          }
          if (existing.stripe_checkout_session_id) {
            if (action === "claim") {
              if (existing.stripe_checkout_session_id === preparedSessionId) {
                oneTimeConsentId = existing.id
              } else {
                const existingSession = await getStripe().checkout.sessions.retrieve(
                  existing.stripe_checkout_session_id,
                )
                const recovery = classifyOneTimeStripeSessionRecovery(existingSession)
                if (recovery.type === "complete") {
                  return NextResponse.json({ error: "checkout already completed" }, { status: 409 })
                }
                if (recovery.type !== "replace") {
                  await preparedCheckoutProviderLocked(preparedControlContext(), "stripe")
                  return NextResponse.json(
                    { error: "payment provider already selected" },
                    { status: 409 },
                  )
                }
                oneTimeConsentId = existing.id
              }
            } else if (action === "create") {
              const existingSession = await getStripe().checkout.sessions.retrieve(
                existing.stripe_checkout_session_id,
              )
              const recovery = classifyOneTimeStripeSessionRecovery(existingSession)
              if (recovery.type === "reuse") {
                return NextResponse.json({ client_secret: recovery.clientSecret })
              }
              if (recovery.type === "complete") {
                return NextResponse.json({ error: "checkout already completed" }, { status: 409 })
              }
              if (recovery.type !== "replace") {
                throw new Error("Existing one-time Stripe Session is not reusable")
              }
            } else {
              await preparedCheckoutProviderLocked(preparedControlContext(), "stripe")
              return NextResponse.json(
                { error: "payment provider already selected" },
                { status: 409 },
              )
            }
          }
          oneTimeConsentId = existing.id
        }
      }
    }

    if (checkoutContext === "membership_reactivation") {
      if (!authenticatedUserId || !checkoutAttemptId || leadId) {
        return NextResponse.json({ error: "authenticated reactivation required" }, { status: 401 })
      }
    }

    // The sheet is only ever opened by a signed-in free user; there is no anonymous
    // Premium-sheet purchase to recover, and the completion contract binds the Session to
    // this exact user id.
    if (isPremiumSheetCheckout && !authenticatedUserId) {
      return NextResponse.json({ error: "authentication required" }, { status: 401 })
    }

    if (authenticatedUserId) {
      const adminSupabase = getAdminSupabase()
      const conflictResponse = await createStripeCheckoutAccessConflictResponse(
        adminSupabase,
        authenticatedUserId,
        user.email,
      )
      if (conflictResponse) {
        return isPreparation
          ? await preparedCheckoutUnavailable({
              ...preparedControlContext(),
              cause: "access_conflict",
            })
          : conflictResponse
      }
      if (user?.email) {
        const emailConflictResponse = await createStripeCheckoutEmailAccessConflictResponse(
          adminSupabase,
          user.email,
        )
        if (emailConflictResponse) {
          return isPreparation
            ? await preparedCheckoutUnavailable({
                ...preparedControlContext(),
                cause: "access_conflict",
              })
            : emailConflictResponse
        }
      }

      if (checkoutContext === "membership_reactivation" && checkoutAttemptId) {
        const returnDestination = sanitizeReactivationReturnDestination(rawReturnDestination)
        try {
          reactivationReservation = await acquireMembershipReactivationCheckout(adminSupabase, {
            userId: authenticatedUserId,
            checkoutAttemptId,
            interval: subscriptionInterval,
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
        await reportStripeCheckoutInitializationFailure({
          error,
          commerceKind: isOneTimePurchase ? "one_time" : "subscription",
          isInternalTest: checkoutIsInternalTest ?? false,
          leadId,
          source,
        })
        return isPreparation
          ? await preparedCheckoutUnavailable({
              ...preparedControlContext(),
              cause: "lead_lookup_unavailable",
            })
          : NextResponse.json({ error: "lead lookup failed" }, { status: 500 })
      }
      customerEmail = data?.email ?? undefined
      if (customerEmail) {
        resolvedLeadId = leadId
        const conflictResponse = await createStripeCheckoutEmailAccessConflictResponse(
          adminSupabase,
          customerEmail,
          { includeEmail: false },
        )
        if (conflictResponse) {
          return isPreparation
            ? await preparedCheckoutUnavailable({
                ...preparedControlContext(),
                cause: "access_conflict",
              })
            : conflictResponse
        }
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
        return isPreparation
          ? await preparedCheckoutUnavailable({
              ...preparedControlContext(),
              cause: "identity_unavailable",
            })
          : NextResponse.json({ error: "identity required" }, { status: 400 })
      }
    }

    const origin = req.nextUrl.origin
    const stripe = getStripe()

    if (action === "claim") {
      return claimPreparedCheckoutSession({
        stripe,
        requestedInterval: commerceInterval,
        isOneTimePurchase,
        source,
        presentation,
        leadId: resolvedLeadId,
        userId: authenticatedUserId,
        customerId,
        customerEmail,
        preparationId: preparationId!,
        preparationToken: preparationToken!,
        preparedSessionId: preparedSessionId!,
        checkoutAttemptId: checkoutAttemptId!,
        funnelEventId: funnelEventId!,
        oneTimeConsentId,
        adminSupabase: isOneTimePurchase ? getAdminSupabase() : undefined,
        funnelSessionId: isOneTimePurchase ? funnelSessionId : undefined,
        cookieStore,
        userIdForFunnel: user?.id,
        isInternalTest: checkoutIsInternalTest ?? false,
      })
    }

    const exactOfferFunnelSessionId = source === "quiz_result_offer" ? funnelSessionId : undefined
    const leadFunnelContext = resolvedLeadId
      ? await resolveFunnelContextForLead(resolvedLeadId, exactOfferFunnelSessionId)
      : null
    const pricingCatalog = resolveCheckoutPricingCatalog({
      source,
      launchPricingEnabled: isPersonalPlanLaunchPricingEnabled(),
    })
    const analyticsPlan = isOneTimePurchase
      ? PERSONAL_PLAN_ONCE_PRODUCT
      : getStripePricingPlan(subscriptionInterval, pricingCatalog)
    const priceId = isOneTimePurchase
      ? getPersonalPlanOnceStripePriceId()
      : getStripePriceId(subscriptionInterval, pricingCatalog)
    const resolvedSubscriptionPrice = isOneTimePurchase ? null : resolveStripePriceId(priceId)
    if (
      !priceId ||
      (!isOneTimePurchase &&
        (resolvedSubscriptionPrice?.interval !== subscriptionInterval ||
          resolvedSubscriptionPrice.pricingCatalog !== pricingCatalog))
    ) {
      await reportStripeCheckoutInitializationFailure({
        error: { code: "price_not_configured" },
        commerceKind: isOneTimePurchase ? "one_time" : "subscription",
        isInternalTest: checkoutIsInternalTest ?? false,
        leadId,
        source,
      })
      return NextResponse.json({ error: "price not configured" }, { status: 500 })
    }

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
          interval: commerceInterval as never,
          reason: "reactivation_session_reconciliation_required",
        })
        return NextResponse.json({ error: "reactivation_checkout_unavailable" }, { status: 409 })
      }
    }
    // The Premium sheet is not a funnel surface: there is no lead, no quiz session and no
    // offer touch to attribute, and recording a `checkout_started` milestone against a
    // stray cookie context would attach an in-app upgrade to somebody's old quiz funnel.
    const shouldRecordCheckoutFunnel =
      shouldRecordFunnelForCheckoutAction(action) && !isPremiumSheetCheckout
    const cookieFunnelContext = shouldRecordCheckoutFunnel
      ? await resolveFunnelCookieContext(cookieStore.get(FUNNEL_SESSION_COOKIE)?.value)
      : null
    const funnelContext = resolveCheckoutFunnelContext({
      shouldRecord: shouldRecordCheckoutFunnel,
      exactOfferFunnelSessionId,
      leadFunnelContext,
      cookieFunnelContext,
    })
    reportMissingExactOfferFunnelContext({
      shouldRecord: shouldRecordCheckoutFunnel,
      exactOfferFunnelSessionId,
      funnelContext,
      interval: subscriptionInterval,
    })
    const funnelTouch = funnelContext
      ? await resolvePendingFunnelTouchValue(
          cookieStore.get(FUNNEL_TOUCH_COOKIE)?.value,
          funnelContext,
        )
      : null
    if (
      checkoutIsInternalTest === undefined &&
      funnelContext &&
      "isInternalTest" in funnelContext &&
      typeof funnelContext.isInternalTest === "boolean"
    ) {
      checkoutIsInternalTest = funnelContext.isInternalTest
    }

    const preparedMetadata = isPreparation
      ? buildPreparedCheckoutMetadata({
          preparationId: preparationId!,
          preparationTokenHash: hashPreparedCheckoutToken(preparationToken!),
          interval: commerceInterval,
          priceId,
          pricingCatalog: isOneTimePurchase ? undefined : pricingCatalog,
          source,
          presentation,
          identityHash: createPreparedCheckoutIdentityHash({
            authenticatedUserId,
            resolvedLeadId,
            customerId,
            customerEmail,
          }),
        })
      : undefined
    const params = buildStripeCheckoutSessionParams({
      checkoutKind: isOneTimePurchase ? PERSONAL_PLAN_ONCE_KIND : "subscription",
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
      presentation: presentation === "offer_overlay_elements" ? "elements" : "embedded_page",
      ...(isPremiumSheetCheckout
        ? {
            completion: "contextual" as const,
            contextualReturnUrl: buildFreemiumCheckoutReturnUrl(origin, rawReturnPath),
          }
        : {}),
      ...(!isPreparation &&
      (checkoutAttemptId ||
        oneTimeConsentId ||
        !isOneTimePurchase ||
        checkoutIsInternalTest !== undefined)
        ? {
            metadata: {
              ...(checkoutAttemptId ? { checkout_attempt_id: checkoutAttemptId } : {}),
              ...(oneTimeConsentId ? { personal_plan_once_consent_id: oneTimeConsentId } : {}),
              ...(!isOneTimePurchase
                ? { pricing_catalog: pricingCatalog, stripe_price_id: priceId }
                : {}),
              ...(isPremiumSheetCheckout
                ? {
                    [FREEMIUM_CHECKOUT_MARKER_KEY]: FREEMIUM_CHECKOUT_MARKER_VALUE,
                    [FREEMIUM_CHECKOUT_USER_KEY]: authenticatedUserId!,
                  }
                : {}),
              ...(checkoutIsInternalTest !== undefined
                ? { is_internal_test: String(checkoutIsInternalTest) }
                : {}),
            },
          }
        : {}),
      ...(isPreparation
        ? {
            metadata: {
              ...preparedMetadata,
              ...(checkoutIsInternalTest !== undefined
                ? { is_internal_test: String(checkoutIsInternalTest) }
                : {}),
            },
          }
        : {}),
    })
    const session = await stripe.checkout.sessions.create(
      params,
      resolveStripeCheckoutSessionCreateOptions({
        reactivationReservationId: reactivationReservation?.id,
        isPreparation,
        preparationId,
        isOneTimePurchase,
        source,
        checkoutAttemptId,
        checkoutSessionAttemptId,
      }),
    )
    if (reactivationReservation) {
      await bindMembershipReactivationProviderReference(
        getAdminSupabase(),
        reactivationReservation.id,
        session.id,
      )
    }
    if (oneTimeConsentId) {
      await bindPersonalPlanOneTimeConsentProviderReference(getAdminSupabase(), oneTimeConsentId, {
        stripeCheckoutSessionId: session.id,
      })
    }

    if (isPreparation) {
      if (!session.client_secret) {
        throw new Error("prepared Stripe checkout session has no client secret")
      }
      // Stripe can replay the idempotent Session for the same preparation ID.
      // Never hand back a fresh token that cannot claim that existing Session.
      if (!hasMatchingToken(session.metadata?.checkout_preparation_token_hash, preparationToken!)) {
        return await preparedCheckoutUnavailable({
          ...preparedControlContext(),
          cause: "preparation_token_mismatch",
        })
      }
      return NextResponse.json({
        status: "prepared",
        client_secret: session.client_secret,
        session_id: session.id,
        preparation_token: preparationToken,
        expires_at: preparedCheckoutApplicationExpiresAt(session.expires_at, session.created),
        ...(oneTimeProviderLocked ? { provider_locked: oneTimeProviderLocked } : {}),
      })
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
            interval: commerceInterval as never,
            ...(checkoutAttemptId ? { checkout_attempt_id: checkoutAttemptId } : {}),
            ...(checkoutContext ? { checkout_context: checkoutContext } : {}),
            currency: analyticsPlan.currency,
            plan_id: analyticsPlan.analyticsId,
            ...(!isOneTimePurchase ? { pricing_catalog: pricingCatalog } : {}),
            value: analyticsPlan.amount,
          },
        })
          .then(() => true)
          .catch((error) => {
            console.warn("[funnel] Stripe checkout tracking failed", error)
            return false
          })
      : false

    const response = NextResponse.json({
      client_secret: session.client_secret,
      // T14 only: Stripe's embedded `onComplete` callback carries no Session id, and the
      // sheet needs one to ask the server what actually happened. Added for the new source
      // alone so every existing client's response body stays byte-identical.
      ...(isPremiumSheetCheckout ? { session_id: session.id } : {}),
    })
    if (funnelTouch && funnelRecorded) {
      response.cookies.set(FUNNEL_TOUCH_COOKIE, "", { path: "/", maxAge: 0 })
    }
    return response
  } catch (error) {
    await reportStripeCheckoutInitializationFailure({
      error,
      commerceKind: isOneTimePurchase ? "one_time" : "subscription",
      isInternalTest: checkoutIsInternalTest ?? false,
      leadId,
      source,
    })
    throw error
  }
}

function isDefinitivelyMissingStripeResource(error: unknown) {
  if (!error || typeof error !== "object") return false
  const candidate = error as { code?: unknown; statusCode?: unknown }
  return candidate.code === "resource_missing" || candidate.statusCode === 404
}

export function classifyCheckoutInitializationFailure(error: unknown): {
  errorFamily: "configuration" | "provider_session" | "provider_unavailable" | "unknown"
  status:
    | "idempotency_conflict"
    | "configuration_missing"
    | "rate_limited"
    | "provider_unavailable"
    | "unknown"
} {
  const candidate =
    error && typeof error === "object"
      ? (error as { code?: unknown; statusCode?: unknown; type?: unknown })
      : null
  const code = typeof candidate?.code === "string" ? candidate.code : ""
  const statusCode = typeof candidate?.statusCode === "number" ? candidate.statusCode : undefined
  const type = typeof candidate?.type === "string" ? candidate.type : ""

  if (code === "idempotency_error") {
    return { errorFamily: "provider_session", status: "idempotency_conflict" }
  }
  if (
    code === "api_key_expired" ||
    code === "invalid_api_key" ||
    code === "price_not_configured" ||
    type === "StripeAuthenticationError"
  ) {
    return { errorFamily: "configuration", status: "configuration_missing" }
  }
  if (code === "rate_limit" || statusCode === 429) {
    return { errorFamily: "provider_unavailable", status: "rate_limited" }
  }
  if (statusCode === 502 || statusCode === 503 || statusCode === 504 || type === "StripeAPIError") {
    return { errorFamily: "provider_unavailable", status: "provider_unavailable" }
  }
  return { errorFamily: "unknown", status: "unknown" }
}

type StripeCheckoutInitializationFailure = {
  error: unknown
  commerceKind: "subscription" | "one_time"
  isInternalTest: boolean
  leadId?: string | null
  source: CheckoutRequestSource
}

type StripeCheckoutInitializationTelemetry = {
  capture: typeof captureServerPaymentFailure
  flush: typeof flushServerPaymentTelemetry
  environment: { STRIPE_SECRET_KEY?: string; VERCEL_ENV?: string }
}

export async function reportStripeCheckoutInitializationFailure(
  input: StripeCheckoutInitializationFailure,
  telemetry: StripeCheckoutInitializationTelemetry = {
    capture: captureServerPaymentFailure,
    flush: flushServerPaymentTelemetry,
    environment: {
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      VERCEL_ENV: process.env.VERCEL_ENV,
    },
  },
) {
  const classification = classifyCheckoutInitializationFailure(input.error)
  const runtime = resolvePaymentRuntime({
    VERCEL_ENV: telemetry.environment.VERCEL_ENV,
    STRIPE_SECRET_KEY: telemetry.environment.STRIPE_SECRET_KEY,
  })
  telemetry.capture({
    signal: "payment_checkout_initialization_failed",
    provider: "stripe",
    boundary: "provider_session",
    errorFamily: classification.errorFamily,
    commerceKind: input.commerceKind,
    origin: "provider_api",
    method: "unknown",
    truth: "unknown",
    live: runtime.stripeLive,
    isInternalTest: input.isInternalTest,
    source: input.source,
    leadId: input.leadId,
    status: classification.status,
  })
  await telemetry.flush()
}

export function preparedCheckoutUnavailablePayload() {
  return { status: "unavailable" as const, reason: PREPARED_SESSION_UNAVAILABLE }
}

export type PreparedCheckoutControlOutcomeCause =
  | "authorization_unavailable"
  | "provider_locked_paypal"
  | "provider_locked_stripe"
  | "access_conflict"
  | "lead_lookup_unavailable"
  | "identity_unavailable"
  | "preparation_token_mismatch"
  | "prepared_session_missing"
  | "prepared_pricing_missing"
  | "consent_context_missing"
  | "claim_validation_failed"
  | "canonical_metadata_repair_failed"
  | "prepared_client_secret_missing"
  | "claim_update_failed"
  | "claim_metadata_mismatch"

type PreparedCheckoutControlOutcomeTelemetry = {
  capture: typeof captureServerPaymentFailure
  flush: typeof flushServerPaymentTelemetry
  schedule?: (task: () => Promise<void>) => void
  environment: { STRIPE_SECRET_KEY?: string; VERCEL_ENV?: string }
}

export async function reportPreparedCheckoutControlOutcome(
  input: {
    cause: PreparedCheckoutControlOutcomeCause
    commerceKind: "subscription" | "one_time"
    isInternalTest: boolean
    leadId?: string | null
    checkoutAttemptId?: string | null
    source: CheckoutRequestSource
  },
  telemetry: PreparedCheckoutControlOutcomeTelemetry = {
    capture: captureServerPaymentFailure,
    flush: flushServerPaymentTelemetry,
    environment: {
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      VERCEL_ENV: process.env.VERCEL_ENV,
    },
  },
) {
  try {
    const runtime = resolvePaymentRuntime({
      VERCEL_ENV: telemetry.environment.VERCEL_ENV,
      STRIPE_SECRET_KEY: telemetry.environment.STRIPE_SECRET_KEY,
    })
    const eventId = telemetry.capture({
      signal:
        input.cause === "access_conflict" || input.cause.startsWith("provider_locked_")
          ? "customer_payment_error_observed"
          : "checkout_experience_degraded",
      provider: "stripe",
      boundary: "provider_session",
      errorFamily: "control_outcome",
      commerceKind: input.commerceKind,
      origin: "provider_api",
      method: "unknown",
      truth: "unknown",
      live: runtime.stripeLive,
      isInternalTest: input.isInternalTest,
      retryable: "true",
      source: input.source,
      leadId: input.leadId,
      checkoutAttemptId: input.checkoutAttemptId,
      status: input.cause,
    })
    if (!eventId) return
    const schedule = telemetry.schedule ?? ((task: () => Promise<void>) => after(task))
    schedule(async () => {
      try {
        await telemetry.flush()
      } catch {
        // Post-response telemetry delivery must not affect checkout recovery.
      }
    })
  } catch {
    // Control-outcome diagnostics must never affect the opaque recovery response.
  }
}

async function preparedCheckoutUnavailable(input: {
  cause: Exclude<
    PreparedCheckoutControlOutcomeCause,
    "provider_locked_paypal" | "provider_locked_stripe"
  >
  commerceKind: "subscription" | "one_time"
  isInternalTest: boolean
  leadId?: string | null
  checkoutAttemptId?: string | null
  source: CheckoutRequestSource
}) {
  // Clients deliberately receive one outcome for identity, expiry, and token failures.
  // Detailed causes are safe to add to server-only diagnostics without becoming an oracle.
  await reportPreparedCheckoutControlOutcome(input)
  return NextResponse.json(preparedCheckoutUnavailablePayload())
}

async function preparedCheckoutProviderLocked(
  input: {
    commerceKind: "subscription" | "one_time"
    isInternalTest: boolean
    leadId?: string | null
    checkoutAttemptId?: string | null
    source: CheckoutRequestSource
  },
  provider: "paypal" | "stripe",
) {
  await reportPreparedCheckoutControlOutcome({ ...input, cause: `provider_locked_${provider}` })
}

export function hashPreparedCheckoutToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function createPreparedCheckoutIdentityHash(input: {
  authenticatedUserId?: string
  resolvedLeadId?: string | null
  customerId?: string
  customerEmail?: string
}) {
  const identity = input.authenticatedUserId
    ? `user:${input.authenticatedUserId}`
    : input.resolvedLeadId
      ? `lead:${input.resolvedLeadId}`
      : input.customerId
        ? `customer:${input.customerId}`
        : `email:${input.customerEmail?.trim().toLowerCase() ?? ""}`
  return createHash("sha256").update(identity).digest("hex")
}

function buildPreparedCheckoutMetadata(input: {
  preparationId: string
  preparationTokenHash: string
  interval: CheckoutCommerceInterval
  priceId: string
  pricingCatalog?: SubscriptionPricingCatalog
  source: CheckoutRequestSource
  presentation?: "offer_overlay_elements"
  identityHash: string
}) {
  return {
    checkout_preparation_id: input.preparationId,
    checkout_preparation_token_hash: input.preparationTokenHash,
    checkout_preparation_status: "prepared",
    checkout_preparation_interval: input.interval,
    checkout_preparation_price_id: input.priceId,
    ...(input.pricingCatalog ? { checkout_preparation_pricing_catalog: input.pricingCatalog } : {}),
    checkout_preparation_source: input.source,
    checkout_preparation_presentation: input.presentation ?? "",
    checkout_preparation_identity_hash: input.identityHash,
  }
}

function hasMatchingToken(expectedHash: string | undefined, token: string) {
  if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) return false
  const expected = Buffer.from(expectedHash, "hex")
  const actual = Buffer.from(hashPreparedCheckoutToken(token), "hex")
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function validatePreparedCheckoutClaim(input: {
  metadata: Record<string, string>
  sessionStatus: string | null
  expiresAt: number
  nowSeconds: number
  lineItemPriceId?: string
  preparationId: string
  preparationToken: string
  interval: CheckoutCommerceInterval
  priceId: string
  source: CheckoutRequestSource
  presentation?: "offer_overlay_elements"
  identityHash: string
  checkoutAttemptId: string
  funnelEventId: string
  oneTimeConsentId?: string | null
}): { ok: true; alreadyClaimed: boolean } | { ok: false; reason: "invalid" | "stale" } {
  const expected = {
    checkout_preparation_id: input.preparationId,
    checkout_preparation_interval: input.interval,
    checkout_preparation_price_id: input.priceId,
    checkout_preparation_source: input.source,
    checkout_preparation_presentation: input.presentation ?? "",
    checkout_preparation_identity_hash: input.identityHash,
  }
  const metadataMatches = Object.entries(expected).every(
    ([key, value]) => input.metadata[key] === value,
  )
  if (
    input.sessionStatus !== "open" ||
    input.expiresAt <= input.nowSeconds ||
    !metadataMatches ||
    input.lineItemPriceId !== input.priceId
  ) {
    return { ok: false, reason: "stale" }
  }
  if (!hasMatchingToken(input.metadata.checkout_preparation_token_hash, input.preparationToken)) {
    return { ok: false, reason: "invalid" }
  }
  if (input.metadata.checkout_preparation_status === "claimed") {
    if (
      input.metadata.checkout_attempt_id !== input.checkoutAttemptId ||
      input.metadata.checkout_funnel_event_id !== input.funnelEventId ||
      (input.oneTimeConsentId &&
        input.metadata.personal_plan_once_consent_id !== input.oneTimeConsentId)
    ) {
      return { ok: false, reason: "invalid" }
    }
    return { ok: true, alreadyClaimed: true }
  }
  if (input.metadata.checkout_preparation_status !== "prepared") {
    return { ok: false, reason: "stale" }
  }
  return { ok: true, alreadyClaimed: false }
}

export function hasMatchingPreparedCheckoutClaim(
  metadata: Record<string, string>,
  checkoutAttemptId: string,
  funnelEventId: string,
  oneTimeConsentId?: string | null,
) {
  return (
    metadata.checkout_preparation_status === "claimed" &&
    metadata.checkout_attempt_id === checkoutAttemptId &&
    metadata.checkout_funnel_event_id === funnelEventId &&
    (!oneTimeConsentId || metadata.personal_plan_once_consent_id === oneTimeConsentId)
  )
}

export function preparedCheckoutClaimIdempotencyKey(preparationId: string) {
  return `offer-elements-claim:${preparationId}`
}

export function preparedCheckoutCreateIdempotencyKey(preparationId: string) {
  return `offer-elements-preparation:${preparationId}`
}

export function quizOfferMembershipCreateIdempotencyKey(checkoutAttemptId: string) {
  return `quiz-offer-membership:${checkoutAttemptId}`
}

type OneTimeConsentAttributionRow = {
  id: string
  lead_id: string
  funnel_session_id: string
  product_kind: string
  offer_variant: string
}

type OneTimeConsentFunnelSessionRow = {
  id: string
  lead_id: string | null
  visitor_id: string
  package_key: string
  offer_variant: string
  first_seen_at: string
}

type OneTimeConsentFunnelContext = FunnelCookieContext & {
  leadId: string
  offerVariant: "personal-plan-one-time-v1"
}

export function resolveOneTimeConsentFunnelContext(input: {
  consentId: string
  expectedLeadId: string | null
  expectedFunnelSessionId: string | null
  consent: OneTimeConsentAttributionRow | null
  funnelSession: OneTimeConsentFunnelSessionRow | null
}): OneTimeConsentFunnelContext | null {
  const { consent, funnelSession } = input
  if (
    !consent ||
    !funnelSession ||
    consent.id !== input.consentId ||
    consent.product_kind !== PERSONAL_PLAN_ONCE_KIND ||
    consent.offer_variant !== "personal-plan-one-time-v1" ||
    (input.expectedLeadId !== null && consent.lead_id !== input.expectedLeadId) ||
    (input.expectedFunnelSessionId !== null &&
      consent.funnel_session_id !== input.expectedFunnelSessionId) ||
    funnelSession.id !== consent.funnel_session_id ||
    funnelSession.lead_id !== consent.lead_id ||
    funnelSession.offer_variant !== consent.offer_variant
  ) {
    return null
  }

  const issuedAt = Date.parse(funnelSession.first_seen_at)
  if (!Number.isFinite(issuedAt)) return null
  return {
    visitorId: funnelSession.visitor_id,
    sessionId: funnelSession.id,
    packageKey: funnelSession.package_key,
    issuedAt,
    leadId: consent.lead_id,
    offerVariant: consent.offer_variant,
  }
}

export function canonicalOneTimeClaimMetadata(context: OneTimeConsentFunnelContext) {
  return {
    lead_id: context.leadId,
    funnel_session_id: context.sessionId,
    funnel_package_key: context.packageKey,
    offer_variant: context.offerVariant,
  }
}

export function hasCanonicalOneTimeClaimMetadata(
  metadata: Record<string, string>,
  context: OneTimeConsentFunnelContext,
) {
  return Object.entries(canonicalOneTimeClaimMetadata(context)).every(
    ([key, value]) => metadata[key] === value,
  )
}

export function canonicalOneTimeClaimMetadataPatch(
  metadata: Record<string, string>,
  context: OneTimeConsentFunnelContext,
): Record<string, string> | null {
  const patch: Record<string, string> = {}
  for (const [key, value] of Object.entries(canonicalOneTimeClaimMetadata(context))) {
    if (metadata[key] === undefined) {
      patch[key] = value
    } else if (metadata[key] !== value) {
      return null
    }
  }
  return patch
}

export function validatePreparedCheckoutCanonicalMetadataRepair(input: {
  metadata: Record<string, string>
  sessionStatus: string | null
  lineItemPriceId?: string
  preparationId: string
  preparationToken: string
  interval: CheckoutCommerceInterval
  priceId: string
  source: CheckoutRequestSource
  presentation?: "offer_overlay_elements"
  identityHash: string
  checkoutAttemptId: string
  funnelEventId: string
  oneTimeConsentId: string
  context: OneTimeConsentFunnelContext
}): { ok: true; patch: Record<string, string> } | { ok: false } {
  const expected = {
    checkout_preparation_id: input.preparationId,
    checkout_preparation_interval: input.interval,
    checkout_preparation_price_id: input.priceId,
    checkout_preparation_source: input.source,
    checkout_preparation_presentation: input.presentation ?? "",
    checkout_preparation_identity_hash: input.identityHash,
    checkout_preparation_status: "claimed",
    checkout_attempt_id: input.checkoutAttemptId,
    checkout_funnel_event_id: input.funnelEventId,
    personal_plan_once_consent_id: input.oneTimeConsentId,
  }
  const metadataMatches = Object.entries(expected).every(
    ([key, value]) => input.metadata[key] === value,
  )
  if (
    input.sessionStatus !== "complete" ||
    input.lineItemPriceId !== input.priceId ||
    !metadataMatches ||
    !hasMatchingToken(input.metadata.checkout_preparation_token_hash, input.preparationToken)
  ) {
    return { ok: false }
  }
  const patch = canonicalOneTimeClaimMetadataPatch(input.metadata, input.context)
  return patch ? { ok: true, patch } : { ok: false }
}

async function loadOneTimeConsentFunnelContext(input: {
  adminSupabase: ReturnType<typeof createBillingAdminClient>
  consentId: string
  expectedLeadId: string | null
  expectedFunnelSessionId: string | null
}): Promise<OneTimeConsentFunnelContext | null> {
  const { data: consent, error: consentError } = await input.adminSupabase
    .from("personal_plan_one_time_checkout_consents")
    .select("id, lead_id, funnel_session_id, product_kind, offer_variant")
    .eq("id", input.consentId)
    .maybeSingle()
  if (consentError || !consent) return null

  const { data: funnelSession, error: funnelSessionError } = await input.adminSupabase
    .from("funnel_sessions")
    .select("id, lead_id, visitor_id, package_key, offer_variant, first_seen_at")
    .eq("id", consent.funnel_session_id)
    .maybeSingle()
  if (funnelSessionError) return null

  return resolveOneTimeConsentFunnelContext({
    consentId: input.consentId,
    expectedLeadId: input.expectedLeadId,
    expectedFunnelSessionId: input.expectedFunnelSessionId,
    consent,
    funnelSession,
  })
}

export function resolvePreparedCheckoutPricing(input: {
  isOneTimePurchase: boolean
  lineItemPriceId?: string
  metadata: Record<string, string>
  requestedInterval: CheckoutCommerceInterval
}): {
  analyticsPlan: CheckoutAnalyticsPlan
  interval: CheckoutCommerceInterval
  priceId: string
  pricingCatalog?: SubscriptionPricingCatalog
} | null {
  const priceId = input.metadata.checkout_preparation_price_id
  if (!priceId || input.lineItemPriceId !== priceId) return null

  if (input.isOneTimePurchase) {
    if (
      input.requestedInterval !== "one_time" ||
      input.metadata.checkout_preparation_interval !== "one_time" ||
      priceId !== getPersonalPlanOnceStripePriceId()
    )
      return null
    return {
      analyticsPlan: PERSONAL_PLAN_ONCE_PRODUCT,
      interval: "one_time",
      priceId,
    }
  }

  if (input.requestedInterval === "one_time") return null
  const resolved = resolveStripePriceId(priceId)
  const storedPricingCatalog = input.metadata.checkout_preparation_pricing_catalog
  if (
    !resolved ||
    resolved.interval !== input.requestedInterval ||
    input.metadata.checkout_preparation_interval !== resolved.interval ||
    (storedPricingCatalog && storedPricingCatalog !== resolved.pricingCatalog) ||
    (resolved.pricingCatalog === "personal_plan_launch_v1" &&
      storedPricingCatalog !== resolved.pricingCatalog)
  )
    return null

  return {
    analyticsPlan: getStripePricingPlan(resolved.interval, resolved.pricingCatalog),
    interval: resolved.interval,
    priceId,
    pricingCatalog: resolved.pricingCatalog,
  }
}

async function claimPreparedCheckoutSession(input: {
  stripe: Stripe
  requestedInterval: CheckoutCommerceInterval
  isOneTimePurchase: boolean
  source: CheckoutRequestSource
  presentation?: "offer_overlay_elements"
  leadId: string | null
  userId?: string
  customerId?: string
  customerEmail?: string
  preparationId: string
  preparationToken: string
  preparedSessionId: string
  checkoutAttemptId: string
  funnelEventId: string
  cookieStore: Awaited<ReturnType<typeof cookies>>
  userIdForFunnel?: string
  isInternalTest: boolean
  oneTimeConsentId?: string | null
  adminSupabase?: ReturnType<typeof createBillingAdminClient>
  funnelSessionId?: string | null
}) {
  const preparedControlContext = () => ({
    commerceKind: input.isOneTimePurchase ? ("one_time" as const) : ("subscription" as const),
    isInternalTest: input.isInternalTest,
    leadId: input.leadId,
    checkoutAttemptId: input.checkoutAttemptId,
    source: input.source,
  })
  let session: Stripe.Checkout.Session
  try {
    session = await input.stripe.checkout.sessions.retrieve(input.preparedSessionId, {
      expand: ["line_items"],
    })
  } catch (error) {
    if (isDefinitivelyMissingStripeResource(error)) {
      return await preparedCheckoutUnavailable({
        ...preparedControlContext(),
        cause: "prepared_session_missing",
      })
    }
    throw error
  }

  const metadata = session.metadata ?? {}
  const identityHash = createPreparedCheckoutIdentityHash({
    authenticatedUserId: input.userId,
    resolvedLeadId: input.leadId,
    customerId: input.customerId,
    customerEmail: input.customerEmail,
  })
  const lineItemPrice = session.line_items?.data[0]?.price
  const resolvedLineItemPrice =
    typeof lineItemPrice === "string" ? lineItemPrice : lineItemPrice?.id
  const preparedPricing = resolvePreparedCheckoutPricing({
    isOneTimePurchase: input.isOneTimePurchase,
    lineItemPriceId: resolvedLineItemPrice,
    metadata,
    requestedInterval: input.requestedInterval,
  })
  if (!preparedPricing) {
    return await preparedCheckoutUnavailable({
      ...preparedControlContext(),
      cause: "prepared_pricing_missing",
    })
  }
  const oneTimeConsentFunnelContext =
    input.oneTimeConsentId && input.adminSupabase
      ? await loadOneTimeConsentFunnelContext({
          adminSupabase: input.adminSupabase,
          consentId: input.oneTimeConsentId,
          expectedLeadId: input.leadId,
          expectedFunnelSessionId: input.funnelSessionId ?? null,
        })
      : undefined
  if (input.oneTimeConsentId && !oneTimeConsentFunnelContext) {
    return await preparedCheckoutUnavailable({
      ...preparedControlContext(),
      cause: "consent_context_missing",
    })
  }
  const validation = validatePreparedCheckoutClaim({
    metadata,
    sessionStatus: session.status,
    expiresAt: preparedCheckoutApplicationExpiresAt(session.expires_at, session.created),
    nowSeconds: Math.floor(Date.now() / 1000),
    lineItemPriceId: resolvedLineItemPrice,
    preparationId: input.preparationId,
    preparationToken: input.preparationToken,
    interval: preparedPricing.interval,
    priceId: preparedPricing.priceId,
    source: input.source,
    presentation: input.presentation,
    identityHash,
    checkoutAttemptId: input.checkoutAttemptId,
    funnelEventId: input.funnelEventId,
    oneTimeConsentId: input.oneTimeConsentId,
  })
  if (!validation.ok) {
    if (input.oneTimeConsentId && oneTimeConsentFunnelContext) {
      const repairValidation = validatePreparedCheckoutCanonicalMetadataRepair({
        metadata,
        sessionStatus: session.status,
        lineItemPriceId: resolvedLineItemPrice,
        preparationId: input.preparationId,
        preparationToken: input.preparationToken,
        interval: preparedPricing.interval,
        priceId: preparedPricing.priceId,
        source: input.source,
        presentation: input.presentation,
        identityHash,
        checkoutAttemptId: input.checkoutAttemptId,
        funnelEventId: input.funnelEventId,
        oneTimeConsentId: input.oneTimeConsentId,
        context: oneTimeConsentFunnelContext,
      })
      if (repairValidation.ok) {
        const repaired = await repairCanonicalOneTimeClaimMetadata({
          stripe: input.stripe,
          sessionId: session.id,
          preparationId: input.preparationId,
          metadata,
          patch: repairValidation.patch,
        })
        if (!repaired || !hasCanonicalOneTimeClaimMetadata(repaired, oneTimeConsentFunnelContext)) {
          return await preparedCheckoutUnavailable({
            ...preparedControlContext(),
            cause: "canonical_metadata_repair_failed",
          })
        }
        if (input.adminSupabase) {
          await bindPersonalPlanOneTimeConsentProviderReference(
            input.adminSupabase,
            input.oneTimeConsentId,
            { stripeCheckoutSessionId: session.id },
          )
        }
        return NextResponse.json({ error: "checkout already completed" }, { status: 409 })
      }
    }
    return await preparedCheckoutUnavailable({
      ...preparedControlContext(),
      cause: "claim_validation_failed",
    })
  }

  if (validation.alreadyClaimed) {
    if (oneTimeConsentFunnelContext) {
      const patch = canonicalOneTimeClaimMetadataPatch(metadata, oneTimeConsentFunnelContext)
      if (!patch) {
        return await preparedCheckoutUnavailable({
          ...preparedControlContext(),
          cause: "canonical_metadata_repair_failed",
        })
      }
      const repaired = await repairCanonicalOneTimeClaimMetadata({
        stripe: input.stripe,
        sessionId: session.id,
        preparationId: input.preparationId,
        metadata,
        patch,
      })
      if (!repaired || !hasCanonicalOneTimeClaimMetadata(repaired, oneTimeConsentFunnelContext)) {
        return await preparedCheckoutUnavailable({
          ...preparedControlContext(),
          cause: "canonical_metadata_repair_failed",
        })
      }
    }
    if (input.oneTimeConsentId && input.adminSupabase) {
      await bindPersonalPlanOneTimeConsentProviderReference(
        input.adminSupabase,
        input.oneTimeConsentId,
        { stripeCheckoutSessionId: session.id },
      )
    }
    const funnelResult = await recordPreparedCheckoutStarted({
      interval: preparedPricing.interval,
      source: input.source,
      leadId: input.leadId,
      userId: input.userIdForFunnel,
      checkoutAttemptId: input.checkoutAttemptId,
      funnelEventId: input.funnelEventId,
      sessionId: session.id,
      analyticsPlan: preparedPricing.analyticsPlan,
      pricingCatalog: preparedPricing.pricingCatalog,
      cookieStore: input.cookieStore,
      funnelContext: oneTimeConsentFunnelContext ?? undefined,
    })
    const response = NextResponse.json({
      client_secret: session.client_secret,
      session_id: session.id,
      status: "claimed",
    })
    if (funnelResult.consumeTouch) {
      response.cookies.set(FUNNEL_TOUCH_COOKIE, "", { path: "/", maxAge: 0 })
    }
    return response
  }
  if (!session.client_secret) {
    return await preparedCheckoutUnavailable({
      ...preparedControlContext(),
      cause: "prepared_client_secret_missing",
    })
  }

  const funnelContextForMetadata =
    oneTimeConsentFunnelContext ??
    (await resolveFunnelCookieContext(input.cookieStore.get(FUNNEL_SESSION_COOKIE)?.value)) ??
    (await resolveFunnelContextForLead(input.leadId))
  let claimedSession: Stripe.Checkout.Session
  try {
    claimedSession = await input.stripe.checkout.sessions.update(
      session.id,
      {
        metadata: {
          ...metadata,
          checkout_preparation_status: "claimed",
          checkout_attempt_id: input.checkoutAttemptId,
          checkout_funnel_event_id: input.funnelEventId,
          ...(input.oneTimeConsentId
            ? { personal_plan_once_consent_id: input.oneTimeConsentId }
            : {}),
          ...(oneTimeConsentFunnelContext
            ? canonicalOneTimeClaimMetadata(oneTimeConsentFunnelContext)
            : funnelContextForMetadata
              ? {
                  funnel_session_id: funnelContextForMetadata.sessionId,
                  funnel_package_key: funnelContextForMetadata.packageKey,
                  ...("isInternalTest" in funnelContextForMetadata &&
                  typeof funnelContextForMetadata.isInternalTest === "boolean"
                    ? { is_internal_test: String(funnelContextForMetadata.isInternalTest) }
                    : {}),
                }
              : {}),
        },
      },
      { idempotencyKey: preparedCheckoutClaimIdempotencyKey(input.preparationId) },
    )
  } catch (error) {
    console.warn("[stripe] prepared checkout claim update unavailable", {
      preparationId: input.preparationId,
      error: error instanceof Error ? error.message : "unknown",
    })
    return await preparedCheckoutUnavailable({
      ...preparedControlContext(),
      cause: "claim_update_failed",
    })
  }
  if (
    !hasMatchingPreparedCheckoutClaim(
      claimedSession.metadata ?? {},
      input.checkoutAttemptId,
      input.funnelEventId,
      input.oneTimeConsentId,
    ) ||
    (oneTimeConsentFunnelContext &&
      !hasCanonicalOneTimeClaimMetadata(claimedSession.metadata ?? {}, oneTimeConsentFunnelContext))
  ) {
    return await preparedCheckoutUnavailable({
      ...preparedControlContext(),
      cause: "claim_metadata_mismatch",
    })
  }
  if (input.oneTimeConsentId && input.adminSupabase) {
    await bindPersonalPlanOneTimeConsentProviderReference(
      input.adminSupabase,
      input.oneTimeConsentId,
      { stripeCheckoutSessionId: session.id },
    )
  }
  const funnelResult = await recordPreparedCheckoutStarted({
    interval: preparedPricing.interval,
    source: input.source,
    leadId: input.leadId,
    userId: input.userIdForFunnel,
    checkoutAttemptId: input.checkoutAttemptId,
    funnelEventId: input.funnelEventId,
    sessionId: session.id,
    analyticsPlan: preparedPricing.analyticsPlan,
    pricingCatalog: preparedPricing.pricingCatalog,
    cookieStore: input.cookieStore,
    funnelContext: oneTimeConsentFunnelContext ?? undefined,
  })

  const response = NextResponse.json({
    client_secret: session.client_secret,
    session_id: session.id,
    status: "claimed",
  })
  if (funnelResult.consumeTouch) {
    response.cookies.set(FUNNEL_TOUCH_COOKIE, "", { path: "/", maxAge: 0 })
  }
  return response
}

async function repairCanonicalOneTimeClaimMetadata(input: {
  stripe: Stripe
  sessionId: string
  preparationId: string
  metadata: Record<string, string>
  patch: Record<string, string>
}): Promise<Record<string, string> | null> {
  if (Object.keys(input.patch).length === 0) return input.metadata
  try {
    const updatedSession = await input.stripe.checkout.sessions.update(
      input.sessionId,
      {
        metadata: {
          ...input.metadata,
          ...input.patch,
        },
      },
      { idempotencyKey: `${preparedCheckoutClaimIdempotencyKey(input.preparationId)}:canonical` },
    )
    return updatedSession.metadata ?? null
  } catch (error) {
    console.warn("[stripe] prepared checkout canonical metadata repair unavailable", {
      preparationId: input.preparationId,
      error: error instanceof Error ? error.message : "unknown",
    })
    return null
  }
}

async function recordPreparedCheckoutStarted(input: {
  interval: CheckoutCommerceInterval
  source: CheckoutRequestSource
  leadId: string | null
  userId?: string
  checkoutAttemptId: string
  funnelEventId: string
  sessionId: string
  analyticsPlan: CheckoutAnalyticsPlan
  pricingCatalog?: SubscriptionPricingCatalog
  cookieStore: Awaited<ReturnType<typeof cookies>>
  funnelContext?: FunnelCookieContext
}) {
  const funnelContext =
    input.funnelContext ??
    (await resolveFunnelCookieContext(input.cookieStore.get(FUNNEL_SESSION_COOKIE)?.value)) ??
    (await resolveFunnelContextForLead(input.leadId))
  if (!funnelContext) return { consumeTouch: false }
  const funnelTouch = await resolvePendingFunnelTouchValue(
    input.cookieStore.get(FUNNEL_TOUCH_COOKIE)?.value,
    funnelContext,
  )
  const funnelRecorded = await recordFunnelEvent({
    context: funnelContext,
    eventId: input.funnelEventId,
    milestone: "checkout_started",
    leadId: input.leadId,
    userId: input.userId,
    checkoutProvider: "stripe",
    checkoutReference: input.sessionId,
    touch: funnelTouch,
    properties: {
      source: input.source,
      interval: input.interval,
      checkout_attempt_id: input.checkoutAttemptId,
      currency: input.analyticsPlan.currency,
      plan_id: input.analyticsPlan.analyticsId,
      ...(input.pricingCatalog ? { pricing_catalog: input.pricingCatalog } : {}),
      value: input.analyticsPlan.amount,
    },
  })
    .then(() => true)
    .catch((error) => {
      console.warn("[funnel] prepared Stripe checkout claim tracking failed", error)
      return false
    })
  return { consumeTouch: Boolean(funnelTouch && funnelRecorded) }
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
