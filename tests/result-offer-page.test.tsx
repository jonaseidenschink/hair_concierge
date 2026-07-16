import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { OfferPreviewRoutine } from "../src/components/quiz/offer-preview-routine"
import { QuizResultOfferPageShell } from "../src/components/quiz/quiz-result-offer-page"
import AppValueStackOfferVariant from "../src/funnels/offers/app-value-stack"
import { buildQuizOfferPreview } from "../src/lib/quiz/offer-preview"
import { buildQuizResultNarrative } from "../src/lib/quiz/result-narrative"
import type { QuizAnswers } from "../src/lib/quiz/types"

const quizAnswers: QuizAnswers = {
  structure: "wavy",
  thickness: "normal",
  density: "medium",
  fingertest: "leicht_uneben",
  pulltest: "stretches_stays",
  scalp_type: "ausgeglichen",
  has_scalp_issue: false,
  concerns: ["breakage"],
  treatment: ["natur"],
  goals: ["strengthen"],
}

test("result offer page renders the product-led hierarchy, routine preview, and existing pricing", () => {
  const narrative = buildQuizResultNarrative(quizAnswers)
  const html = renderToStaticMarkup(
    <QuizResultOfferPageShell name="Sarah" narrative={narrative} quizAnswers={quizAnswers} />,
  )

  assert.match(html, /Sarah, wir kennen jetzt die Bedürfnisse deiner Haare/i)
  assert.match(html, /Deine Analyse ist der Anfang\. Chaarlie macht sie anwendbar\./i)
  assert.match(html, /Das wissen wir schon aus deinem Quiz/i)
  assert.match(html, /Daraus ergibt sich deine Mini-Routine/i)
  assert.match(html, /Shampoo · Beispiel/i)
  assert.match(html, /Conditioner · Beispiel/i)
  assert.match(html, /Dein nächster Pflegeschritt/i)
  assert.match(html, /Protein-Maske/i)
  assert.equal((html.match(/data-testid="locked-routine-placeholder"/g) ?? []).length, 2)
  assert.doesNotMatch(html, /Neqi Peptide Power|Alle 2–3 Haarwäschen/i)
  assert.match(html, /noch nicht deine finalen Produktempfehlungen/i)
  assert.match(html, /id="unlock-plan"/i)
  assert.match(html, /Chaarlie finalisiert deinen persönlichen Plan/i)
  assert.match(html, /Das kaufst du – nicht nur ein Quiz-Ergebnis/i)
  assert.match(html, /Antworten, wenn die nächste Frage kommt/i)
  assert.match(html, /Was, wann und in welcher Reihenfolge/i)
  assert.match(html, /Warum Chaarlie ein Abo ist/i)
  assert.match(html, /500\+/i)
  assert.match(html, /erfasste Produkte/i)
  assert.match(html, /keine eigene Produktlinie/i)
  assert.match(html, /id="pricing"/i)
  assert.match(html, /Monatlich/i)
  assert.match(html, /€14,99/i)
  assert.match(html, /Quartal/i)
  assert.match(html, /€34,99/i)
  assert.match(html, /Beliebteste Wahl/i)
  assert.match(html, /Jährlich/i)
  assert.match(html, /€99,99/i)
  assert.match(html, /14 Tage Geld-zurück-Garantie/i)
  assert.match(html, /Was passiert direkt nach der Zahlung/i)
  assert.match(html, /Sind die Produkte auf dieser Seite schon meine finalen Empfehlungen/i)
  assert.doesNotMatch(html, /Angebot läuft ab|Danach zum regulären Preis|In 4 Wochen|30-Tage-Plan/i)
  assert.doesNotMatch(html, /Kopfhautserum|Dry.Shampoo|Haarmony|>Tom</i)

  const sectionIds = Array.from(html.matchAll(/data-offer-section="([^"]+)"/g), (match) => match[1])
  assert.deepEqual(sectionIds, [
    "personalized_analysis",
    "mini_routine",
    "locked_routine",
    "unlock_explanation",
    "product_story_chat",
    "product_story_routine",
    "product_story_products",
    "subscription_explanation",
    "pricing",
    "guarantee",
    "faq",
    "final_cta",
  ])
  assert.deepEqual(
    new Set(Array.from(html.matchAll(/data-offer-cta="([^"]+)"/g), (match) => match[1])),
    new Set(["sticky_header", "locked_plan", "final"]),
  )
  assert.equal((html.match(/data-offer-faq=/g) ?? []).length, 6)
})

test("result offer page preserves legacy routine-return context and both fixed-header anchors", () => {
  const narrative = buildQuizResultNarrative(quizAnswers)
  const html = renderToStaticMarkup(
    <QuizResultOfferPageShell
      name="Sarah"
      narrative={narrative}
      quizAnswers={quizAnswers}
      focusRoutine
    />,
  )

  assert.match(html, /Weiter mit deiner vollständigen Routine/i)
  assert.match(html, /Weiter mit deiner Routine/i)
  assert.match(html, /id="unlock-plan"[^>]*scroll-mt-\[76px\]/i)
  assert.match(html, /id="pricing"[^>]*scroll-mt-\[76px\]/i)
  assert.doesNotMatch(html, /Angebot:/i)
})

test("routine preview keeps a generic locked continuation when no third category is justified", () => {
  const preview = buildQuizOfferPreview({
    ...quizAnswers,
    concerns: [],
    fingertest: "glatt",
    goals: [],
    pulltest: "stretches_bounces",
  })
  const html = renderToStaticMarkup(<OfferPreviewRoutine preview={preview} />)

  assert.equal(preview.lane, "base")
  assert.equal(preview.needs.extra, null)
  assert.match(html, /data-offer-section="locked_routine"/)
  assert.match(html, /Dein vollständiger Plan/i)
  assert.match(html, /Deine weiteren Pflegeschritte/i)
  assert.equal((html.match(/data-testid="locked-routine-placeholder"/g) ?? []).length, 2)
  assert.match(html, /Shampoo · Beispiel/i)
  assert.match(html, /Conditioner · Beispiel/i)
  assert.doesNotMatch(html, /Dein nächster Pflegeschritt/i)
  assert.doesNotMatch(html, /Protein-Maske|Feuchtigkeitsmaske|Leave-in|Haaröl|Bondbuilder/i)
})

test("app value stack renders the approved quiz-to-product-to-pricing hierarchy", () => {
  const narrative = buildQuizResultNarrative(quizAnswers)
  const html = renderToStaticMarkup(
    <AppValueStackOfferVariant
      entryContext="quiz_completion"
      leadId={null}
      name="Sarah Beispiel"
      narrative={narrative}
      offerVariant="app-value-stack"
      quizAnswers={quizAnswers}
      pricingSlot={<div data-testid="pricing-slot">pricing-slot-marker</div>}
    />,
  )
  const visibleText = html.replace(/<[^>]+>/g, " ")

  assert.match(html, /Quiz ausgewertet/i)
  assert.match(html, /Sarah, dein 4-Wochen-Weg/i)
  assert.match(html, /Deine Pflegebasis/i)
  assert.match(html, /Diese drei Punkte bestimmen, womit deine Routine startet/i)
  assert.equal((html.match(/data-testid="app-value-stack-signal"/g) ?? []).length, 3)
  assert.match(html, /Daraus entsteht dein Start/i)
  assert.match(html, /Shampoo · Beispiel/i)
  assert.match(html, /Conditioner · Beispiel/i)
  assert.equal((html.match(/data-testid="app-value-stack-foundation-product"/g) ?? []).length, 2)
  assert.match(html, /noch nicht deine finalen Produktempfehlungen/i)
  assert.match(html, /Maske &amp; Öle|Weitere Pflege/i)
  assert.match(html, /Tools/i)
  assert.equal((html.match(/data-testid="app-value-stack-locked-cell"/g) ?? []).length, 3)
  assert.match(html, /Deine Routine ist erst der Anfang/i)
  assert.match(html, /So begleitet dich Chaarlie/i)
  assert.match(html, /Von deiner Routine bis zur konkreten Produktfrage/i)
  assert.match(html, /Deine Routine auf einen Blick/i)
  assert.match(html, /Frag Chaarlie zu deinem Haar/i)
  assert.match(html, /Frag nach Produkten, die zu dir passen/i)
  assert.match(html, /app-routine\.png/i)
  assert.match(html, /app-product-details\.png/i)
  assert.match(html, /app-chat\.png/i)
  assert.ok(html.indexOf("app-routine.png") < html.indexOf("app-chat.png"))
  assert.ok(html.indexOf("app-chat.png") < html.indexOf("app-product-details.png"))
  assert.match(html, /Entwickelt mit Erkenntnissen aus über 4\.000 Antworten/i)
  assert.match(html, /Das sagen Chaarlie-Kundinnen/i)
  assert.match(html, /L\. · Chaarlie-Kundin/i)
  assert.match(html, /A\. · Chaarlie-Kundin/i)
  assert.match(html, /M\. · Chaarlie-Kundin/i)
  assert.equal((html.match(/aria-label="5 von 5 Sternen"/g) ?? []).length, 3)
  assert.equal((html.match(/über 4\.000 Antworten/g) ?? []).length, 1)
  assert.match(html, /Aus deiner Pflegebasis wird eine Routine, die im Alltag funktioniert/i)
  assert.equal((html.match(/pricing-slot-marker/g) ?? []).length, 1)
  assert.match(html, /Was passiert direkt nach der Zahlung/i)
  assert.equal((html.match(/Routine freischalten/g) ?? []).length, 3)
  assert.match(html, /14 Tage Geld-zurück · zum Laufzeitende kündbar/i)
  assert.match(html, /id="unlock-plan"[^>]*scroll-mt-\[76px\]/i)
  assert.match(html, /id="pricing"[^>]*scroll-mt-\[76px\]/i)

  const sectionIds = Array.from(html.matchAll(/data-offer-section="([^"]+)"/g), (match) => match[1])
  assert.deepEqual(sectionIds, [
    "personalized_analysis",
    "mini_routine",
    "locked_routine",
    "unlock_explanation",
    "product_story_routine",
    "product_story_chat",
    "product_story_products",
    "pricing",
    "faq",
    "final_cta",
  ])
  assert.deepEqual(
    new Set(Array.from(html.matchAll(/data-offer-cta="([^"]+)"/g), (match) => match[1])),
    new Set(["sticky_header", "locked_plan", "final"]),
  )
  assert.equal((html.match(/data-offer-faq=/g) ?? []).length, 6)

  assert.doesNotMatch(visibleText, /Wort der Gründer|Founder|Gründerbrief/i)
  assert.doesNotMatch(visibleText, /4\.000 (?:Produkte|Empfehlungen|Checks|Analysen)/i)
  assert.doesNotMatch(visibleText, /heute dran|Tracking|Streak|nie wieder|sofort|rund um die Uhr/i)
  assert.doesNotMatch(visibleText, /Jonas|Angebot läuft ab|Countdown|Woche für Woche besser/i)
})

test("app value stack keeps routine-return context without duplicating checkout", () => {
  const narrative = buildQuizResultNarrative(quizAnswers)
  const html = renderToStaticMarkup(
    <AppValueStackOfferVariant
      entryContext="routine_return"
      leadId={null}
      name="Sarah"
      narrative={narrative}
      offerVariant="app-value-stack"
      quizAnswers={quizAnswers}
      pricingSlot={<div>pricing-slot-marker</div>}
      focusRoutine
    />,
  )

  assert.match(html, /Weiter mit deiner Routine/i)
  assert.equal((html.match(/pricing-slot-marker/g) ?? []).length, 1)
  assert.match(html, /id="unlock-plan"[^>]*scroll-mt-\[76px\]/i)
  assert.match(html, /id="pricing"[^>]*scroll-mt-\[76px\]/i)
})
