import assert from "node:assert/strict"
import test from "node:test"

import {
  resolveCheckoutPricingCatalog,
  resolveStripeCheckoutSessionCreateOptions,
  StripeCheckoutSessionRequestSchema,
} from "../src/app/api/stripe/create-checkout-session/route"
import { classifyRoute } from "../src/lib/auth/route-classification"
import { requiresSubscriptionPath } from "../src/lib/supabase/middleware"
import {
  buildFreemiumCheckoutReturnUrl,
  FREEMIUM_CHECKOUT_DEFAULT_RETURN_PATH,
  FREEMIUM_CHECKOUT_RETURN_PARAM,
  sanitizeFreemiumCheckoutReturnPath,
} from "../src/lib/freemium/checkout-return"
import {
  freemiumCheckoutUserId,
  isFreemiumCheckoutSession,
} from "../src/lib/freemium/checkout-metadata"
import { premiumSheetPlans } from "../src/lib/premium-sheet/pricing"
import { getStripePriceId } from "../src/lib/stripe/client"
import { buildStripeCheckoutSessionParams } from "../src/lib/stripe/checkout-session-params"
import { getStripePricingPlan } from "../src/lib/stripe/pricing-plans"

/**
 * T14's half of the T13 carry-forward: the sheet DISPLAYS standard prices (pinned by
 * `lib/premium-sheet/pricing.ts` and asserted by `premium-sheet-pricing.test.ts`); this
 * suite pins what it SUBMITS. Both halves have to hold in both launch-flag states, because
 * a divergence would charge one amount behind a sheet showing another.
 */

const sheetRequest = {
  interval: "year" as const,
  source: "premium_sheet" as const,
  checkoutAttemptId: "9f2a8ad0-2b23-4f2f-9e9f-2b64bd4a1d20",
  returnPath: "/scan",
}

test("the submitted catalog is standard for the sheet in BOTH launch-pricing states", () => {
  for (const launchPricingEnabled of [false, true]) {
    assert.equal(
      resolveCheckoutPricingCatalog({ source: "premium_sheet", launchPricingEnabled }),
      "standard",
      `premium_sheet must submit the standard catalog (launch flag: ${launchPricingEnabled})`,
    )
  }
})

test("the flag still moves every other source — the pin is the sheet's, not a global change", () => {
  for (const source of ["pricing_page", "quiz_result_offer"] as const) {
    assert.equal(resolveCheckoutPricingCatalog({ source, launchPricingEnabled: false }), "standard")
    assert.equal(
      resolveCheckoutPricingCatalog({ source, launchPricingEnabled: true }),
      "personal_plan_launch_v1",
      `${source} must still follow the launch-pricing flag`,
    )
  }
})

test("the submitted price id equals the price the sheet rendered, both flag states", () => {
  for (const launchPricingEnabled of [false, true]) {
    const catalog = resolveCheckoutPricingCatalog({
      source: "premium_sheet",
      launchPricingEnabled,
    })
    for (const row of premiumSheetPlans()) {
      const plan = getStripePricingPlan(row.interval, catalog)
      assert.equal(
        plan.amount,
        row.amount,
        `${row.interval}: rendered ${row.amount} but would charge ${plan.amount}`,
      )
      assert.equal(plan.analyticsId, row.analyticsId)
      // The env may not configure every price id locally; when it does, it must be the
      // standard-catalog one, never the launch one.
      const standardPriceId = getStripePriceId(row.interval, "standard")
      const submittedPriceId = getStripePriceId(row.interval, catalog)
      assert.equal(submittedPriceId, standardPriceId)
    }
  }
})

test("the rendered amounts are the standard ones, so the assertion above cannot pass vacuously", () => {
  assert.deepEqual(
    premiumSheetPlans().map((row) => row.amount),
    [99.99, 34.99, 14.99],
  )
})

test("the request schema accepts the sheet's contract and refuses every legacy protocol", () => {
  assert.equal(StripeCheckoutSessionRequestSchema.safeParse(sheetRequest).success, true)

  const refused: Record<string, unknown>[] = [
    { ...sheetRequest, purchaseKind: "personal_plan_once" },
    { ...sheetRequest, presentation: "offer_overlay_elements" },
    { ...sheetRequest, action: "prepare", preparationId: "9f2a8ad0-2b23-4f2f-9e9f-2b64bd4a1d21" },
    { ...sheetRequest, leadId: "9f2a8ad0-2b23-4f2f-9e9f-2b64bd4a1d22" },
    { ...sheetRequest, funnelSessionId: "9f2a8ad0-2b23-4f2f-9e9f-2b64bd4a1d23" },
    { ...sheetRequest, checkoutContext: "membership_reactivation" },
    { ...sheetRequest, returnDestination: "/profile" },
  ]
  for (const request of refused) {
    assert.equal(
      StripeCheckoutSessionRequestSchema.safeParse(request).success,
      false,
      `premium_sheet must refuse ${JSON.stringify(request)}`,
    )
  }
})

test("returnPath belongs to the sheet alone", () => {
  assert.equal(
    StripeCheckoutSessionRequestSchema.safeParse({
      interval: "year",
      source: "pricing_page",
      returnPath: "/scan",
    }).success,
    false,
  )
})

test("a repeated CTA press recovers the same Stripe Session", () => {
  const options = resolveStripeCheckoutSessionCreateOptions({
    isPreparation: false,
    isOneTimePurchase: false,
    source: "premium_sheet",
    checkoutAttemptId: sheetRequest.checkoutAttemptId,
  })
  assert.deepEqual(options, { idempotencyKey: `premium-sheet:${sheetRequest.checkoutAttemptId}` })
})

test("contextual completion keeps the buyer in the sheet and off /welcome", () => {
  const params = buildStripeCheckoutSessionParams({
    origin: "https://chaarlie.de",
    priceId: "price_year",
    completion: "contextual",
    contextualReturnUrl: buildFreemiumCheckoutReturnUrl("https://chaarlie.de", "/routine"),
  })
  // `if_required`, not `never`: `never` would silently drop every redirect-based payment
  // method (PayPal above all) from Checkout's method list.
  assert.equal(params.redirect_on_completion, "if_required")
  assert.equal(
    params.return_url,
    `https://chaarlie.de/routine?${FREEMIUM_CHECKOUT_RETURN_PARAM}={CHECKOUT_SESSION_ID}`,
  )
  assert.equal(String(params.return_url).includes("/welcome"), false)
})

test("every pre-T14 caller keeps today's /welcome return, byte for byte", () => {
  const params = buildStripeCheckoutSessionParams({
    origin: "https://chaarlie.de",
    priceId: "price_year",
  })
  assert.equal(params.return_url, "https://chaarlie.de/welcome?session_id={CHECKOUT_SESSION_ID}")
  assert.equal("redirect_on_completion" in params, false)
})

test("contextual completion without a return url is a programming error, not a silent /welcome", () => {
  assert.throws(() =>
    buildStripeCheckoutSessionParams({
      origin: "https://chaarlie.de",
      priceId: "price_year",
      completion: "contextual",
    }),
  )
})

test("the return path is an allowlist, not a redirector", () => {
  for (const allowed of ["/scan", "/routine", "/anwendung", "/anwendung/wash-day", "/chat"]) {
    assert.equal(sanitizeFreemiumCheckoutReturnPath(allowed), allowed)
  }
  for (const rejected of [
    "https://evil.example/scan",
    "//evil.example",
    "/scan/../../admin",
    "\\\\evil.example",
    "/admin",
    "/api/scan/save",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(
      sanitizeFreemiumCheckoutReturnPath(rejected),
      FREEMIUM_CHECKOUT_DEFAULT_RETURN_PATH,
      `must not return to ${String(rejected)}`,
    )
  }
  // Query and hash are dropped so the return cannot smuggle its own parameters.
  assert.equal(sanitizeFreemiumCheckoutReturnPath("/scan?next=/admin#x"), "/scan")
})

test("the completion endpoint is authenticated but NOT behind the paywall", () => {
  // The whole point is that a FREE user calls it — putting it behind
  // `SUB_REQUIRED_PREFIXES` would make buying impossible for exactly the people the sheet
  // exists for. It still must not be public: it admits a plan.
  assert.equal(requiresSubscriptionPath("/api/freemium/purchase/complete"), false)
  assert.equal(
    classifyRoute("/api/freemium/purchase/complete", {
      nodeEnv: "production",
      localDevLoginEnabled: false,
    }),
    "protected",
  )
})

test("only a marked Session with a user id is a freemium purchase", () => {
  assert.equal(isFreemiumCheckoutSession({ metadata: null }), false)
  assert.equal(isFreemiumCheckoutSession({ metadata: { pricing_catalog: "standard" } }), false)
  assert.equal(isFreemiumCheckoutSession({ metadata: { freemium_admission: "1" } }), true)
  assert.equal(freemiumCheckoutUserId({ metadata: { freemium_admission: "1" } }), null)
  assert.equal(
    freemiumCheckoutUserId({ metadata: { freemium_admission: "1", freemium_user_id: " u1 " } }),
    "u1",
  )
})
