import assert from "node:assert/strict"
import test from "node:test"

import { orderedBenefits } from "../src/lib/premium-sheet/ordered-benefits"
import type { PremiumFeatureId } from "../src/lib/premium-sheet/context"

/**
 * T5 — pure benefit-ordering helper. Final algorithm (PR4 reuses it verbatim): the tapped
 * feature always leads, the remaining two slots are filled from the core order
 * ["routine", "empfehlungen", "chat", "anwendung"] with the tapped feature excluded (a
 * no-op exclusion when the tapped feature isn't part of the core order at all — the three
 * "profile-ish" features merkliste/haarcheck/verfeinerung fall into that case).
 */

test("null context falls back to the first three core-order features", () => {
  assert.deepEqual(orderedBenefits(null), ["routine", "empfehlungen", "chat"])
})

const cases: Array<{ feature: PremiumFeatureId; expected: PremiumFeatureId[] }> = [
  { feature: "routine", expected: ["routine", "empfehlungen", "chat"] },
  { feature: "empfehlungen", expected: ["empfehlungen", "routine", "chat"] },
  { feature: "chat", expected: ["chat", "routine", "empfehlungen"] },
  { feature: "anwendung", expected: ["anwendung", "routine", "empfehlungen"] },
  { feature: "merkliste", expected: ["merkliste", "routine", "empfehlungen"] },
  { feature: "haarcheck", expected: ["haarcheck", "routine", "empfehlungen"] },
  { feature: "verfeinerung", expected: ["verfeinerung", "routine", "empfehlungen"] },
]

for (const { feature, expected } of cases) {
  test(`tapped feature "${feature}" leads, followed by core order minus itself`, () => {
    const result = orderedBenefits({ feature, source: "test" })
    assert.deepEqual(result, expected)
    assert.equal(result.length, 3)
    assert.equal(result[0], feature)
  })
}

test("every result is free of duplicate feature ids", () => {
  const allFeatures: PremiumFeatureId[] = [
    "empfehlungen",
    "merkliste",
    "routine",
    "anwendung",
    "chat",
    "haarcheck",
    "verfeinerung",
  ]
  for (const feature of allFeatures) {
    const result = orderedBenefits({ feature, source: "test" })
    assert.equal(new Set(result).size, result.length)
  }
})
