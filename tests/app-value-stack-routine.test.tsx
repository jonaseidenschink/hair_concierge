import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { AppValueStackRoutine } from "../src/components/quiz/app-value-stack-routine"
import type {
  OfferPreviewCategory,
  OfferPreviewProductCard,
  QuizOfferPreview,
} from "../src/lib/quiz/offer-preview-types"

function product(
  category: OfferPreviewCategory,
  suggested: boolean,
  name: string = category,
): OfferPreviewProductCard {
  return {
    key: `${category}-${suggested}`,
    category,
    categoryLabel:
      category === "shampoo"
        ? "Shampoo · Beispiel"
        : category === "conditioner"
          ? "Conditioner · Beispiel"
          : category,
    name,
    imageUrl: `https://example.com/${category}.png`,
    note: `${name} als Beispiel`,
    cadence: { label: "Bei jeder Haarwäsche" },
    suggested,
  }
}

function preview(extraCategory: OfferPreviewCategory | null): QuizOfferPreview {
  return {
    lane: extraCategory ? "protein" : "base",
    headline: "Pflegebasis",
    summary: "Zusammenfassung",
    signals: [
      { label: "Kopfhaut", conclusion: "Milde Reinigung." },
      { label: "Haarstärke", conclusion: "Ausgewogene Pflege." },
      { label: "Pflegefokus", conclusion: "Einfach starten." },
    ],
    needs: {
      shampoo: {
        scalpRoute: "balanced",
        thickness: "normal",
        cleansingIntensity: "regular",
        cadence: { label: "2x/Woche" },
      },
      conditioner: {
        weight: "medium",
        balance: "balanced",
        cadence: { label: "Bei jeder Haarwäsche" },
      },
      extra: null,
    },
    products: [
      product("shampoo", false, "Beispiel-Shampoo"),
      product("conditioner", false, "Beispiel-Conditioner"),
      ...(extraCategory ? [product(extraCategory, true, "Gesperrter Vorschlag")] : []),
    ],
  }
}

function occurrences(html: string, value: string): number {
  return html.split(value).length - 1
}

test("groups three numbered signals and renders only two foundation examples", () => {
  const html = renderToStaticMarkup(<AppValueStackRoutine preview={preview("leave_in")} />)

  assert.match(html, /Deine Pflegebasis/)
  assert.match(html, /Diese drei Punkte bestimmen, womit deine Routine startet\./)
  assert.equal(occurrences(html, 'data-testid="app-value-stack-signal"'), 3)
  assert.match(html, />1<\/span>/)
  assert.match(html, />2<\/span>/)
  assert.match(html, />3<\/span>/)
  assert.equal(occurrences(html, 'data-testid="app-value-stack-foundation-product"'), 2)
  assert.match(html, /Beispiel-Shampoo/)
  assert.match(html, /Beispiel-Conditioner/)
  assert.match(html, /Shampoo · Beispiel/)
  assert.match(html, /Conditioner · Beispiel/)
  assert.doesNotMatch(html, /Beispiel · Shampoo · Beispiel/)
  assert.doesNotMatch(html, /Beispiel · Conditioner · Beispiel/)
  assert.doesNotMatch(html, /Gesperrter Vorschlag/)
  assert.equal(occurrences(html, "bg-[#F3EFE8]"), 2)
  assert.match(html, /Das sind noch nicht deine finalen Produktempfehlungen\./)
})

test("uses a non-empty fallback and three compact locks when no suggestion exists", () => {
  const html = renderToStaticMarkup(<AppValueStackRoutine preview={preview(null)} />)

  assert.equal(occurrences(html, 'data-testid="app-value-stack-locked-cell"'), 3)
  assert.match(html, /Weitere Pflege/)
  assert.match(html, /Maske &amp; Öle/)
  assert.match(html, /Tools/)
  assert.match(html, /aria-describedby="app-value-stack-lock-explanation"/)
  assert.match(html, /Diese Bausteine gehören zu deiner vollständigen Routine\./)
  assert.doesNotMatch(html, /<svg[^>]*aria-hidden="false"/)
})

for (const [category, expectedTitle] of [
  ["protein_mask", "Protein-Maske"],
  ["moisture_mask", "Feuchtigkeitsmaske"],
  ["oil", "Haaröl"],
] as const) {
  test(`avoids a repeated mask/oil lock after ${category}`, () => {
    const html = renderToStaticMarkup(<AppValueStackRoutine preview={preview(category)} />)

    assert.match(html, new RegExp(expectedTitle))
    assert.match(html, /Weitere Pflege/)
    assert.doesNotMatch(html, /Maske &amp; Öle/)
  })
}

test("keeps the general mask and oil lock for non-mask suggestions", () => {
  const html = renderToStaticMarkup(<AppValueStackRoutine preview={preview("bondbuilder")} />)

  assert.match(html, /Bondbuilder/)
  assert.match(html, /Maske &amp; Öle/)
})
