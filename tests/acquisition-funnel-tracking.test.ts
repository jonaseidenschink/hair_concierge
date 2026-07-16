import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function read(path: string) {
  return readFileSync(path, "utf8")
}

test("acquisition funnel keeps Meta, Customer.io, and PostHog tracking from landing through checkout success", () => {
  const trackingProviders = read("src/providers/tracking-providers.tsx")
  const routeProviders = read("src/providers/route-providers.tsx")
  assert.match(trackingProviders, /function LandingTracking\(\)/)
  assert.match(trackingProviders, /function PublicFlowProviders\(/)
  assert.match(routeProviders, /function PublicAuthFlowProviders\(/)
  assert.match(trackingProviders, /<MetaPixelProvider>/)
  assert.match(trackingProviders, /<CustomerIoProvider>/)
  assert.match(trackingProviders, /<PostHogClientProvider>/)
  assert.match(trackingProviders, /<AnalyticsRuntimeCoordinator \/>/)
  assert.doesNotMatch(trackingProviders, /auth-provider|useAuth|supabase/i)
  assert.match(routeProviders, /<CustomerIoIdentify \/>/)
  assert.match(routeProviders, /<PostHogIdentify \/>/)

  const landing = read("src/app/page.tsx")
  assert.match(landing, /<LandingTracking \/>/)
  assert.match(landing, /@\/providers\/tracking-providers/)
  const campaignLanding = read("src/app/lp/[slug]/page.tsx")
  assert.match(campaignLanding, /getFunnelPackageBySlug/)
  assert.match(campaignLanding, /renderLandingVariant\(funnelPackage\.landingVariant\)/)
  assert.match(campaignLanding, /<LandingTracking \/>/)
  assert.match(campaignLanding, /\{landingVariant\}/)

  for (const path of [
    "src/app/auth/layout.tsx",
    "src/app/pricing/layout.tsx",
    "src/app/result/layout.tsx",
  ]) {
    assert.match(read(path), /<PublicFlowProviders>{children}<\/PublicFlowProviders>/, path)
    assert.match(read(path), /@\/providers\/tracking-providers/, path)
  }

  assert.match(
    read("src/app/welcome/layout.tsx"),
    /<PublicAuthFlowProviders>{children}<\/PublicAuthFlowProviders>/,
  )
  assert.match(read("src/app/quiz/layout.tsx"), /<QuizShell>{children}<\/QuizShell>/)
  assert.match(read("src/app/quiz/quiz-shell.tsx"), /<AppRouteProviders>/)
})

test("public editorial context is isolated from the acquisition provider graph", () => {
  const shell = read("src/components/editorial/editorial-shell.tsx")
  const bootstrap = read("src/providers/public-funnel-context-bootstrap.tsx")

  assert.doesNotMatch(shell, /route-providers|LandingTracking/)
  assert.match(shell, /@\/providers\/public-funnel-context-bootstrap/)
  assert.match(bootstrap, /@\/lib\/funnel\/client/)
  assert.doesNotMatch(bootstrap, /posthog|customerio|meta-pixel|useAuth|supabase/i)
})

test("vendor SDKs stay behind post-paint dynamic import boundaries without consent gates", () => {
  const coordinator = read("src/providers/analytics-runtime-coordinator.tsx")
  const customerIoRuntime = read("src/lib/analytics/runtime/customerio.ts")
  const postHogRuntime = read("src/lib/analytics/runtime/posthog.ts")
  const trackingSources = [
    coordinator,
    customerIoRuntime,
    postHogRuntime,
    read("src/providers/customerio-provider.tsx"),
    read("src/providers/meta-pixel-provider.tsx"),
    read("src/providers/posthog-provider.tsx"),
    read("src/lib/customerio-tracking.ts"),
    read("src/lib/meta-pixel.ts"),
  ].join("\n")

  assert.match(coordinator, /scheduleAfterFirstPaint/)
  assert.match(customerIoRuntime, /import\("@customerio\/cdp-analytics-browser"\)/)
  assert.match(postHogRuntime, /import\("posthog-js"\)/)
  assert.doesNotMatch(customerIoRuntime, /from "@customerio\/cdp-analytics-browser"/)
  assert.doesNotMatch(postHogRuntime, /from "posthog-js"/)
  assert.doesNotMatch(trackingSources, /cookie-consent|COOKIE_CONSENT|loadConsent/)
})

test("landing quiz CTAs do not prefetch checkout-heavy quiz bundles", () => {
  for (const path of [
    "src/components/landing/landing-header.tsx",
    "src/components/landing/hero.tsx",
    "src/components/landing/how-it-works.tsx",
    "src/components/landing/final-cta.tsx",
    "src/components/landing/sticky-quiz-cta.tsx",
    "src/components/landing/site-footer.tsx",
  ]) {
    const source = read(path)
    const quizLinks = source.match(/<Link\b(?=[^>]*href="\/quiz")[^>]*>/g) ?? []
    assert.ok(quizLinks.length > 0, `${path} should contain at least one /quiz link`)

    for (const link of quizLinks) {
      assert.match(link, /prefetch=\{false\}/, `${path} /quiz links should opt out of prefetch`)
    }
  }
})

test("result offer preloads Stripe only after the offer component mounts", () => {
  const source = read("src/components/quiz/result-offer-pricing.tsx")
  const moduleScope = source.slice(0, source.indexOf("export function ResultOfferPricing"))

  assert.match(source, /from "@stripe\/stripe-js\/pure"/)
  assert.doesNotMatch(moduleScope, /const stripePromise\s*=/)
  assert.doesNotMatch(moduleScope, /loadStripe\(/)
  assert.match(source, /useEffect\(\(\) => \{\s*getStripePromise\(\)/)
})

test("offer and profile reactivation pricing views keep funnel attribution with fresh event ids", () => {
  const source = read("src/components/quiz/result-offer-pricing.tsx")
  const profilePricingSource = read(
    "src/components/reactivation/membership-reactivation-checkout.tsx",
  )

  assert.doesNotMatch(source, /bootstrapFunnelContext\(\)\.then/)
  assert.match(source, /const context: FunnelAnalyticsEnvelope \| null =/)
  assert.match(source, /trackAppEvent\("pricing_viewed", \{[\s\S]*funnelEventId,/)
  assert.match(
    source,
    /funnelSessionId: offerContext\?\.funnelSessionId \?\? context\?\.funnelSessionId/,
  )
  assert.match(
    source,
    /funnelPackageKey: offerContext\?\.funnelPackageKey \?\? context\?\.funnelPackageKey/,
  )
  assert.doesNotMatch(profilePricingSource, /bootstrapFunnelContext\(\)\.then/)
  assert.match(
    profilePricingSource,
    /const context = getCurrentFunnelContext\(\)[\s\S]*trackAppEvent\("pricing_viewed", \{[\s\S]*funnelEventId: createFunnelEventId\(\),[\s\S]*funnelPackageKey: context\?\.funnelPackageKey/,
  )
})

test("checkout return only emits browser Subscribe when it can share Stripe's event id", () => {
  const source = read("src/app/welcome/checkout-return-analytics.tsx")

  assert.match(
    source,
    /if \(!sessionId\.startsWith\("paypal:"\)\) \{[\s\S]*trackAppEvent\("subscription_started", \{[\s\S]*checkoutSessionId: sessionId/,
  )
})
