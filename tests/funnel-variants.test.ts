import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { LANDING_VARIANTS } from "../src/funnels/landing/registry.generated"
import { OFFER_VARIANTS } from "../src/funnels/offers/registry.generated"
import { FUNNEL_PACKAGES } from "../src/lib/funnel/packages"

const landingRouteSource = readFileSync(
  new URL("../src/app/lp/[slug]/page.tsx", import.meta.url),
  "utf8",
)
const resultClientSource = readFileSync(
  new URL("../src/app/result/[leadId]/result-client.tsx", import.meta.url),
  "utf8",
)
const resultPageSource = readFileSync(
  new URL("../src/app/result/[leadId]/page.tsx", import.meta.url),
  "utf8",
)
const funnelServerSource = readFileSync(
  new URL("../src/lib/funnel/server.ts", import.meta.url),
  "utf8",
)
const defaultLandingSource = readFileSync(
  new URL("../src/funnels/landing/default.tsx", import.meta.url),
  "utf8",
)
const quizResultsSource = readFileSync(
  new URL("../src/components/quiz/quiz-results.tsx", import.meta.url),
  "utf8",
)

test("every package references registered landing and offer variants", () => {
  for (const funnelPackage of FUNNEL_PACKAGES) {
    assert.ok(funnelPackage.landingVariant in LANDING_VARIANTS, funnelPackage.key)
    assert.ok(funnelPackage.offerVariant in OFFER_VARIANTS, funnelPackage.key)
  }
})

test("app value stack is registered once alongside the historical default offer", () => {
  assert.ok("app-value-stack" in OFFER_VARIANTS)
  assert.ok("default" in OFFER_VARIANTS)
  assert.equal(
    Object.keys(OFFER_VARIANTS).filter((variant) => variant === "app-value-stack").length,
    1,
  )
})

test("landing route owns tracking outside contributor variants", () => {
  assert.match(landingRouteSource, /<LandingTracking \/>/)
  assert.match(landingRouteSource, /renderLandingVariant\(funnelPackage\.landingVariant\)/)
  assert.doesNotMatch(defaultLandingSource, /LandingTracking/)
})

test("result client injects one shared pricing slot into the selected offer", () => {
  assert.match(resultClientSource, /renderOfferVariant\(offerVariant/)
  assert.match(resultClientSource, /quizAnswers,/)
  assert.match(resultClientSource, /pricingSlot: <ResultOfferPricing/)
  assert.doesNotMatch(resultClientSource, /QuizResultOfferPage\b/)
})

test("result route selects the historical offer variant stored on the funnel session", () => {
  assert.match(funnelServerSource, /package_key, offer_variant, first_seen_at/)
  assert.match(funnelServerSource, /offerVariant: data\.offer_variant/)
  assert.match(resultPageSource, /resolveOfferVariantForSession\(funnelContext\)/)
})

test("result route keeps fresh quiz completions distinct from saved-result visits", () => {
  assert.match(resultPageSource, /sp\.entry === "quiz_completion"/)
  assert.match(resultPageSource, /entryContext=\{entryContext\}/)
  assert.match(resultClientSource, /entryContext \?\? \(focusRoutine \? "routine_return"/)
  assert.match(resultClientSource, /entryContext: resolvedEntryContext/)
})

test("quiz completion hands no-access results to the canonical result route", () => {
  assert.doesNotMatch(quizResultsSource, /QuizResultOfferPage\b/)
  assert.match(quizResultsSource, /\?entry=quiz_completion/)
  assert.match(quizResultsSource, /router\.replace\(resultRedirectPath\)/)
})
