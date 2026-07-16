import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import "./helpers/browser-storage-shim"

import { SiteFooter } from "../src/components/landing/site-footer"

let MethodikContent: (typeof import("../src/app/methodik/page"))["MethodikContent"]
let NotFound: (typeof import("../src/app/not-found"))["default"]

test.before(async () => {
  const methodikModule = await import("../src/app/methodik/page")
  const notFoundModule = await import("../src/app/not-found")
  MethodikContent = methodikModule.MethodikContent
  NotFound = notFoundModule.default
})

test("Methodik shows the required trust, commercial, ownership, and medical boundaries", () => {
  const html = renderToStaticMarkup(<MethodikContent />)

  assert.match(html, /kosmetische Pflegeeinschätzung auf Grundlage deiner Antworten/i)
  assert.match(html, /keine Diagnose/i)
  assert.match(html, /Selbsttests und Selbsteinschätzungen können ungenau sein/i)
  assert.match(html, /Produktangaben können aus Herstellerinformationen/i)
  assert.match(html, /Affiliate-Links/i)
  assert.match(html, /Provision erhalten/i)
  assert.match(html, /Quellen und Aktualisierung/i)
  assert.match(html, /Chaarlie Redaktion/i)
  assert.match(html, /Haarmony LLC/i)
  assert.match(html, /ärztlichen Rat/i)
  assert.match(html, /href="\/quiz"/i)
  assert.doesNotMatch(html, /wissenschaftlich validiert/i)
  assert.doesNotMatch(html, /ärztlich validiert/i)
})

test("the Methodik shell is discoverable without exposing a premature Ratgeber", () => {
  const shellSource = readFileSync("src/components/editorial/editorial-shell.tsx", "utf8")
  const footerHtml = renderToStaticMarkup(<SiteFooter />)

  assert.match(shellSource, /<LandingHeader \/>/)
  assert.match(shellSource, /<main /)
  assert.match(shellSource, /<SiteFooter \/>/)
  assert.match(footerHtml, /href="\/methodik"/)
  assert.doesNotMatch(footerHtml, /href="\/ratgeber"/)
})

test("Methodik bootstraps first-party funnel context without editorial vendor tracking", () => {
  const methodikSource = readFileSync("src/app/methodik/page.tsx", "utf8")
  const shellSource = readFileSync("src/components/editorial/editorial-shell.tsx", "utf8")
  const bootstrapSource = readFileSync("src/providers/public-funnel-context-bootstrap.tsx", "utf8")

  assert.match(methodikSource, /<EditorialShell bootstrapFunnelContext>/)
  assert.match(shellSource, /bootstrapFunnelContext = false/)
  assert.match(shellSource, /<PublicFunnelContextBootstrap \/>/)
  assert.doesNotMatch(shellSource, /LandingTracking|route-providers/)
  assert.match(bootstrapSource, /import \{ bootstrapFunnelContext \} from "@\/lib\/funnel\/client"/)
  assert.match(
    bootstrapSource,
    /useEffect\(\(\) => \{\s*void bootstrapFunnelContext\(\)\s*\}, \[\]\)/,
  )
  assert.doesNotMatch(bootstrapSource, /posthog|auth|provider|recordBrowserFunnelMilestone/i)
})

test("unknown routes render a branded German recovery page", () => {
  const html = renderToStaticMarkup(<NotFound />)

  assert.match(html, /Diese Seite gibt es nicht/)
  assert.match(html, /href="\/"/)
  assert.match(html, /href="\/quiz"/)
  assert.doesNotMatch(html, /This page could not be found/)
})

test("unknown routes keep the default tracking-free editorial shell", () => {
  const notFoundSource = readFileSync("src/app/not-found.tsx", "utf8")

  assert.match(notFoundSource, /<EditorialShell>/)
  assert.doesNotMatch(notFoundSource, /bootstrapFunnelContext|funnel\/session|LandingTracking/)
})

test("approved public copy uses serious, non-medical product framing", () => {
  const heroSource = readFileSync("src/components/landing/hero.tsx", "utf8")
  const finalCtaSource = readFileSync("src/components/landing/final-cta.tsx", "utf8")
  const valueSource = readFileSync("src/components/landing/what-you-get.tsx", "utf8")
  const footerSource = readFileSync("src/components/landing/site-footer.tsx", "utf8")
  const faqSource = readFileSync("src/components/landing/faq.tsx", "utf8")
  const analysisSource = readFileSync("src/components/quiz/quiz-analysis.tsx", "utf8")
  const pricingSource = readFileSync("src/components/quiz/result-offer-pricing.tsx", "utf8")
  const planSelectorSource = readFileSync(
    "src/components/checkout/subscription-plan-selector.tsx",
    "utf8",
  )
  const socialImageSource = readFileSync("src/app/opengraph-image.tsx", "utf8")
  const privacySource = readFileSync("src/app/datenschutz/page.tsx", "utf8")
  const termsSource = readFileSync("src/app/agb/page.tsx", "utf8")

  assert.match(heroSource, /In 2 Minuten verstehst du besser/)
  assert.match(finalCtaSource, /Bereit für eine Pflege, die besser zu deinen/)
  assert.match(valueSource, /Keine eigenen Produkte\. Eine persönliche Auswertung/)
  assert.match(valueSource, /Transparente Datennutzung/)
  assert.match(footerSource, /Strukturierte Haarpflege-Auswertung auf Basis deiner Angaben/)
  assert.match(faqSource, /Chaarlie sicher bereitzustellen und zu verbessern/)
  assert.match(analysisSource, /Deine Pflegebedürfnisse werden eingeordnet/)
  assert.match(planSelectorSource, /Details in den Bedingungen/)
  assert.match(socialImageSource, /MÖGLICHES PFLEGEZIEL/)
  assert.match(privacySource, /persönliche Auswertung und Routine/)
  assert.match(termsSource, /Auswertungen, Routinen, Produktempfehlungen/)
  assert.doesNotMatch(heroSource, /was deine Haare[\s\S]*wirklich[\s\S]*brauchen/)
  assert.doesNotMatch(finalCtaSource, /was deine Haare[\s\S]*wirklich[\s\S]*brauchen/)
  assert.doesNotMatch(valueSource, /Eine Diagnose/)
  assert.doesNotMatch(footerSource, /Wissenschaftliche Haaranalyse/)
  assert.doesNotMatch(faqSource, /ausschließlich verwendet/)
  assert.doesNotMatch(analysisSource, /Protein-Feuchtigkeits-Balance wird berechnet/)
  assert.doesNotMatch(pricingSource, /Kein Risiko/)
  assert.doesNotMatch(planSelectorSource, /Kein Risiko/)
  assert.doesNotMatch(socialImageSource, /IN 4 WOCHEN/)
  assert.doesNotMatch(privacySource, /persönliche Diagnose und Routine/)
  assert.doesNotMatch(termsSource, /Diagnosen, Routinen, Produktempfehlungen/)
})
