"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { loadStripe } from "@stripe/stripe-js/pure"
import type { Stripe } from "@stripe/stripe-js"

import {
  ActiveSubscriptionDialog,
  isCheckoutAccessAlreadyExistsResponse,
  readCheckoutAccessAlreadyExistsEmail,
} from "@/components/checkout/active-subscription-dialog"
import {
  isPayPalCheckoutEnabled,
  PaymentMethodCheckout,
} from "@/components/checkout/payment-method-checkout"
import { SubscriptionPlanSelector } from "@/components/checkout/subscription-plan-selector"
import {
  createCheckoutAttemptController,
  type CheckoutAttemptController,
} from "@/lib/analytics/checkout-attempt"
import { trackAppEvent } from "@/lib/analytics/track-app-event"
import { createFunnelEventId, getCurrentFunnelContext } from "@/lib/funnel/client"
import { addCheckoutBreadcrumb, captureCheckoutException } from "@/lib/observability/checkout"
import type { BillingInterval } from "@/lib/stripe/intervals"
import {
  DEFAULT_PRICING_INTERVAL,
  STRIPE_PRICING_PLANS,
  getStripePricingPlan,
} from "@/lib/stripe/pricing-plans"

const stripePublishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
const unloadedStripePromise = Promise.resolve(null)
const checkoutStartError = "Zahlung konnte nicht gestartet werden. Bitte versuche es erneut."
const checkoutContext = "membership_reactivation" as const
type LockedCheckoutProvider = "stripe" | "paypal"

export function canChangeReactivationCheckoutPlan(lockedProvider: LockedCheckoutProvider | null) {
  return lockedProvider === null
}

export function getReactivationRetryAttemptId(checkoutAttemptId: string | null) {
  if (!checkoutAttemptId) throw new Error("checkout attempt missing")
  return checkoutAttemptId
}

export function MembershipReactivationCheckout({
  initialInterval = DEFAULT_PRICING_INTERVAL,
  returnDestination,
}: {
  initialInterval?: BillingInterval
  returnDestination: string
}) {
  const checkoutRef = useRef<HTMLDivElement | null>(null)
  const checkoutAttemptControllerRef = useRef<CheckoutAttemptController | null>(null)
  checkoutAttemptControllerRef.current ??= createCheckoutAttemptController(createFunnelEventId)
  const checkoutAttemptController = checkoutAttemptControllerRef.current
  const stripePromiseRef = useRef<Promise<Stripe | null> | null>(null)
  const lockedProviderRef = useRef<LockedCheckoutProvider | null>(null)
  const [selectedInterval, setSelectedInterval] = useState<BillingInterval>(initialInterval)
  const [checkoutInterval, setCheckoutInterval] = useState<BillingInterval | null>(null)
  const [checkoutAttemptId, setCheckoutAttemptId] = useState<string | null>(null)
  const [checkoutRetryKey, setCheckoutRetryKey] = useState(0)
  const [lockedProvider, setLockedProvider] = useState<LockedCheckoutProvider | null>(null)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [checkoutStripePromise, setCheckoutStripePromise] =
    useState<Promise<Stripe | null>>(unloadedStripePromise)
  const [duplicateEmail, setDuplicateEmail] = useState<string | null>(null)
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false)
  const selectedPlan = getStripePricingPlan(selectedInterval)

  const getStripePromise = useCallback(() => {
    if (!stripePublishableKey) return unloadedStripePromise
    if (!stripePromiseRef.current) {
      const promise = loadStripe(stripePublishableKey)
      promise.catch(() => {
        if (stripePromiseRef.current === promise) stripePromiseRef.current = null
      })
      stripePromiseRef.current = promise
    }
    return stripePromiseRef.current
  }, [])

  useEffect(() => {
    const context = getCurrentFunnelContext()
    trackAppEvent("pricing_viewed", {
      availableIntervals: STRIPE_PRICING_PLANS.map((plan) => plan.interval),
      checkoutContext,
      funnelEventId: createFunnelEventId(),
      funnelPackageKey: context?.funnelPackageKey,
      funnelSessionId: context?.funnelSessionId,
      selectedInterval: initialInterval,
      source: "pricing_page",
    })
  }, [initialInterval])

  const lockCheckoutToProvider = useCallback((provider: LockedCheckoutProvider) => {
    if (lockedProviderRef.current && lockedProviderRef.current !== provider) return
    lockedProviderRef.current = provider
    setLockedProvider(provider)
  }, [])

  function choosePlan(interval: BillingInterval) {
    if (!canChangeReactivationCheckoutPlan(lockedProviderRef.current)) return
    setSelectedInterval(interval)
    checkoutAttemptController.close()
    setCheckoutAttemptId(null)
    setCheckoutInterval(null)
    setCheckoutRetryKey(0)
    setCheckoutError(null)
  }

  function openCheckout() {
    const nextAttempt = checkoutAttemptController.open()
    if (!nextAttempt.isNew) {
      checkoutRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
      return
    }

    setCheckoutError(
      !isPayPalCheckoutEnabled() && !stripePublishableKey ? checkoutStartError : null,
    )
    setCheckoutAttemptId(nextAttempt.checkoutAttemptId)
    setCheckoutInterval(selectedInterval)
    setCheckoutStripePromise(getStripePromise())
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
      throw new Error("stripe publishable key missing")
    }

    setCheckoutError(null)
    const funnelEventId = createFunnelEventId()
    const plan = getStripePricingPlan(checkoutInterval)
    addCheckoutBreadcrumb({
      provider: "stripe",
      stage: "stripe_embedded_checkout_client_secret",
      source: "pricing_page",
      interval: checkoutInterval,
    })

    let response: Response
    try {
      response = await fetch("/api/stripe/create-checkout-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          checkoutAttemptId,
          checkoutContext,
          funnelEventId,
          interval: checkoutInterval,
          source: "pricing_page",
          returnDestination,
        }),
      })
    } catch (error) {
      setCheckoutError(checkoutStartError)
      captureCheckoutException(error, {
        provider: "stripe",
        stage: "stripe_embedded_checkout_client_secret",
        source: "pricing_page",
        interval: checkoutInterval,
        reason: "network_error",
      })
      throw error
    }

    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      if (isCheckoutAccessAlreadyExistsResponse(response, body)) {
        setDuplicateEmail(readCheckoutAccessAlreadyExistsEmail(body))
        setDuplicateDialogOpen(true)
        throw new Error("checkout access already exists")
      }
      if (body?.error === "reactivation_checkout_terminal") {
        checkoutAttemptController.close()
        const replacementAttempt = checkoutAttemptController.open()
        setCheckoutAttemptId(replacementAttempt.checkoutAttemptId)
      }
      setCheckoutError(checkoutStartError)
      const error = new Error("failed to create checkout session")
      captureCheckoutException(error, {
        provider: "stripe",
        stage: "stripe_embedded_checkout_client_secret",
        source: "pricing_page",
        interval: checkoutInterval,
        status: response.status,
      })
      throw error
    }

    const clientSecret = typeof body.client_secret === "string" ? body.client_secret : null
    if (!clientSecret) {
      setCheckoutError(checkoutStartError)
      throw new Error("checkout session response missing client secret")
    }

    lockCheckoutToProvider("stripe")
    const context = getCurrentFunnelContext()
    trackAppEvent("checkout_started", {
      checkoutAttemptId,
      checkoutContext,
      currency: plan.currency,
      funnelEventId,
      funnelPackageKey: context?.funnelPackageKey,
      funnelSessionId: context?.funnelSessionId,
      interval: checkoutInterval,
      planId: plan.analyticsId,
      provider: "stripe",
      source: "pricing_page",
      value: plan.amount,
    })
    return clientSecret
  }, [
    checkoutAttemptController,
    checkoutAttemptId,
    checkoutInterval,
    lockCheckoutToProvider,
    returnDestination,
  ])

  const handlePayPalCheckoutStarted = useCallback(
    (funnelEventId: string) => {
      if (!checkoutInterval || !checkoutAttemptId) return
      lockCheckoutToProvider("paypal")
      const context = getCurrentFunnelContext()
      const plan = getStripePricingPlan(checkoutInterval)
      trackAppEvent("checkout_started", {
        checkoutAttemptId,
        checkoutContext,
        currency: plan.currency,
        funnelEventId,
        funnelPackageKey: context?.funnelPackageKey,
        funnelSessionId: context?.funnelSessionId,
        interval: checkoutInterval,
        planId: plan.analyticsId,
        provider: "paypal",
        source: "pricing_page",
        value: plan.amount,
      })
    },
    [checkoutAttemptId, checkoutInterval, lockCheckoutToProvider],
  )

  return (
    <div className="mt-5 rounded-2xl border border-border/70 bg-background p-4 sm:p-5">
      <ActiveSubscriptionDialog
        email={duplicateEmail}
        onOpenChange={setDuplicateDialogOpen}
        open={duplicateDialogOpen}
      />
      {lockedProvider === null ? (
        <SubscriptionPlanSelector
          actionLabel={`${selectedPlan.price} · Mitgliedschaft reaktivieren`}
          onContinue={openCheckout}
          onSelect={choosePlan}
          selectedInterval={selectedInterval}
        />
      ) : null}
      <div ref={checkoutRef}>
        {checkoutInterval ? (
          <PaymentMethodCheckout
            checkoutAttemptId={checkoutAttemptId ?? undefined}
            checkoutContext={checkoutContext}
            checkoutError={checkoutError}
            checkoutKey={`${checkoutInterval}:${checkoutAttemptId ?? "pending"}:${checkoutRetryKey}`}
            fetchClientSecret={fetchClientSecret}
            interval={checkoutInterval}
            lockedProvider={lockedProvider}
            onChangePlan={() => {
              if (!canChangeReactivationCheckoutPlan(lockedProviderRef.current)) return
              checkoutAttemptController.close()
              setCheckoutAttemptId(null)
              setCheckoutInterval(null)
              setCheckoutRetryKey(0)
              setCheckoutError(null)
            }}
            onPayPalCheckoutStarted={handlePayPalCheckoutStarted}
            onRetry={() => {
              setCheckoutAttemptId(getReactivationRetryAttemptId(checkoutAttemptId))
              setCheckoutError(null)
              setCheckoutRetryKey((current) => current + 1)
            }}
            planLabel={getStripePricingPlan(checkoutInterval).ctaLabel}
            returnDestination={returnDestination}
            source="pricing_page"
            stripe={checkoutStripePromise}
          />
        ) : null}
      </div>
    </div>
  )
}
