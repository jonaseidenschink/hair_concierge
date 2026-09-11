"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { Stripe } from "@stripe/stripe-js"

import {
  isPayPalCheckoutEnabled,
  PaymentMethodCheckout,
  type CheckoutFailure,
} from "@/components/checkout/payment-method-checkout"
import { OfferPaymentOverlay } from "@/components/checkout/offer-payment-overlay"
import { usePaymentRuntime } from "@/components/providers/payment-runtime-provider"
import { PersonalPlanOneTimeCheckout } from "@/components/checkout/personal-plan-one-time-checkout"
import {
  ActiveSubscriptionDialog,
  isCheckoutAccessAlreadyExistsResponse,
  readCheckoutAccessAlreadyExistsEmail,
} from "@/components/checkout/active-subscription-dialog"
import { PaymentFeedbackCard } from "@/components/checkout/payment-feedback-card"
import { usePaymentSupportReport } from "@/components/checkout/use-payment-support-report"
import { usePlanSelection } from "@/components/checkout/use-plan-selection"
import type { QuizResultReferencePrices } from "@/components/checkout/plan-reference-prices"
import { SubscriptionPlanSelector } from "@/components/checkout/subscription-plan-selector"
import {
  OFFER_PRICING_REVISION,
  useOfferTrackingContext,
} from "@/components/quiz/offer-tracking-provider"
import { trackAppEvent } from "@/lib/analytics/track-app-event"
import { claimOfferPaymentOptionView } from "@/lib/analytics/offer-payment-option-view"
import { observeOnceVisible } from "@/lib/analytics/observe-once-visible"
import {
  claimCheckoutOpenRequest,
  createCheckoutAttemptController,
  type CheckoutAttemptController,
  type CheckoutLifecycleClaim,
} from "@/lib/analytics/checkout-attempt"
import { createFunnelEventId, getCurrentFunnelContext } from "@/lib/funnel/client"
import {
  isOfferPaymentOverlayEnabled,
  isPaymentFeedbackV2Enabled,
  isPaymentSupportUiEnabled,
  isStripeExpressCheckoutEnabled,
} from "@/lib/funnel/flags"
import { paymentFeedback } from "@/lib/checkout/payment-feedback"
import type {
  CheckoutLifecycleDismissalReason,
  CheckoutLifecycleTransition,
  FunnelAnalyticsEnvelope,
  OfferPaymentOption,
  OfferPaymentOptionProvider,
} from "@/lib/analytics/events"
import { getOfferStripePromise } from "@/lib/stripe/offer-client-loader"
import { resolvePersonalPlanPricingMode } from "@/lib/funnel/personal-plan-pricing-experiment"
import type { BillingInterval } from "@/lib/stripe/intervals"

export function isUnexpectedCheckoutNavigationPath(expectedPathname: string, nextPathname: string) {
  if (nextPathname === expectedPathname) return false
  return !/^\/(?:welcome|datenschutz|impressum|agb|widerruf|kontakt)(?:\/|$)/.test(nextPathname)
}
import {
  DEFAULT_PRICING_INTERVAL,
  getStripePricingPlan,
  getStripePricingPlans,
  type SubscriptionPricingCatalog,
} from "@/lib/stripe/pricing-plans"
import { PERSONAL_PLAN_ONCE_PRODUCT } from "@/lib/billing/offer-products"
import { capturePaymentFailure, type PaymentErrorFamily } from "@/lib/observability/payment-client"

const stripePublishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim()
const unloadedStripePromise = Promise.resolve(null)
const checkoutStartError = "Zahlung konnte nicht gestartet werden. Bitte versuche es erneut."
const personalPlanOneTimeCommerce = {
  commerceKind: "one_time",
  currency: PERSONAL_PLAN_ONCE_PRODUCT.currency,
  planId: PERSONAL_PLAN_ONCE_PRODUCT.analyticsId,
  purchaseKind: "personal_plan_once",
  value: PERSONAL_PLAN_ONCE_PRODUCT.amount,
} as const
const personalPlanOneTimeReferencePriceLabel = `€${PERSONAL_PLAN_ONCE_PRODUCT.plannedRegularPrice
  .toFixed(2)
  .replace(".", ",")}`
type LockedCheckoutProvider = "stripe" | "paypal"

export const OFFER_CHECKOUT_OVERLAY_VISIBILITY_TIMEOUT_MS = 5_000

type OverlayPresentationWatchdog = {
  markVisible: () => void
  start: () => void
  stop: () => void
}

type OverlayPresentationWatchdogDependencies = {
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
  setTimeout?: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>
  timeoutMs?: number
}

/**
 * Watches presentation only. The timer never changes checkout state, routing, or animation.
 */
export function createOverlayPresentationWatchdog(
  onTimeout: () => void,
  dependencies: OverlayPresentationWatchdogDependencies = {},
): OverlayPresentationWatchdog {
  const schedule = dependencies.setTimeout ?? window.setTimeout
  const cancel = dependencies.clearTimeout ?? window.clearTimeout
  const timeoutMs = dependencies.timeoutMs ?? OFFER_CHECKOUT_OVERLAY_VISIBILITY_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let resolved = false

  const clear = () => {
    if (timer === null) return
    cancel(timer)
    timer = null
  }

  return {
    markVisible() {
      resolved = true
      clear()
    },
    start() {
      if (resolved || timer !== null) return
      timer = schedule(() => {
        timer = null
        if (resolved) return
        resolved = true
        onTimeout()
      }, timeoutMs)
    },
    stop: clear,
  }
}

function useCheckoutOverlayPresentationIntegrity({
  attemptId,
  attempts,
  commerceKind,
  interval,
  isInternalTest,
  leadId,
  live,
  open,
  plan,
  trackLifecycle,
}: {
  attemptId: string | null
  attempts: CheckoutAttemptController
  commerceKind: "one_time" | "subscription"
  interval?: BillingInterval
  isInternalTest: boolean
  leadId: string | null
  live: boolean
  open: boolean
  plan: string
  trackLifecycle: (
    checkoutAttemptId: string,
    claim: Omit<CheckoutLifecycleClaim, "checkoutAttemptId" | "lastState" | "openIndex"> & {
      lastState?: CheckoutLifecycleClaim["lastState"]
      openIndex?: number
    },
  ) => void
}) {
  const watchdogRef = useRef<OverlayPresentationWatchdog | null>(null)
  const reportingRef = useRef(new Set<string>())

  const reportPresentationFailure = useCallback(
    (
      checkoutAttemptId: string,
      openIndex: number,
      failureReason: "overlay_not_visible" | "unexpected_route",
    ) => {
      const key = `${checkoutAttemptId}:${openIndex}:${failureReason}`
      if (reportingRef.current.has(key)) return
      reportingRef.current.add(key)
      const isUnexpectedRoute = failureReason === "unexpected_route"
      trackLifecycle(checkoutAttemptId, {
        endReason: isUnexpectedRoute ? "unexpected_navigation" : undefined,
        failureReason,
        openIndex,
        transition: isUnexpectedRoute ? "unexpected_navigation" : "overlay_visibility_timeout",
      })
      capturePaymentFailure({
        signal: "checkout_experience_degraded",
        provider: "unknown",
        boundary: isUnexpectedRoute ? "navigation" : "presentation",
        errorFamily: isUnexpectedRoute ? "navigation" : "presentation",
        commerceKind,
        origin: "browser",
        method: "unknown",
        truth: "unknown",
        live,
        isInternalTest,
        retryable: "true",
        checkoutAttemptId,
        leadId,
        source: "quiz_result_offer",
        interval,
        plan,
        durationMs: isUnexpectedRoute ? undefined : OFFER_CHECKOUT_OVERLAY_VISIBILITY_TIMEOUT_MS,
        status: failureReason,
        providerReferencePresent: false,
      })
    },
    [commerceKind, interval, isInternalTest, leadId, live, plan, trackLifecycle],
  )

  useEffect(() => {
    if (!open || !attemptId) return
    const openIndex = attempts.openIndex() ?? 1
    const watchdog = createOverlayPresentationWatchdog(() =>
      reportPresentationFailure(attemptId, openIndex, "overlay_not_visible"),
    )
    watchdogRef.current = watchdog
    watchdog.start()
    return () => {
      watchdog.stop()
      if (watchdogRef.current === watchdog) watchdogRef.current = null
    }
  }, [attemptId, attempts, open, reportPresentationFailure])

  useEffect(() => {
    if (!open || !attemptId) return
    const expectedPathname = window.location.pathname
    const openIndex = attempts.openIndex() ?? 1
    const reportUnexpectedRoute = () => {
      if (!isUnexpectedCheckoutNavigationPath(expectedPathname, window.location.pathname)) return
      reportPresentationFailure(attemptId, openIndex, "unexpected_route")
    }
    const originalPushState = window.history.pushState
    const originalReplaceState = window.history.replaceState
    const observedPushState: History["pushState"] = function (...args) {
      originalPushState.apply(window.history, args)
      reportUnexpectedRoute()
    }
    const observedReplaceState: History["replaceState"] = function (...args) {
      originalReplaceState.apply(window.history, args)
      reportUnexpectedRoute()
    }
    window.history.pushState = observedPushState
    window.history.replaceState = observedReplaceState
    window.addEventListener("popstate", reportUnexpectedRoute)
    window.addEventListener("pagehide", reportUnexpectedRoute)
    return () => {
      window.removeEventListener("popstate", reportUnexpectedRoute)
      window.removeEventListener("pagehide", reportUnexpectedRoute)
      if (window.history.pushState === observedPushState) {
        window.history.pushState = originalPushState
      }
      if (window.history.replaceState === observedReplaceState) {
        window.history.replaceState = originalReplaceState
      }
    }
  }, [attemptId, attempts, open, reportPresentationFailure])

  return useCallback(
    (state: "mounted" | "visible") => {
      if (!attemptId) return
      const openIndex = attempts.openIndex() ?? 1
      if (state === "visible") watchdogRef.current?.markVisible()
      trackLifecycle(attemptId, {
        openIndex,
        transition: state === "mounted" ? "overlay_mounted" : "overlay_visible",
      })
    },
    [attemptId, attempts, trackLifecycle],
  )
}

function mapOverlayDismissalReason(
  reason: "x" | "backdrop" | "escape" | "handle_drag" | "browser_back" | "close" | "plan_change",
): CheckoutLifecycleDismissalReason {
  switch (reason) {
    case "x":
    case "close":
      return "close_button"
    case "handle_drag":
      return "drag_handle"
    case "browser_back":
      return "system_back"
    case "plan_change":
      return "plan_changed"
    case "backdrop":
    case "escape":
      return reason
  }
}

function classifyOfferStripeFailure(failure: CheckoutFailure): PaymentErrorFamily {
  if (failure.failureStage === "configuration") return "configuration"
  if (failure.errorCode.includes("network")) return "network"
  if (failure.errorCode.includes("timeout")) return "timeout"
  if (failure.errorCode.includes("load")) return "provider_unavailable"
  return "provider_session"
}

export function trackStripeJsAvailability(
  stripePromise: Promise<Stripe | null>,
  onFailure: (failure: CheckoutFailure) => void,
) {
  void stripePromise
    .then((stripe) => {
      if (stripe) return
      onFailure({
        errorCode: "stripe_js_unavailable",
        failureStage: "provider_session",
        retryable: true,
      })
    })
    .catch(() => {
      onFailure({
        errorCode: "stripe_js_load_failed",
        failureStage: "provider_session",
        retryable: true,
      })
    })
}

export function shouldRotateStripeSessionAttemptOnRetry(
  failure: "network" | "provider_response" | "invalid_payload",
) {
  return failure !== "network"
}

export type ResultOfferPricingCheckoutSummary =
  | {
      commerceKind: "membership"
      interval: BillingInterval
      planName: string
      priceLabel: string
      stickyLine: string
    }
  | {
      commerceKind: "one_time"
      planName: string
      priceLabel: string
      referencePriceLabel: string
      stickyLine: string
    }

export function getMembershipCheckoutSummary(
  interval: BillingInterval,
  pricingCatalog: SubscriptionPricingCatalog = "standard",
): ResultOfferPricingCheckoutSummary {
  const plan = getStripePricingPlan(interval, pricingCatalog)
  return {
    commerceKind: "membership",
    interval,
    planName: plan.name,
    priceLabel: plan.price,
    stickyLine: `${plan.name} · ${plan.price}`,
  }
}

export function getPersonalPlanOneTimeCheckoutSummary(): ResultOfferPricingCheckoutSummary {
  return {
    commerceKind: "one_time",
    planName: "Haarplan",
    priceLabel: "29,99 €",
    referencePriceLabel: `${personalPlanOneTimeReferencePriceLabel.replace("€", "")} €`,
    stickyLine: "Haarplan · 29,99 €",
  }
}

export function claimOfferProviderLock(
  current: LockedCheckoutProvider | null,
  requested: LockedCheckoutProvider,
) {
  return current && current !== requested
    ? { accepted: false, provider: current }
    : { accepted: true, provider: requested }
}

export function releaseOfferProviderLock(
  current: LockedCheckoutProvider | null,
  requested: LockedCheckoutProvider,
) {
  return current !== requested
    ? { accepted: false, provider: current }
    : { accepted: true, provider: null }
}

export function ResultOfferPricing(props: {
  checkoutPresentationFixture?: { expressElements: boolean; overlay: boolean }
  leadId: string | null
  onCheckoutOpen?: () => void
  onCheckoutSummaryChange?: (summary: ResultOfferPricingCheckoutSummary) => void
  onPricingReached?: () => void
  offerTracking?: FunnelAnalyticsEnvelope | null
  offerVariant?: string
  openCheckoutRequestId?: number
  pricingCatalog?: SubscriptionPricingCatalog
  referencePrices?: QuizResultReferencePrices
}) {
  const offerContext = useOfferTrackingContext()
  const offerVariant = props.offerVariant ?? offerContext?.offerVariant ?? "personal-plan-v1"
  if (resolvePersonalPlanPricingMode(offerVariant) === "one_time") {
    const expressElementsEnabled = props.checkoutPresentationFixture
      ? props.checkoutPresentationFixture.overlay &&
        props.checkoutPresentationFixture.expressElements
      : isOfferPaymentOverlayEnabled() && isStripeExpressCheckoutEnabled()
    return (
      <PersonalPlanOneTimePricing
        expressElementsEnabled={expressElementsEnabled}
        leadId={props.leadId}
        funnelSessionId={offerContext?.funnelSessionId}
        onCheckoutOpen={props.onCheckoutOpen}
        onCheckoutSummaryChange={props.onCheckoutSummaryChange}
        onPricingReached={props.onPricingReached}
        openCheckoutRequestId={props.openCheckoutRequestId}
      />
    )
  }
  return <MembershipResultOfferPricing {...props} />
}

function PersonalPlanOneTimePricing({
  expressElementsEnabled,
  funnelSessionId,
  leadId,
  onCheckoutOpen,
  onCheckoutSummaryChange,
  onPricingReached,
  openCheckoutRequestId,
}: {
  expressElementsEnabled: boolean
  funnelSessionId: string | null | undefined
  leadId: string | null
  onCheckoutOpen?: () => void
  onCheckoutSummaryChange?: (summary: ResultOfferPricingCheckoutSummary) => void
  onPricingReached?: () => void
  openCheckoutRequestId?: number
}) {
  const { stripeLive } = usePaymentRuntime()
  const pricingRef = useRef<HTMLDivElement | null>(null)
  const trackedRef = useRef(false)
  const handledRequestsRef = useRef(new Set<number>())
  const attemptsRef = useRef<CheckoutAttemptController | null>(null)
  const attemptStartedAtRef = useRef(0)
  const lastLifecycleTransitionRef = useRef<"none" | CheckoutLifecycleTransition>("none")
  const lastDismissalReasonRef =
    useRef<ReturnType<typeof mapOverlayDismissalReason>>("close_button")
  attemptsRef.current ??= createCheckoutAttemptController(createFunnelEventId)
  const attempts = attemptsRef.current
  const [open, setOpen] = useState(false)
  const [attemptId, setAttemptId] = useState<string | null>(null)
  const [engaged, setEngaged] = useState(false)
  const offerContext = useOfferTrackingContext()

  useEffect(
    () => onCheckoutSummaryChange?.(getPersonalPlanOneTimeCheckoutSummary()),
    [onCheckoutSummaryChange],
  )
  useEffect(() => {
    if (!pricingRef.current || trackedRef.current) return
    return observeOnceVisible(pricingRef.current, () => {
      if (trackedRef.current) return
      trackedRef.current = true
      const fallback = getCurrentFunnelContext()
      trackAppEvent("pricing_viewed", {
        ...(offerContext ?? {}),
        ...personalPlanOneTimeCommerce,
        funnelEventId: createFunnelEventId(),
        funnelPackageKey: offerContext?.funnelPackageKey ?? fallback?.funnelPackageKey,
        funnelSessionId: offerContext?.funnelSessionId ?? fallback?.funnelSessionId,
        leadId: leadId ?? undefined,
        pricingRevision: OFFER_PRICING_REVISION,
        source: "quiz_result_offer_pricing",
      })
      onPricingReached?.()
    })
  }, [leadId, offerContext, onPricingReached])

  const trackCheckoutLifecycle = useCallback(
    (
      checkoutAttemptId: string,
      claim: Omit<CheckoutLifecycleClaim, "checkoutAttemptId" | "lastState" | "openIndex"> & {
        lastState?: CheckoutLifecycleClaim["lastState"]
        openIndex?: number
      },
    ) => {
      const openIndex = claim.openIndex ?? attempts.openIndex() ?? 1
      const lifecycleClaim: CheckoutLifecycleClaim = {
        ...claim,
        checkoutAttemptId,
        lastState: claim.lastState ?? lastLifecycleTransitionRef.current,
        openIndex,
      }
      if (!attempts.claimLifecycle(lifecycleClaim)) return
      trackAppEvent("offer_checkout_lifecycle", {
        checkoutAttemptId,
        checkoutPresentation: "overlay",
        commerceKind: "one_time",
        elapsedMs: Math.max(0, Date.now() - attemptStartedAtRef.current),
        dismissalReason: lifecycleClaim.dismissalReason,
        endReason: lifecycleClaim.endReason,
        failureReason: lifecycleClaim.failureReason,
        lastState: lifecycleClaim.lastState,
        openIndex,
        option: lifecycleClaim.option,
        provider: lifecycleClaim.provider,
        recoveryReason: lifecycleClaim.recoveryReason,
        transition: lifecycleClaim.transition,
      })
      lastLifecycleTransitionRef.current = lifecycleClaim.transition
    },
    [attempts],
  )
  const onOverlayPresentationStateChange = useCheckoutOverlayPresentationIntegrity({
    attemptId,
    attempts,
    commerceKind: "one_time",
    isInternalTest: Boolean(offerContext?.isInternalTest),
    leadId,
    live: stripeLive,
    open,
    plan: PERSONAL_PLAN_ONCE_PRODUCT.analyticsId,
    trackLifecycle: trackCheckoutLifecycle,
  })
  const hideCheckout = useCallback(() => {
    if (!attemptId) {
      setOpen(false)
      setEngaged(false)
      return
    }
    attempts.hide()
    setOpen(false)
    setEngaged(false)
    trackCheckoutLifecycle(attemptId, {
      dismissalReason: lastDismissalReasonRef.current,
      transition: "dismissed",
    })
  }, [attemptId, attempts, trackCheckoutLifecycle])
  const endCheckout = useCallback(
    ({
      dismissalReason,
      endReason = "plan_changed",
    }: {
      dismissalReason?: CheckoutLifecycleDismissalReason
      endReason?: CheckoutLifecycleClaim["endReason"]
    } = {}) => {
      if (attemptId) {
        const normalizedDismissalReason =
          dismissalReason ?? (endReason === "plan_changed" ? "plan_changed" : undefined)
        if (normalizedDismissalReason) {
          trackCheckoutLifecycle(attemptId, {
            dismissalReason: normalizedDismissalReason,
            transition: "dismissed",
          })
        }
        trackCheckoutLifecycle(attemptId, {
          endReason,
          transition: "attempt_ended",
        })
      }
      attempts.end()
      setOpen(false)
      setAttemptId(null)
      setEngaged(false)
      lastLifecycleTransitionRef.current = "none"
      attemptStartedAtRef.current = 0
    },
    [attemptId, attempts, trackCheckoutLifecycle],
  )
  const openCheckout = useCallback(() => {
    if (open) return
    if (attemptId) {
      const resumed = attempts.resume()
      setOpen(true)
      setEngaged(false)
      if (resumed) {
        trackCheckoutLifecycle(resumed.checkoutAttemptId, {
          openIndex: attempts.openIndex() ?? 1,
          transition: "resumed",
        })
      }
      onCheckoutOpen?.()
      return
    }
    const next = attempts.open()
    const nextAttemptId = next.checkoutAttemptId
    attemptStartedAtRef.current = Date.now()
    lastLifecycleTransitionRef.current = "none"
    const openIndex = attempts.openIndex() ?? 1
    if (offerContext)
      trackAppEvent("offer_checkout_opened", {
        ...offerContext,
        ...personalPlanOneTimeCommerce,
        availableProviders: [
          ...(expressElementsEnabled && stripePublishableKey ? ["stripe"] : []),
          ...(isPayPalCheckoutEnabled() && process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID?.trim()
            ? ["paypal"]
            : []),
        ],
        checkoutAttemptId: nextAttemptId,
        checkoutPresentation: "overlay",
        funnelEventId: createFunnelEventId(),
        openIndex,
      })
    trackCheckoutLifecycle(nextAttemptId, {
      lastState: "none",
      openIndex,
      transition: "opened",
    })
    setAttemptId(nextAttemptId)
    setOpen(true)
    onCheckoutOpen?.()
  }, [
    attemptId,
    attempts,
    expressElementsEnabled,
    offerContext,
    onCheckoutOpen,
    open,
    trackCheckoutLifecycle,
  ])
  useEffect(() => {
    if (!claimCheckoutOpenRequest(handledRequestsRef.current, openCheckoutRequestId)) return
    const timer = window.setTimeout(openCheckout, 0)
    return () => window.clearTimeout(timer)
  }, [openCheckout, openCheckoutRequestId])
  useEffect(() => {
    if (!attemptId) return
    return () => {
      trackCheckoutLifecycle(attemptId, {
        endReason: "page_teardown",
        transition: "attempt_ended",
      })
      attempts.end()
    }
  }, [attemptId, attempts, trackCheckoutLifecycle])

  return (
    <div ref={pricingRef} className="space-y-4" data-personal-plan-pricing-mode="one_time">
      <p className="text-center text-xs font-extrabold uppercase tracking-[0.16em] text-[rgba(var(--brand-plum-rgb),0.60)]">
        Einmalige Erstellung
      </p>
      <div className="rounded-[16px] border border-[var(--brand-plum)] bg-white p-5 shadow-[0_16px_40px_-28px_rgba(var(--brand-plum-rgb),0.45)] sm:p-6">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-[17px] font-bold text-[var(--brand-plum-darkest)]">
            Persönlicher Haarplan
          </h3>
          <span className="flex flex-col items-end gap-1">
            <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Launch-Preis
            </span>
            <span className="flex items-baseline gap-2">
              <s className="text-sm font-medium text-muted-foreground">
                {personalPlanOneTimeReferencePriceLabel}
              </s>
              <strong className="text-[22px] text-[var(--brand-plum-darkest)]">€29,99</strong>
            </span>
          </span>
        </div>
        <ul className="mt-5 grid gap-3 text-sm leading-5 text-[var(--brand-plum-darkest)]">
          {[
            "Auf dein Haar, deine Ziele und Bedürfnisse abgestimmt",
            "Komplette Routine mit passenden Produkten",
            "Analyse deiner aktuellen Pflege",
          ].map((item) => (
            <li className="flex gap-3" key={item}>
              <span aria-hidden="true" className="font-bold text-[var(--brand-plum)]">
                ✓
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        onClick={openCheckout}
        className="min-h-[54px] w-full rounded-[12px] bg-[var(--brand-coral)] px-5 py-3 text-[14px] font-bold text-white shadow-[0_8px_24px_-16px_rgba(var(--brand-coral-rgb),0.65)]"
      >
        Haarplan für €29,99 freischalten
      </button>
      <div className="space-y-2 text-center text-[11px] leading-relaxed text-[var(--text-caption)]">
        <p>14 Tage Geld-zurück-Garantie · Einmalzahlung · Kein Abo</p>
        <p>PayPal · Apple Pay (auf unterstützten Geräten) · Visa · Mastercard</p>
        <p>
          Zahlungsdaten verarbeitet dein gewählter Anbieter.{" "}
          <a className="underline underline-offset-2" href="/datenschutz">
            Mehr zum Datenschutz.
          </a>
        </p>
      </div>
      <OfferPaymentOverlay
        checkoutEngaged={engaged}
        keepMounted={Boolean(attemptId)}
        onConfirmedAbort={() =>
          engaged
            ? endCheckout({
                dismissalReason: lastDismissalReasonRef.current,
                endReason: "customer_aborted",
              })
            : hideCheckout()
        }
        onConfirmedPlanChange={() => endCheckout({ endReason: "plan_changed" })}
        onDismissRequest={(reason) => {
          lastDismissalReasonRef.current = mapOverlayDismissalReason(reason)
        }}
        onPresentationStateChange={onOverlayPresentationStateChange}
        open={open}
        planName="Persönlicher Haarplan"
        priceLabel="29,99 €"
      >
        {({ requestDismissal }) =>
          attemptId ? (
            <PersonalPlanOneTimeCheckout
              checkoutAttemptId={attemptId}
              funnelSessionId={funnelSessionId}
              leadId={leadId}
              onCheckoutLifecycle={(claim) => trackCheckoutLifecycle(attemptId, claim)}
              onFirstPaymentEngagement={() => setEngaged(true)}
              onRequestClose={() => requestDismissal("close")}
              stripeElementsEnabled={expressElementsEnabled}
              visible={open}
            />
          ) : null
        }
      </OfferPaymentOverlay>
    </div>
  )
}

function MembershipResultOfferPricing({
  checkoutPresentationFixture,
  leadId,
  onCheckoutOpen,
  onCheckoutSummaryChange,
  onPricingReached,
  offerTracking,
  openCheckoutRequestId,
  pricingCatalog = "standard",
  referencePrices,
}: {
  checkoutPresentationFixture?: { expressElements: boolean; overlay: boolean }
  leadId: string | null
  onCheckoutOpen?: () => void
  onCheckoutSummaryChange?: (summary: ResultOfferPricingCheckoutSummary) => void
  onPricingReached?: () => void
  offerTracking?: FunnelAnalyticsEnvelope | null
  offerVariant?: string
  openCheckoutRequestId?: number
  pricingCatalog?: SubscriptionPricingCatalog
  referencePrices?: QuizResultReferencePrices
}) {
  const { stripeLive } = usePaymentRuntime()
  const pricingRef = useRef<HTMLDivElement | null>(null)
  const inlineCheckoutRef = useRef<HTMLDivElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const trackedRef = useRef(false)
  const handledRequestsRef = useRef(new Set<number>())
  const lockRef = useRef<LockedCheckoutProvider | null>(null)
  const selectionIndexRef = useRef(0)
  const optionViewsRef = useRef(new Set<string>())
  const stripeFunnelEventRef = useRef<{ attemptId: string; funnelEventId: string } | null>(null)
  const rotateStripeSessionAttemptOnRetryRef = useRef(true)
  const membershipAttemptStartedAtRef = useRef(0)
  const membershipLastLifecycleTransitionRef = useRef<"none" | CheckoutLifecycleTransition>("none")
  const membershipLastDismissalReasonRef =
    useRef<ReturnType<typeof mapOverlayDismissalReason>>("close_button")
  const attemptsRef = useRef<CheckoutAttemptController | null>(null)
  attemptsRef.current ??= createCheckoutAttemptController(createFunnelEventId)
  const attempts = attemptsRef.current
  const offerContext = useOfferTrackingContext()
  const { selectedInterval, selectPlan } = usePlanSelection({
    defaultInterval: DEFAULT_PRICING_INTERVAL,
  })
  const [checkoutInterval, setCheckoutInterval] = useState<BillingInterval | null>(null)
  const [checkoutVisible, setCheckoutVisible] = useState(false)
  const [attemptId, setAttemptId] = useState<string | null>(null)
  const [checkoutSessionAttemptId, setCheckoutSessionAttemptId] = useState<string | null>(null)
  const [lockedProvider, setLockedProvider] = useState<LockedCheckoutProvider | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stripe, setStripe] = useState<Promise<Stripe | null>>(unloadedStripePromise)
  const [duplicateEmail, setDuplicateEmail] = useState<string | null>(null)
  const [duplicateOpen, setDuplicateOpen] = useState(false)
  const [engaged, setEngaged] = useState(false)
  const overlay = checkoutPresentationFixture?.overlay ?? isOfferPaymentOverlayEnabled()
  const express =
    overlay && (checkoutPresentationFixture?.expressElements ?? isStripeExpressCheckoutEnabled())
  const duplicateFeedback = duplicateOpen
    ? paymentFeedback("access_already_active", {
        provider: "checkout",
        method: "unknown",
        accessAction: "login",
      })
    : null
  const duplicateReport = usePaymentSupportReport({
    checkoutAttemptId: attemptId,
    checkoutContext: "result_membership",
    feedback: duplicateFeedback,
  })

  useEffect(
    () => onCheckoutSummaryChange?.(getMembershipCheckoutSummary(selectedInterval, pricingCatalog)),
    [onCheckoutSummaryChange, pricingCatalog, selectedInterval],
  )
  useEffect(() => {
    if (!pricingRef.current || trackedRef.current) return
    return observeOnceVisible(pricingRef.current, () => {
      if (trackedRef.current) return
      trackedRef.current = true
      const fallback = offerTracking ?? getCurrentFunnelContext()
      trackAppEvent("pricing_viewed", {
        ...(offerContext ?? {}),
        availableIntervals: getStripePricingPlans(pricingCatalog).map((plan) => plan.interval),
        leadId: leadId ?? undefined,
        pricingCatalog,
        pricingRevision: OFFER_PRICING_REVISION,
        selectedInterval,
        source: "quiz_result_offer_pricing",
        funnelEventId: createFunnelEventId(),
        funnelSessionId: offerContext?.funnelSessionId ?? fallback?.funnelSessionId,
        funnelPackageKey: offerContext?.funnelPackageKey ?? fallback?.funnelPackageKey,
      })
      onPricingReached?.()
    })
  }, [leadId, offerContext, offerTracking, onPricingReached, pricingCatalog, selectedInterval])

  const resetLock = useCallback(() => {
    lockRef.current = null
    setLockedProvider(null)
  }, [])
  const claimLock = useCallback((provider: LockedCheckoutProvider) => {
    const next = claimOfferProviderLock(lockRef.current, provider)
    if (next.accepted) {
      lockRef.current = next.provider
      setLockedProvider(next.provider)
    }
    return next.accepted
  }, [])
  const releaseLock = useCallback((provider: LockedCheckoutProvider) => {
    const next = releaseOfferProviderLock(lockRef.current, provider)
    if (next.accepted) {
      lockRef.current = next.provider
      setLockedProvider(next.provider)
    }
    return next.accepted
  }, [])
  const trackCheckoutLifecycle = useCallback(
    (
      checkoutAttemptId: string,
      claim: Omit<CheckoutLifecycleClaim, "checkoutAttemptId" | "lastState" | "openIndex"> & {
        lastState?: CheckoutLifecycleClaim["lastState"]
        openIndex?: number
      },
    ) => {
      const openIndex = claim.openIndex ?? attempts.openIndex() ?? 1
      const lifecycleClaim: CheckoutLifecycleClaim = {
        ...claim,
        checkoutAttemptId,
        lastState: claim.lastState ?? membershipLastLifecycleTransitionRef.current,
        openIndex,
      }
      if (!attempts.claimLifecycle(lifecycleClaim)) return
      trackAppEvent("offer_checkout_lifecycle", {
        checkoutAttemptId,
        checkoutPresentation: overlay ? "overlay" : "inline",
        commerceKind: "subscription",
        elapsedMs: Math.max(0, Date.now() - membershipAttemptStartedAtRef.current),
        dismissalReason: lifecycleClaim.dismissalReason,
        endReason: lifecycleClaim.endReason,
        failureReason: lifecycleClaim.failureReason,
        lastState: lifecycleClaim.lastState,
        openIndex,
        option: lifecycleClaim.option,
        provider: lifecycleClaim.provider,
        recoveryReason: lifecycleClaim.recoveryReason,
        transition: lifecycleClaim.transition,
      })
      membershipLastLifecycleTransitionRef.current = lifecycleClaim.transition
    },
    [attempts, overlay],
  )
  const onOverlayPresentationStateChange = useCheckoutOverlayPresentationIntegrity({
    attemptId,
    attempts,
    commerceKind: "subscription",
    interval: checkoutInterval ?? selectedInterval,
    isInternalTest: Boolean(offerContext?.isInternalTest),
    leadId,
    live: stripeLive,
    open: overlay && checkoutVisible,
    plan: getStripePricingPlan(checkoutInterval ?? selectedInterval, pricingCatalog).analyticsId,
    trackLifecycle: trackCheckoutLifecycle,
  })
  const reportFailure = useCallback(
    (
      failure: CheckoutFailure,
      provider: "stripe" | "paypal",
      interval = checkoutInterval,
      id = attemptId,
    ) => {
      if (
        !interval ||
        !id ||
        !attempts.claimFailure(id, provider, failure.failureStage, failure.errorCode)
      )
        return
      const plan = getStripePricingPlan(interval, pricingCatalog)
      if (provider === "stripe" && failure.failureStage !== "duplicate_access")
        capturePaymentFailure({
          signal: "customer_payment_error_observed",
          provider: "stripe",
          stage:
            failure.failureStage === "configuration"
              ? "stripe_checkout_session_create"
              : "stripe_embedded_checkout_client_secret",
          errorFamily: classifyOfferStripeFailure(failure),
          commerceKind: "subscription",
          origin: "browser",
          method: "unknown",
          truth: "unknown",
          live: stripeLive,
          isInternalTest: Boolean(offerContext?.isInternalTest),
          retryable: String(failure.retryable) as "true" | "false",
          source: "quiz_result_offer",
          interval,
          plan: plan.analyticsId,
          checkoutAttemptId: id,
          leadId,
          providerReferencePresent: false,
        })
      if (offerContext)
        trackAppEvent("checkout_start_failed", {
          ...offerContext,
          checkoutAttemptId: id,
          currency: plan.currency,
          ...failure,
          funnelEventId: createFunnelEventId(),
          interval,
          planId: plan.analyticsId,
          pricingCatalog,
          provider,
          value: plan.amount,
        })
    },
    [attemptId, attempts, checkoutInterval, leadId, offerContext, pricingCatalog, stripeLive],
  )

  const endCheckout = useCallback(
    ({
      dismissalReason,
      endReason = "plan_changed",
      focusPlan = false,
    }: {
      dismissalReason?: CheckoutLifecycleDismissalReason
      endReason?: CheckoutLifecycleClaim["endReason"]
      focusPlan?: boolean
    } = {}) => {
      returnFocusRef.current = focusPlan
        ? (pricingRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ??
          null)
        : null
      if (attemptId) {
        const normalizedDismissalReason =
          dismissalReason ?? (endReason === "plan_changed" ? "plan_changed" : undefined)
        if (normalizedDismissalReason) {
          trackCheckoutLifecycle(attemptId, {
            dismissalReason: normalizedDismissalReason,
            transition: "dismissed",
          })
        }
        trackCheckoutLifecycle(attemptId, {
          endReason,
          transition: "attempt_ended",
        })
      }
      attempts.end()
      resetLock()
      setAttemptId(null)
      setCheckoutSessionAttemptId(null)
      setCheckoutInterval(null)
      setCheckoutVisible(false)
      setEngaged(false)
      setError(null)
      membershipLastLifecycleTransitionRef.current = "none"
      membershipAttemptStartedAtRef.current = 0
    },
    [attemptId, attempts, resetLock, trackCheckoutLifecycle],
  )
  const close = useCallback(
    ({ focusPlan = false }: { focusPlan?: boolean } = {}) => {
      if (!overlay) {
        endCheckout({ focusPlan })
        return
      }
      returnFocusRef.current = focusPlan
        ? (pricingRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ??
          null)
        : null
      if (attemptId) {
        attempts.hide()
        trackCheckoutLifecycle(attemptId, {
          dismissalReason: membershipLastDismissalReasonRef.current,
          transition: "dismissed",
        })
      }
      setCheckoutVisible(false)
      setEngaged(false)
      setError(null)
    },
    [attemptId, attempts, endCheckout, overlay, trackCheckoutLifecycle],
  )
  const openCheckout = useCallback(() => {
    if (overlay && attemptId && checkoutInterval && !checkoutVisible) {
      const resumed = attempts.resume()
      setCheckoutVisible(true)
      setEngaged(false)
      if (resumed) {
        trackCheckoutLifecycle(resumed.checkoutAttemptId, {
          openIndex: attempts.openIndex() ?? 1,
          transition: "resumed",
        })
      }
      onCheckoutOpen?.()
      return
    }
    const next = attempts.open()
    if (!next.isNew) return
    const id = next.checkoutAttemptId
    const plan = getStripePricingPlan(selectedInterval, pricingCatalog)
    membershipAttemptStartedAtRef.current = Date.now()
    membershipLastLifecycleTransitionRef.current = "none"
    const openIndex = attempts.openIndex() ?? 1
    if (offerContext)
      trackAppEvent("offer_checkout_opened", {
        ...offerContext,
        availableProviders: [
          ...(stripePublishableKey ? ["stripe"] : []),
          ...(isPayPalCheckoutEnabled() && process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID?.trim()
            ? ["paypal"]
            : []),
        ],
        checkoutAttemptId: id,
        checkoutPresentation: overlay ? "overlay" : "inline",
        currency: plan.currency,
        funnelEventId: createFunnelEventId(),
        interval: selectedInterval,
        openIndex,
        planId: plan.analyticsId,
        pricingCatalog,
        value: plan.amount,
      })
    trackCheckoutLifecycle(id, {
      lastState: "none",
      openIndex,
      transition: "opened",
    })
    const stripePromise = getOfferStripePromise()
    const stripeRequired = overlay || !isPayPalCheckoutEnabled()
    if (stripePublishableKey && stripeRequired) {
      trackStripeJsAvailability(stripePromise, (failure) =>
        reportFailure(failure, "stripe", selectedInterval, id),
      )
    } else if (!stripePublishableKey && stripeRequired) {
      reportFailure(
        {
          errorCode: "stripe_publishable_key_missing",
          failureStage: "configuration",
          retryable: false,
        },
        "stripe",
        selectedInterval,
        id,
      )
    }
    setEngaged(false)
    setError(!stripePublishableKey && stripeRequired ? checkoutStartError : null)
    rotateStripeSessionAttemptOnRetryRef.current = true
    setAttemptId(id)
    setCheckoutSessionAttemptId(createFunnelEventId())
    setCheckoutInterval(selectedInterval)
    setCheckoutVisible(true)
    setStripe(stripePromise)
    onCheckoutOpen?.()
    if (!overlay)
      window.requestAnimationFrame(() =>
        inlineCheckoutRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      )
  }, [
    attempts,
    attemptId,
    checkoutInterval,
    checkoutVisible,
    offerContext,
    onCheckoutOpen,
    overlay,
    pricingCatalog,
    reportFailure,
    selectedInterval,
    trackCheckoutLifecycle,
  ])
  useEffect(() => {
    if (!claimCheckoutOpenRequest(handledRequestsRef.current, openCheckoutRequestId)) return
    const timer = window.setTimeout(openCheckout, 0)
    return () => window.clearTimeout(timer)
  }, [openCheckout, openCheckoutRequestId])
  useEffect(() => {
    if (!attemptId) return
    return () => {
      trackCheckoutLifecycle(attemptId, {
        endReason: "page_teardown",
        transition: "attempt_ended",
      })
      attempts.end()
    }
  }, [attemptId, attempts, trackCheckoutLifecycle])

  const fetchClientSecret = useCallback(async () => {
    if (!checkoutInterval || !attemptId || !checkoutSessionAttemptId) {
      throw new Error("checkout attempt missing")
    }
    if (!stripePublishableKey) {
      setError(checkoutStartError)
      const failure = {
        errorCode: "stripe_publishable_key_missing",
        failureStage: "configuration",
        retryable: false,
      } as const
      reportFailure(failure, "stripe")
      throw new Error("stripe publishable key missing")
    }
    const plan = getStripePricingPlan(checkoutInterval, pricingCatalog)
    if (stripeFunnelEventRef.current?.attemptId !== attemptId) {
      stripeFunnelEventRef.current = {
        attemptId,
        funnelEventId: createFunnelEventId(),
      }
    }
    const funnelEventId = stripeFunnelEventRef.current.funnelEventId
    let response: Response
    try {
      trackCheckoutLifecycle(attemptId, {
        provider: "stripe",
        transition: "preparation_started",
      })
      response = await fetch("/api/stripe/create-checkout-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          interval: checkoutInterval,
          leadId,
          source: "quiz_result_offer",
          funnelEventId,
          checkoutAttemptId: attemptId,
          checkoutSessionAttemptId,
          funnelSessionId: offerContext?.funnelSessionId,
          ...(express ? { presentation: "offer_overlay_elements" } : {}),
        }),
      })
    } catch (cause) {
      // The server may have received a request whose response was lost. Reuse the
      // same idempotency scope for that transport retry to recover its Session.
      rotateStripeSessionAttemptOnRetryRef.current =
        shouldRotateStripeSessionAttemptOnRetry("network")
      setError(checkoutStartError)
      reportFailure(
        {
          errorCode: "stripe_session_network_error",
          failureStage: "provider_session",
          retryable: true,
        },
        "stripe",
      )
      throw cause
    }
    if (!response.ok) {
      rotateStripeSessionAttemptOnRetryRef.current =
        shouldRotateStripeSessionAttemptOnRetry("provider_response")
      const body = await response.json().catch(() => ({}))
      if (isCheckoutAccessAlreadyExistsResponse(response, body)) {
        setDuplicateEmail(readCheckoutAccessAlreadyExistsEmail(body))
        setDuplicateOpen(true)
        reportFailure(
          {
            errorCode: "access_already_exists",
            failureStage: "duplicate_access",
            retryable: false,
          },
          "stripe",
        )
        throw new Error("checkout access already exists")
      }
      setError(checkoutStartError)
      reportFailure(
        {
          errorCode: "stripe_session_request_failed",
          failureStage: "provider_session",
          retryable: response.status >= 500 || response.status === 429,
        },
        "stripe",
      )
      throw new Error("failed to create checkout session")
    }
    const data = (await response.json().catch(() => ({}))) as { client_secret?: string }
    if (!data.client_secret) {
      rotateStripeSessionAttemptOnRetryRef.current =
        shouldRotateStripeSessionAttemptOnRetry("invalid_payload")
      setError(checkoutStartError)
      reportFailure(
        {
          errorCode: "stripe_client_secret_missing",
          failureStage: "provider_session",
          retryable: true,
        },
        "stripe",
      )
      throw new Error("checkout session response missing client secret")
    }
    trackAppEvent("checkout_started", {
      ...(offerContext ?? {}),
      checkoutAttemptId: attemptId,
      checkoutPresentation: overlay ? "overlay" : "inline",
      checkoutStartTrigger: "automatic_mount",
      interval: checkoutInterval,
      leadId: leadId ?? undefined,
      provider: "stripe",
      source: "quiz_result_offer",
      funnelEventId,
      currency: plan.currency,
      planId: plan.analyticsId,
      pricingCatalog,
      value: plan.amount,
    })
    trackCheckoutLifecycle(attemptId, {
      provider: "stripe",
      transition: "prepared_response_received",
    })
    return data.client_secret
  }, [
    attemptId,
    checkoutSessionAttemptId,
    checkoutInterval,
    express,
    leadId,
    offerContext,
    overlay,
    pricingCatalog,
    reportFailure,
    trackCheckoutLifecycle,
  ])

  const activePlan = getStripePricingPlan(checkoutInterval ?? selectedInterval, pricingCatalog)
  const checkout = checkoutInterval ? (
    duplicateOpen && isPaymentFeedbackV2Enabled() && duplicateFeedback ? (
      <PaymentFeedbackCard
        feedback={duplicateFeedback}
        onAction={() => {
          const href = duplicateEmail
            ? `/auth?email=${encodeURIComponent(duplicateEmail)}`
            : "/auth"
          window.location.assign(href)
        }}
        onReportProblem={
          attemptId && isPaymentSupportUiEnabled() ? duplicateReport.report : undefined
        }
        reportState={duplicateReport.state}
      />
    ) : (
      <PaymentMethodCheckout
        checkoutAttemptId={attemptId ?? undefined}
        checkoutError={error}
        checkoutKey={`${checkoutInterval}:${checkoutSessionAttemptId ?? "pending"}`}
        expressElementsEnabled={express}
        fetchClientSecret={fetchClientSecret}
        interval={checkoutInterval}
        leadId={leadId}
        lockedProvider={express ? lockedProvider : null}
        onClientMounted={(provider, option) => {
          if (!attemptId) return
          trackCheckoutLifecycle(attemptId, {
            option,
            provider,
            transition: "client_mounted",
          })
        }}
        onCheckoutLifecycle={(claim) => {
          if (!attemptId) return
          trackCheckoutLifecycle(attemptId, claim)
        }}
        onChangePlan={() => close({ focusPlan: true })}
        onConfirmStarted={(provider, option) => {
          if (!attemptId) return
          trackCheckoutLifecycle(attemptId, {
            option,
            provider,
            transition: "confirm_started",
          })
          if (provider === "paypal") {
            trackCheckoutLifecycle(attemptId, {
              option,
              provider,
              transition: "preparation_started",
            })
          }
        }}
        onFirstPaymentEngagement={() => {
          if (attemptId) {
            trackCheckoutLifecycle(attemptId, {
              transition: "payment_engaged",
            })
          }
          setEngaged(true)
        }}
        onPayPalCheckoutFailed={(failure) => reportFailure(failure, "paypal")}
        onPayPalCheckoutStarted={(funnelEventId) => {
          if (!attemptId) return
          const plan = getStripePricingPlan(checkoutInterval, pricingCatalog)
          trackCheckoutLifecycle(attemptId, {
            option: "paypal",
            provider: "paypal",
            transition: "prepared_response_received",
          })
          trackAppEvent("checkout_started", {
            ...(offerContext ?? {}),
            checkoutAttemptId: attemptId,
            checkoutPresentation: overlay ? "overlay" : "inline",
            checkoutStartTrigger: "explicit_provider_action",
            currency: plan.currency,
            interval: checkoutInterval,
            leadId: leadId ?? undefined,
            provider: "paypal",
            source: "quiz_result_offer",
            funnelEventId,
            planId: plan.analyticsId,
            pricingCatalog,
            value: plan.amount,
          })
        }}
        onProviderReady={(provider, option) => {
          if (!attemptId) return
          trackCheckoutLifecycle(attemptId, {
            option,
            provider,
            transition: "provider_ready",
          })
        }}
        onPaymentOptionViewed={(
          provider: OfferPaymentOptionProvider,
          option: OfferPaymentOption,
        ) => {
          if (
            !attemptId ||
            !offerContext ||
            !claimOfferPaymentOptionView(optionViewsRef.current, attemptId, option)
          )
            return
          const plan = getStripePricingPlan(checkoutInterval, pricingCatalog)
          trackAppEvent("offer_payment_option_viewed", {
            ...offerContext,
            checkoutAttemptId: attemptId,
            currency: plan.currency,
            funnelEventId: createFunnelEventId(),
            interval: checkoutInterval,
            option,
            planId: plan.analyticsId,
            pricingCatalog,
            provider,
            value: plan.amount,
          })
        }}
        onPaymentMethodSelected={(provider, paymentMethodType) => {
          if (!attemptId || (lockRef.current && lockRef.current !== provider)) return
          selectionIndexRef.current += 1
          if (!offerContext) return
          const plan = getStripePricingPlan(checkoutInterval, pricingCatalog)
          trackAppEvent("offer_payment_method_selected", {
            ...offerContext,
            checkoutAttemptId: attemptId,
            currency: plan.currency,
            funnelEventId: createFunnelEventId(),
            interval: checkoutInterval,
            paymentMethodType,
            planId: plan.analyticsId,
            pricingCatalog,
            provider,
            selectionIndex: selectionIndexRef.current,
            value: plan.amount,
          })
        }}
        onProviderLockClaim={express ? claimLock : undefined}
        onProviderLockRelease={express ? releaseLock : undefined}
        onRetry={() => {
          const retryId = attempts.retry()
          if (!retryId) return
          resetLock()
          setEngaged(false)
          setError(null)
          if (rotateStripeSessionAttemptOnRetryRef.current) {
            setCheckoutSessionAttemptId(createFunnelEventId())
          }
          setCheckoutInterval(null)
          window.setTimeout(() => setCheckoutInterval(selectedInterval), 0)
        }}
        planLabel={activePlan.ctaLabel}
        presentation={overlay ? "offer-overlay" : "default"}
        source="quiz_result_offer"
        stripe={stripe}
        visible={overlay ? checkoutVisible : true}
      />
    )
  ) : null

  return (
    <div ref={pricingRef} className="space-y-4">
      {!isPaymentFeedbackV2Enabled() ? (
        <ActiveSubscriptionDialog
          email={duplicateEmail}
          onOpenChange={setDuplicateOpen}
          open={duplicateOpen}
        />
      ) : null}
      <SubscriptionPlanSelector
        busy={false}
        offerTracking
        onContinue={openCheckout}
        onSelect={(interval) => {
          if (lockRef.current) return
          const change = selectPlan(interval)
          if (offerContext) {
            const plan = getStripePricingPlan(interval, pricingCatalog)
            trackAppEvent("offer_plan_selected", {
              ...offerContext,
              currency: plan.currency,
              funnelEventId: createFunnelEventId(),
              interval,
              isDefault: change.isDefault,
              planId: plan.analyticsId,
              pricingCatalog,
              previousInterval: change.previousInterval,
              selectionIndex: change.selectionIndex,
              value: plan.amount,
            })
          }
          endCheckout({ endReason: "plan_changed" })
        }}
        pricingCatalog={pricingCatalog}
        referencePrices={referencePrices}
        selectedInterval={selectedInterval}
      />
      {overlay ? (
        <OfferPaymentOverlay
          checkoutEngaged={engaged || !express}
          onConfirmedAbort={() =>
            engaged || !express
              ? endCheckout({
                  dismissalReason: membershipLastDismissalReasonRef.current,
                  endReason: "customer_aborted",
                })
              : close()
          }
          onConfirmedPlanChange={() => endCheckout({ endReason: "plan_changed", focusPlan: true })}
          onDismissRequest={(reason) => {
            membershipLastDismissalReasonRef.current = mapOverlayDismissalReason(reason)
          }}
          onPresentationStateChange={onOverlayPresentationStateChange}
          keepMounted={Boolean(checkoutInterval)}
          open={checkoutVisible}
          planName={activePlan.name}
          priceLabel={`${activePlan.price.replace(/^€/, "")} €`}
          restoreFocusRef={returnFocusRef}
        >
          {checkout}
        </OfferPaymentOverlay>
      ) : (
        <div ref={inlineCheckoutRef}>{checkout}</div>
      )}
    </div>
  )
}
