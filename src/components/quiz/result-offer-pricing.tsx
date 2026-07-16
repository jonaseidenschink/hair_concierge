"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { loadStripe } from "@stripe/stripe-js/pure"
import type { Stripe } from "@stripe/stripe-js"

import {
  isPayPalCheckoutEnabled,
  PaymentMethodCheckout,
  type CheckoutFailure,
} from "@/components/checkout/payment-method-checkout"
import {
  ActiveSubscriptionDialog,
  isCheckoutAccessAlreadyExistsResponse,
  readCheckoutAccessAlreadyExistsEmail,
} from "@/components/checkout/active-subscription-dialog"
import { SubscriptionPlanSelector } from "@/components/checkout/subscription-plan-selector"
import {
  OFFER_PRICING_REVISION,
  useOfferTrackingContext,
} from "@/components/quiz/offer-tracking-provider"
import { trackAppEvent } from "@/lib/analytics/track-app-event"
import { observeOnceVisible } from "@/lib/analytics/observe-once-visible"
import {
  createCheckoutAttemptController,
  type CheckoutAttemptController,
} from "@/lib/analytics/checkout-attempt"
import { createFunnelEventId, getCurrentFunnelContext } from "@/lib/funnel/client"
import type { FunnelAnalyticsEnvelope } from "@/lib/analytics/events"
import type { BillingInterval } from "@/lib/stripe/intervals"
import {
  DEFAULT_PRICING_INTERVAL,
  STRIPE_PRICING_PLANS,
  getStripePricingPlan,
} from "@/lib/stripe/pricing-plans"

const stripePublishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
const unloadedStripePromise = Promise.resolve(null)
const checkoutStartError = "Zahlung konnte nicht gestartet werden. Bitte versuche es erneut."

function trackStripeJsAvailability(
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

export function ResultOfferPricing({
  leadId,
  onCheckoutOpen,
  offerTracking,
}: {
  leadId: string | null
  onCheckoutOpen?: () => void
  offerTracking?: FunnelAnalyticsEnvelope | null
}) {
  const pricingRef = useRef<HTMLDivElement | null>(null)
  const checkoutRef = useRef<HTMLDivElement | null>(null)
  const pricingTrackedRef = useRef(false)
  const checkoutOpenIndexRef = useRef(0)
  const checkoutAttemptControllerRef = useRef<CheckoutAttemptController | null>(null)
  checkoutAttemptControllerRef.current ??= createCheckoutAttemptController(createFunnelEventId)
  const checkoutAttemptController = checkoutAttemptControllerRef.current
  const paymentSelectionIndexRef = useRef(0)
  const planSelectionIndexRef = useRef(0)
  const stripePromiseRef = useRef<Promise<Stripe | null> | null>(null)
  const offerContext = useOfferTrackingContext()
  const [selectedInterval, setSelectedInterval] =
    useState<BillingInterval>(DEFAULT_PRICING_INTERVAL)
  const [checkoutInterval, setCheckoutInterval] = useState<BillingInterval | null>(null)
  const [checkoutAttemptId, setCheckoutAttemptId] = useState<string | null>(null)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [checkoutStripePromise, setCheckoutStripePromise] =
    useState<Promise<Stripe | null>>(unloadedStripePromise)
  const [duplicateEmail, setDuplicateEmail] = useState<string | null>(null)
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false)

  const getStripePromise = useCallback(() => {
    if (!stripePublishableKey) {
      stripePromiseRef.current = unloadedStripePromise
      return unloadedStripePromise
    }

    if (!stripePromiseRef.current) {
      const promise = loadStripe(stripePublishableKey)
      promise.catch(() => {
        if (stripePromiseRef.current === promise) {
          stripePromiseRef.current = null
        }
      })
      stripePromiseRef.current = promise
    }

    return stripePromiseRef.current
  }, [])

  const ensureStripePromise = useCallback(() => {
    const promise = getStripePromise()
    setCheckoutStripePromise(promise)
    return promise
  }, [getStripePromise])

  useEffect(() => {
    getStripePromise()
  }, [getStripePromise])

  useEffect(() => {
    const pricingElement = pricingRef.current
    if (!pricingElement || pricingTrackedRef.current) return

    const trackPricingViewed = () => {
      if (pricingTrackedRef.current) return
      pricingTrackedRef.current = true
      const funnelEventId = createFunnelEventId()
      const context: FunnelAnalyticsEnvelope | null = offerTracking ?? getCurrentFunnelContext()
      trackAppEvent("pricing_viewed", {
        ...offerContext,
        availableIntervals: STRIPE_PRICING_PLANS.map((plan) => plan.interval),
        leadId: leadId ?? undefined,
        offerRevision: offerContext?.offerRevision,
        offerVariant: offerContext?.offerVariant,
        offerViewId: offerContext?.offerViewId,
        pricingRevision: OFFER_PRICING_REVISION,
        selectedInterval,
        source: "quiz_result_offer_pricing",
        funnelEventId,
        funnelSessionId: offerContext?.funnelSessionId ?? context?.funnelSessionId,
        funnelPackageKey: offerContext?.funnelPackageKey ?? context?.funnelPackageKey,
      })
    }

    return observeOnceVisible(pricingElement, trackPricingViewed)
  }, [leadId, offerContext, offerTracking, selectedInterval])

  const trackCheckoutFailure = useCallback(
    ({
      attemptId,
      failure,
      interval,
      provider,
    }: {
      attemptId: string
      failure: CheckoutFailure
      interval: BillingInterval
      provider: "stripe" | "paypal"
    }) => {
      if (!offerContext) return
      if (
        !checkoutAttemptController.claimFailure(
          attemptId,
          provider,
          failure.failureStage,
          failure.errorCode,
        )
      )
        return

      const plan = getStripePricingPlan(interval)
      trackAppEvent("checkout_start_failed", {
        ...offerContext,
        checkoutAttemptId: attemptId,
        currency: plan.currency,
        ...failure,
        funnelEventId: createFunnelEventId(),
        interval,
        planId: plan.analyticsId,
        provider,
        value: plan.amount,
      })
    },
    [checkoutAttemptController, offerContext],
  )

  function choosePlan(interval: BillingInterval) {
    if (offerContext) {
      const plan = getStripePricingPlan(interval)
      planSelectionIndexRef.current += 1
      trackAppEvent("offer_plan_selected", {
        ...offerContext,
        currency: plan.currency,
        funnelEventId: createFunnelEventId(),
        interval,
        isDefault: interval === DEFAULT_PRICING_INTERVAL,
        planId: plan.analyticsId,
        previousInterval: selectedInterval,
        selectionIndex: planSelectionIndexRef.current,
        value: plan.amount,
      })
    }
    setSelectedInterval(interval)
    checkoutAttemptController.close()
    setCheckoutInterval(null)
    setCheckoutAttemptId(null)
    setCheckoutError(null)
  }

  function openCheckout() {
    const nextAttempt = checkoutAttemptController.open()
    if (!nextAttempt.isNew) {
      window.requestAnimationFrame(() => {
        checkoutRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
      })
      return
    }

    const plan = getStripePricingPlan(selectedInterval)
    const nextCheckoutAttemptId = nextAttempt.checkoutAttemptId
    if (offerContext) {
      checkoutOpenIndexRef.current += 1
      trackAppEvent("offer_checkout_opened", {
        ...offerContext,
        availableProviders: [
          ...(stripePublishableKey ? ["stripe"] : []),
          ...(isPayPalCheckoutEnabled() && process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID?.trim()
            ? ["paypal"]
            : []),
        ],
        checkoutAttemptId: nextCheckoutAttemptId,
        currency: plan.currency,
        funnelEventId: createFunnelEventId(),
        interval: selectedInterval,
        openIndex: checkoutOpenIndexRef.current,
        planId: plan.analyticsId,
        value: plan.amount,
      })
    }
    const stripePromise = ensureStripePromise()
    if (stripePublishableKey && offerContext && !isPayPalCheckoutEnabled()) {
      trackStripeJsAvailability(stripePromise, (failure) =>
        trackCheckoutFailure({
          attemptId: nextCheckoutAttemptId,
          failure,
          interval: selectedInterval,
          provider: "stripe",
        }),
      )
    }
    if (!stripePublishableKey && !isPayPalCheckoutEnabled()) {
      trackCheckoutFailure({
        attemptId: nextCheckoutAttemptId,
        failure: {
          errorCode: "stripe_publishable_key_missing",
          failureStage: "configuration",
          retryable: false,
        },
        interval: selectedInterval,
        provider: "stripe",
      })
    }
    setCheckoutError(
      !isPayPalCheckoutEnabled() && !stripePublishableKey ? checkoutStartError : null,
    )
    onCheckoutOpen?.()
    setCheckoutAttemptId(nextCheckoutAttemptId)
    setCheckoutInterval(selectedInterval)
    window.requestAnimationFrame(() => {
      checkoutRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    })
  }

  const fetchClientSecret = useCallback(async () => {
    if (!checkoutInterval || !checkoutAttemptId) {
      throw new Error("checkout attempt missing")
    }

    if (!stripePublishableKey) {
      setCheckoutError(checkoutStartError)
      trackCheckoutFailure({
        attemptId: checkoutAttemptId,
        failure: {
          errorCode: "stripe_publishable_key_missing",
          failureStage: "configuration",
          retryable: false,
        },
        interval: checkoutInterval,
        provider: "stripe",
      })
      throw new Error("stripe publishable key missing")
    }

    setCheckoutError(null)
    const funnelEventId = createFunnelEventId()
    const plan = getStripePricingPlan(checkoutInterval)
    let response: Response
    try {
      response = await fetch("/api/stripe/create-checkout-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          interval: checkoutInterval,
          leadId,
          source: "quiz_result_offer",
          funnelEventId,
          checkoutAttemptId,
        }),
      })
    } catch (error) {
      setCheckoutError(checkoutStartError)
      trackCheckoutFailure({
        attemptId: checkoutAttemptId,
        failure: {
          errorCode: "stripe_session_network_error",
          failureStage: "provider_session",
          retryable: true,
        },
        interval: checkoutInterval,
        provider: "stripe",
      })
      throw error
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      if (isCheckoutAccessAlreadyExistsResponse(response, body)) {
        setCheckoutError(null)
        setDuplicateEmail(readCheckoutAccessAlreadyExistsEmail(body))
        setDuplicateDialogOpen(true)
        trackCheckoutFailure({
          attemptId: checkoutAttemptId,
          failure: {
            errorCode: "access_already_exists",
            failureStage: "duplicate_access",
            retryable: false,
          },
          interval: checkoutInterval,
          provider: "stripe",
        })
        throw new Error("checkout access already exists")
      }
      setCheckoutError(checkoutStartError)
      trackCheckoutFailure({
        attemptId: checkoutAttemptId,
        failure: {
          errorCode: "stripe_session_request_failed",
          failureStage: "provider_session",
          retryable: response.status >= 500 || response.status === 429,
        },
        interval: checkoutInterval,
        provider: "stripe",
      })
      throw new Error("failed to create checkout session")
    }

    const data = (await response.json().catch(() => ({}))) as { client_secret?: string }
    if (!data.client_secret) {
      setCheckoutError(checkoutStartError)
      trackCheckoutFailure({
        attemptId: checkoutAttemptId,
        failure: {
          errorCode: "stripe_client_secret_missing",
          failureStage: "provider_session",
          retryable: true,
        },
        interval: checkoutInterval,
        provider: "stripe",
      })
      throw new Error("checkout session response missing client secret")
    }

    trackAppEvent("checkout_started", {
      ...(offerContext ?? {}),
      checkoutAttemptId,
      interval: checkoutInterval,
      leadId: leadId ?? undefined,
      provider: "stripe",
      source: "quiz_result_offer",
      funnelEventId,
      currency: plan.currency,
      planId: plan.analyticsId,
      value: plan.amount,
    })

    return data.client_secret
  }, [
    checkoutInterval,
    checkoutAttemptId,
    leadId,
    offerContext,
    trackCheckoutFailure,
    setCheckoutError,
    setDuplicateDialogOpen,
    setDuplicateEmail,
  ])

  const handlePayPalCheckoutStarted = useCallback(
    (funnelEventId: string) => {
      if (!checkoutInterval || !checkoutAttemptId) return
      const plan = getStripePricingPlan(checkoutInterval)
      trackAppEvent("checkout_started", {
        ...(offerContext ?? {}),
        checkoutAttemptId,
        currency: plan.currency,
        interval: checkoutInterval,
        leadId: leadId ?? undefined,
        provider: "paypal",
        source: "quiz_result_offer",
        funnelEventId,
        planId: plan.analyticsId,
        value: plan.amount,
      })
    },
    [checkoutAttemptId, checkoutInterval, leadId, offerContext],
  )

  const handlePaymentMethodSelected = useCallback(
    (provider: "stripe" | "paypal") => {
      if (!checkoutInterval || !checkoutAttemptId || !offerContext) return
      const plan = getStripePricingPlan(checkoutInterval)
      paymentSelectionIndexRef.current += 1
      trackAppEvent("offer_payment_method_selected", {
        ...offerContext,
        checkoutAttemptId,
        currency: plan.currency,
        funnelEventId: createFunnelEventId(),
        interval: checkoutInterval,
        planId: plan.analyticsId,
        provider,
        selectionIndex: paymentSelectionIndexRef.current,
        value: plan.amount,
      })
      if (provider === "stripe") {
        if (stripePublishableKey) {
          trackStripeJsAvailability(getStripePromise(), (failure) =>
            trackCheckoutFailure({
              attemptId: checkoutAttemptId,
              failure,
              interval: checkoutInterval,
              provider: "stripe",
            }),
          )
        } else {
          trackCheckoutFailure({
            attemptId: checkoutAttemptId,
            failure: {
              errorCode: "stripe_publishable_key_missing",
              failureStage: "configuration",
              retryable: false,
            },
            interval: checkoutInterval,
            provider: "stripe",
          })
        }
      }
    },
    [checkoutAttemptId, checkoutInterval, getStripePromise, offerContext, trackCheckoutFailure],
  )

  const handlePayPalCheckoutFailed = useCallback(
    (failure: CheckoutFailure) => {
      if (!checkoutInterval || !checkoutAttemptId) return
      trackCheckoutFailure({
        attemptId: checkoutAttemptId,
        failure,
        interval: checkoutInterval,
        provider: "paypal",
      })
    },
    [checkoutAttemptId, checkoutInterval, trackCheckoutFailure],
  )

  return (
    <div ref={pricingRef} className="space-y-4">
      <ActiveSubscriptionDialog
        email={duplicateEmail}
        onOpenChange={setDuplicateDialogOpen}
        open={duplicateDialogOpen}
      />
      <SubscriptionPlanSelector
        offerTracking
        onContinue={openCheckout}
        onSelect={choosePlan}
        selectedInterval={selectedInterval}
      />

      <div ref={checkoutRef}>
        {checkoutInterval ? (
          <PaymentMethodCheckout
            checkoutAttemptId={checkoutAttemptId ?? undefined}
            checkoutError={checkoutError}
            checkoutKey={`${checkoutInterval}:${checkoutAttemptId ?? "pending"}`}
            fetchClientSecret={fetchClientSecret}
            interval={checkoutInterval}
            leadId={leadId}
            onChangePlan={() => {
              checkoutAttemptController.close()
              setCheckoutAttemptId(null)
              setCheckoutInterval(null)
            }}
            onPayPalCheckoutFailed={handlePayPalCheckoutFailed}
            onPayPalCheckoutStarted={handlePayPalCheckoutStarted}
            onPaymentMethodSelected={handlePaymentMethodSelected}
            onRetry={() => {
              if (!stripePublishableKey) {
                setCheckoutError(checkoutStartError)
                return
              }

              const retryCheckoutAttemptId = checkoutAttemptController.retry()
              if (!retryCheckoutAttemptId) return
              const interval = checkoutInterval
              setCheckoutAttemptId(retryCheckoutAttemptId)
              setCheckoutError(null)
              setCheckoutInterval(null)
              window.setTimeout(() => setCheckoutInterval(interval), 0)
            }}
            planLabel={getStripePricingPlan(checkoutInterval).ctaLabel}
            source="quiz_result_offer"
            stripe={checkoutStripePromise}
          />
        ) : null}
      </div>
    </div>
  )
}
