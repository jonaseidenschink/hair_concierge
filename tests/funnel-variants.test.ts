import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { LANDING_VARIANTS } from "../src/funnels/landing/registry.generated"
import { OFFER_VARIANTS } from "../src/funnels/offers/registry.generated"
import { FUNNEL_PACKAGES } from "../src/lib/funnel/packages"
import { getQuizVariant, isLandingCompatibleQuizVariant } from "../src/funnels/quizzes/registry"

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

test("every package references registered landing, quiz, and offer variants", () => {
  for (const funnelPackage of FUNNEL_PACKAGES) {
    const quizVariant = getQuizVariant(funnelPackage.quizVariant)
    assert.ok(quizVariant, funnelPackage.key)
    if (funnelPackage.status !== "archived") {
      assert.ok(funnelPackage.landingVariant in LANDING_VARIANTS, funnelPackage.key)
      assert.ok(
        isLandingCompatibleQuizVariant(quizVariant, funnelPackage.landingVariant),
        funnelPackage.key,
      )
      assert.ok(funnelPackage.offerVariant in OFFER_VARIANTS, funnelPackage.key)
    }
  }
})

test("the two live flows register the organic and Personal Plan offers", () => {
  assert.ok("organic-plan-v1" in OFFER_VARIANTS)
  assert.ok("organic-plan-before-after-v1" in OFFER_VARIANTS)
  assert.ok("personal-plan-v1" in OFFER_VARIANTS)
})

test("landing route owns tracking outside contributor variants", () => {
  assert.match(landingRouteSource, /<LandingTracking \/>/)
  assert.match(
    landingRouteSource,
    /renderLandingVariant\(funnelPackage\.landingVariant,\s*\{\s*personalPlanFieldTest,\s*personalPlanQuizResume,\s*moderatorQuiz,\s*freemiumScannerFirst: isFreemiumScannerFirstEnabled\(\),\s*\}\)/,
  )
  assert.doesNotMatch(defaultLandingSource, /LandingTracking/)
})

test("result client injects one shared pricing slot into the selected offer", () => {
  assert.match(resultClientSource, /renderOfferVariant\(offerVariant/)
  assert.match(resultClientSource, /quizAnswers,/)
  assert.match(resultClientSource, /pricingCatalog=\{pricingCatalog\}/)
  assert.match(
    resultClientSource,
    /pricingSlot:\s*(?:\(\s*)?<ResultOfferPricing[\s\S]*pricingCatalog=\{pricingCatalog\}[\s\S]*referencePrices=\{[\s\S]*pricingCatalogWasProvided[\s\S]*getSubscriptionPlanReferencePrices\(pricingCatalog\)[\s\S]*QUIZ_RESULT_REFERENCE_PRICES/,
  )
  assert.doesNotMatch(resultClientSource, /QuizResultOfferPage\b/)
})

test("result route preserves trusted stored result context before recording an offer view", () => {
  assert.match(funnelServerSource, /package_key, offer_variant, offer_viewed_at, first_seen_at/)
  assert.match(funnelServerSource, /offerVariant: data\.offer_variant/)
  assert.match(resultPageSource, /resolveOrganicOfferMediaExperiment/)
  assert.match(resultPageSource, /trustedOfferVariant/)
  assert.match(resultPageSource, /await recordLeadOfferView\(leadId, funnelContext, offerVariant\)/)
  assert.ok(
    resultPageSource.indexOf("resolveOrganicOfferMediaExperiment") <
      resultPageSource.indexOf("await recordLeadOfferView(leadId, funnelContext, offerVariant)"),
  )
})

test("result route keeps fresh quiz completions distinct from saved-result visits", () => {
  assert.match(resultPageSource, /const entry = getQuizResultSearchParamValue\(sp\.entry\)/)
  assert.match(resultPageSource, /entry === "quiz_completion"/)
  assert.match(resultPageSource, /input\.entry !== "quiz_return"/)
  assert.match(resultPageSource, /isPersonalPlanResultReturnForLead/)
  assert.match(resultPageSource, /trustedPersonalPlanResultReturn/)
  assert.match(resultPageSource, /entryContext === "quiz_return"/)
  assert.match(resultPageSource, /funnelEventId: null/)
  assert.match(resultPageSource, /entryContext=\{entryContext\}/)
  assert.match(resultClientSource, /entryContext \?\? \(focusRoutine \? "routine_return"/)
  assert.match(resultClientSource, /entryContext=\{resolvedEntryContext\}/)
  assert.match(resultClientSource, /isInternalTest=\{isInternalTest\}/)
})

test("quiz completion hands no-access results to the canonical result route", () => {
  assert.doesNotMatch(quizResultsSource, /QuizResultOfferPage\b/)
  assert.match(quizResultsSource, /\?entry=quiz_completion/)
  assert.match(quizResultsSource, /router\.replace\(resultRedirectPath\)/)
})
