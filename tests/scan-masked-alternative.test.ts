import assert from "node:assert/strict"
import test from "node:test"

import {
  maskAlternative,
  maskScanVerdictPayload,
  type ScanMaskedAlternative,
} from "../src/lib/scan/masked-alternative"
import type { ScanAlternative, ScanInCatalogVerdictPayload } from "../src/lib/scan/types"

const alternativeId = "33333333-3333-4333-8333-333333333333"

function alternative(overrides: Partial<ScanAlternative> = {}): ScanAlternative {
  return {
    productId: alternativeId,
    displayName: "Sanftes Shampoo",
    imageUrl: "https://example.test/a.jpg",
    priceLabel: "18,00 €",
    netContentLabel: "250 ml",
    verdict: "ideal",
    verdictLabel: "Passt",
    criteria: [
      {
        criterionId: "shampoo.scalp_route",
        label: "Kopfhaut-Fokus",
        result: "pass",
        explanation: "Erfüllt deinen bestätigten Kopfhaut-Bedarf.",
      },
    ],
    ...overrides,
  }
}

test("maskAlternative: withholds identity, productId, image, price and net content", () => {
  const masked = maskAlternative(alternative())
  assert.deepEqual(Object.keys(masked).sort(), ["comparison", "verdict", "verdictLabel"])
})

test("maskAlternative: keeps the alternative's own verdict and verdict label", () => {
  const masked = maskAlternative(
    alternative({ verdict: "supportive", verdictLabel: "Passt eingeschränkt" }),
  )
  assert.equal(masked.verdict, "supportive")
  assert.equal(masked.verdictLabel, "Passt eingeschränkt")
})

test("maskAlternative: derives comparison rows from the alternative's own criteria", () => {
  const masked = maskAlternative(alternative())
  assert.deepEqual(masked.comparison.rows, [
    { rowId: "shampoo.scalp_route", label: "Kopfhaut-Fokus", state: "match" },
  ])
  assert.equal(masked.comparison.summaryScore, 1)
})

test("maskAlternative: an alternative with no carried criteria yields an empty comparison", () => {
  const masked = maskAlternative(alternative({ criteria: undefined }))
  assert.deepEqual(masked.comparison, { rows: [], summaryScore: 0 })
})

test("maskAlternative: does not mutate the input", () => {
  const source = alternative()
  const snapshot = JSON.parse(JSON.stringify(source))
  maskAlternative(source)
  assert.deepEqual(source, snapshot)
})

const inCatalogVerdict: ScanInCatalogVerdictPayload = {
  kind: "in_catalog",
  verdict: "mismatch",
  verdictLabel: "Passt nicht",
  verdictTitle: "Passt nicht zu deinem Haar",
  status: "danger",
  subtitle: "1 von 3 Zielbereichen getroffen",
  evaluatedRole: null,
  evaluatedRoleLabel: null,
  dimensions: [],
  criteria: [],
  coverage: { matches: 1, total: 3 },
  fitNarrative: null,
  alternatives: [alternative(), alternative({ productId: "44444444-4444-4444-8444-444444444444" })],
}

test("maskScanVerdictPayload: masks every alternative, leaves every other field untouched", () => {
  const masked = maskScanVerdictPayload(inCatalogVerdict)
  assert.equal(masked.alternatives.length, 2)
  assert.equal(masked.verdictTitle, inCatalogVerdict.verdictTitle)
  assert.equal(masked.coverage, inCatalogVerdict.coverage)
  assert.equal(masked.dimensions, inCatalogVerdict.dimensions)
  for (const entry of masked.alternatives as ScanMaskedAlternative[]) {
    assert.deepEqual(Object.keys(entry).sort(), ["comparison", "verdict", "verdictLabel"])
  }
})

test("maskScanVerdictPayload: an empty alternatives list stays empty", () => {
  const masked = maskScanVerdictPayload({ ...inCatalogVerdict, alternatives: [] })
  assert.deepEqual(masked.alternatives, [])
})
