import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { PersonalPlanFieldTestBanner } from "../src/components/personal-plan-quiz/personal-plan-quiz"
import { PersonalPlanOffer } from "../src/components/personal-plan-offer/personal-plan-offer"
import { PersonalPlanFieldTestEnded } from "../src/components/personal-plan-field-test/personal-plan-field-test-ended"
import { ResultPageClient } from "../src/app/result/[leadId]/result-client"

const quizSource = readFileSync(
  new URL("../src/components/personal-plan-quiz/personal-plan-quiz.tsx", import.meta.url),
  "utf8",
)
const resultPageSource = readFileSync(
  new URL("../src/app/result/[leadId]/page.tsx", import.meta.url),
  "utf8",
)

test("field-test quiz presents the approved persistent German banner", () => {
  const html = renderToStaticMarkup(<PersonalPlanFieldTestBanner surface="quiz" />)

  assert.match(html, /Kostenloser Chaarlie Produkttest · keine Zahlung erforderlich/)
  assert.match(html, /data-personal-plan-field-test-banner="quiz"/)
})

test("field-test offer replaces all payment presentation with the free activation card", () => {
  const html = renderToStaticMarkup(
    <PersonalPlanOffer
      entryContext="quiz_completion"
      fieldTest
      leadId="11111111-1111-4111-8111-111111111111"
      model={{
        planTitle: "Dein Haarplan",
        planFitStatement: "Passt zu dir.",
        diagnosticRows: [
          {
            id: "one",
            title: "Eins",
            todayLabel: "Heute",
            potentialLabel: "Ziel",
            todaySegments: 1,
            potentialSegments: 2,
            summary: "Text",
          },
          {
            id: "two",
            title: "Zwei",
            todayLabel: "Heute",
            potentialLabel: "Ziel",
            todaySegments: 1,
            potentialSegments: 2,
            summary: "Text",
          },
          {
            id: "three",
            title: "Drei",
            todayLabel: "Heute",
            potentialLabel: "Ziel",
            todaySegments: 1,
            potentialSegments: 2,
            summary: "Text",
          },
        ],
      }}
    />,
  )

  assert.match(html, /data-personal-plan-field-test-card=""/)
  assert.match(html, /0 €/)
  assert.match(html, /Keine Zahlungsdaten · kein Abo · zeitlich begrenzter Testzugang/)
  assert.doesNotMatch(html, /data-offer-checkout|Stripe|PayPal/)
  assert.doesNotMatch(html, /nach dem Kauf|Rückerstattung|Geld-zurück-Garantie/)
})

test("lost field-test authorization renders a dedicated non-commercial end state", () => {
  const html = renderToStaticMarkup(
    <ResultPageClient
      fieldTestUnavailable
      focusRoutine={false}
      hasAccess={false}
      leadId="11111111-1111-4111-8111-111111111111"
      name="Lea"
      personalPlanOffer={null}
      quizAnswers={null}
      quizKind="personal_plan"
    />,
  )

  assert.match(html, /Dein Testzugang ist nicht mehr verfügbar/)
  assert.match(html, /Chaarlie-Team/)
  assert.doesNotMatch(html, /Stripe|PayPal|Plan sichern|reactivate|checkout/i)
})

test("dedicated field-test end surface stays concise and payment-free", () => {
  const html = renderToStaticMarkup(<PersonalPlanFieldTestEnded />)
  assert.match(html, /Testzeitraum ist beendet oder der Zugang wurde geschlossen/)
  assert.doesNotMatch(html, /Abo|Zahlung|Stripe|PayPal|Preis/)
})

test("field-test lead binding must succeed before the quiz can open a result", () => {
  const attachmentGuard = quizSource.indexOf("fieldTest && fieldTestAttached !== true")
  const resultNavigation = quizSource.indexOf(
    "await onSaved(leadId, address, capability)",
    attachmentGuard,
  )
  assert.ok(attachmentGuard > -1)
  assert.ok(resultNavigation > attachmentGuard)
  assert.match(quizSource.slice(attachmentGuard, resultNavigation), /return/)
})

test("result routing preserves persisted field-test intent after authorization loss", () => {
  assert.match(resultPageSource, /hasPersonalPlanFieldTestOfferIntent/)
  assert.match(
    resultPageSource,
    /fieldTestUnavailable = fieldTestIntent && !fieldTestAuthorization/,
  )
  assert.match(resultPageSource, /baseOfferTracking\s*=\s*hasAccess\s*\|\|\s*fieldTestUnavailable/)
})

test("moderator offer promises account return and ninety days without guest-browser limits", () => {
  const html = renderToStaticMarkup(
    <PersonalPlanOffer
      entryContext="quiz_completion"
      fieldTest
      moderatorTest
      leadId="11111111-1111-4111-8111-111111111111"
      model={{
        planTitle: "Dein Haarplan",
        planFitStatement: "Passt zu dir.",
        diagnosticRows: [
          {
            id: "one",
            title: "Bedarf",
            todayLabel: "Heute",
            potentialLabel: "Ziel",
            todaySegments: 1,
            potentialSegments: 2,
            summary: "Text",
          },
          {
            id: "two",
            title: "Bedarf",
            todayLabel: "Heute",
            potentialLabel: "Ziel",
            todaySegments: 1,
            potentialSegments: 2,
            summary: "Text",
          },
          {
            id: "three",
            title: "Bedarf",
            todayLabel: "Heute",
            potentialLabel: "Ziel",
            todaySegments: 1,
            potentialSegments: 2,
            summary: "Text",
          },
        ],
      }}
    />,
  )
  assert.match(html, /90 Tage ab Aktivierung/)
  assert.match(html, /Konto gespeichert/)
  assert.doesNotMatch(
    html,
    /sieben Tage in diesem Browser|data-offer-checkout|Stripe|PayPal|Rückerstattung/,
  )
})
