import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { observeOnceVisible } from "../src/lib/analytics/observe-once-visible"
import { STRIPE_PRICING_PLANS } from "../src/lib/stripe/pricing-plans"

const pricingSource = readFileSync(
  new URL("../src/components/quiz/result-offer-pricing.tsx", import.meta.url),
  "utf8",
)
const planSelectorSource = readFileSync(
  new URL("../src/components/checkout/subscription-plan-selector.tsx", import.meta.url),
  "utf8",
)

test("offer analytics plan metadata matches canonical purchase IDs and advertised values", () => {
  assert.deepEqual(
    STRIPE_PRICING_PLANS.map(({ analyticsId, amount, currency, interval }) => ({
      analyticsId,
      amount,
      currency,
      interval,
    })),
    [
      { analyticsId: "premium_month", amount: 14.99, currency: "EUR", interval: "month" },
      { analyticsId: "premium_quarter", amount: 34.99, currency: "EUR", interval: "quarter" },
      { analyticsId: "premium_year", amount: 99.99, currency: "EUR", interval: "year" },
    ],
  )
})

test("visibility-based pricing tracking preserves funnel attribution metadata", () => {
  assert.match(pricingSource, /const funnelEventId = createFunnelEventId\(\)/)
  assert.match(pricingSource, /offerTracking \?\? getCurrentFunnelContext\(\)/)
  assert.match(pricingSource, /offerContext\?\.funnelSessionId \?\? context\?\.funnelSessionId/)
  assert.match(pricingSource, /offerContext\?\.funnelPackageKey \?\? context\?\.funnelPackageKey/)
  assert.match(pricingSource, /pricingRevision: OFFER_PRICING_REVISION/)
  assert.match(pricingSource, /availableIntervals: STRIPE_PRICING_PLANS/)
  assert.match(pricingSource, /trackAppEvent\("pricing_viewed", \{\s*\.\.\.offerContext,/)
})

test("offer pricing tracks plan, checkout, payment-method, and sanitized failure diagnostics", () => {
  assert.match(pricingSource, /trackAppEvent\("offer_plan_selected"/)
  assert.match(pricingSource, /trackAppEvent\("offer_checkout_opened"/)
  assert.match(pricingSource, /trackAppEvent\("offer_payment_method_selected"/)
  assert.match(pricingSource, /trackAppEvent\("checkout_start_failed"/)
  assert.match(pricingSource, /errorCode: "stripe_session_request_failed"/)
  assert.match(pricingSource, /errorCode: "stripe_js_load_failed"/)
  assert.doesNotMatch(pricingSource, /errorCode: error\.message/)
  assert.match(planSelectorSource, /data-offer-cta=\{offerTracking \? "pricing_primary"/)
  assert.match(pricingSource, /<SubscriptionPlanSelector\s*offerTracking/)
  assert.match(pricingSource, /const nextAttempt = checkoutAttemptController\.open\(\)/)
  assert.match(pricingSource, /if \(!nextAttempt\.isNew\)/)
  assert.match(pricingSource, /const nextCheckoutAttemptId = nextAttempt\.checkoutAttemptId/)
  assert.match(pricingSource, /checkoutAttemptId: nextCheckoutAttemptId/)
  assert.match(pricingSource, /checkoutAttemptId,\s*\n\s*\}\),/)
  assert.match(pricingSource, /checkoutAttemptController\.claimFailure\(/)
  assert.match(pricingSource, /checkoutAttemptController\.retry\(\)/)
  assert.match(pricingSource, /checkoutAttemptController\.close\(\)/)
  assert.match(pricingSource, /setCheckoutAttemptId\(null\)/)
  assert.match(pricingSource, /setCheckoutAttemptId\(nextCheckoutAttemptId\)/)
  assert.match(
    pricingSource,
    /if \(!stripePublishableKey && !isPayPalCheckoutEnabled\(\)\) \{[\s\S]*?attemptId: nextCheckoutAttemptId,[\s\S]*?errorCode: "stripe_publishable_key_missing"/,
  )
})

test("pricing visibility waits for intersection and fires exactly once", () => {
  const observerState: { callback?: IntersectionObserverCallback } = {}
  let disconnected = 0
  let observed = 0
  let tracked = 0

  class FakeObserver {
    constructor(next: IntersectionObserverCallback) {
      observerState.callback = next
    }
    observe() {
      observed += 1
    }
    disconnect() {
      disconnected += 1
    }
  }

  const cleanup = observeOnceVisible(
    {} as Element,
    () => {
      tracked += 1
    },
    FakeObserver,
  )

  assert.equal(observed, 1)
  assert.equal(tracked, 0)
  observerState.callback?.(
    [{ isIntersecting: false } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  )
  assert.equal(tracked, 0)
  observerState.callback?.(
    [{ isIntersecting: true } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  )
  observerState.callback?.(
    [{ isIntersecting: true } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  )
  assert.equal(tracked, 1)
  assert.ok(disconnected >= 1)
  cleanup()
})

test("pricing visibility falls back to one immediate event without IntersectionObserver", () => {
  let tracked = 0
  observeOnceVisible(
    {} as Element,
    () => {
      tracked += 1
    },
    undefined,
  )
  assert.equal(tracked, 1)
})
