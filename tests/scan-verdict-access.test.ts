import assert from "node:assert/strict"
import test from "node:test"

import type { ScanMaskedVerdictResult } from "../src/lib/scan/masked-alternative"
import type { ScanResolvedVerdictResult } from "../src/lib/scan/types"
import {
  isMaskedScanVerdict,
  nextScanTierSignal,
  scanRevealCta,
  scanTierSignal,
} from "../src/lib/scan/verdict-access"

/**
 * The free-tier verdict UI is gated on the RESPONSE SHAPE (T9). These are the predicates
 * that make that gate: everything downstream — masked comparison table, reveal CTA, the
 * Merken lock — hangs off them, so a premium or flag-off response answering "free" here
 * would be the whole regression.
 */

const product = {
  productId: "aaaaaaaa-0000-4000-8000-000000000001",
  name: "Lab Shampoo Alpha",
  brand: "Chaarlie Lab",
  category: "shampoo" as const,
  categoryLabel: "Shampoo",
  imageUrl: null,
  priceLabel: null,
  purchaseUrl: null,
}

const inCatalogBase = {
  kind: "in_catalog" as const,
  verdict: "mismatch" as const,
  verdictLabel: "Passt nicht",
  verdictTitle: "Passt nicht zu deinem Haar",
  status: "danger" as const,
  subtitle: "1 von 3 Zielbereichen getroffen",
  evaluatedRole: null,
  evaluatedRoleLabel: null,
  dimensions: [],
  criteria: [],
  coverage: null,
  fitNarrative: null,
  product,
  snapshotSource: "refined" as const,
  savedState: { state: null, managedByScan: false },
}

const premiumResult: ScanResolvedVerdictResult = { ...inCatalogBase, alternatives: [] }

const maskedResult: ScanMaskedVerdictResult = {
  ...inCatalogBase,
  alternatives: [],
  freeRevealAvailable: true,
}

const notNeededResult: ScanResolvedVerdictResult = {
  kind: "not_needed",
  mode: "not_needed",
  status: "neutral",
  headline: "Brauchst du nicht",
  subtitle: "Dein Plan deckt das schon ab.",
  reasons: [],
  dimensions: [],
  coveredBy: [],
  product,
  snapshotSource: "refined",
  savedState: { state: null, managedByScan: false },
}

test("isMaskedScanVerdict: only a response carrying freeRevealAvailable is masked", () => {
  assert.equal(isMaskedScanVerdict(maskedResult), true)
  assert.equal(isMaskedScanVerdict({ ...maskedResult, freeRevealAvailable: false }), true)
  assert.equal(isMaskedScanVerdict(premiumResult), false)
  assert.equal(isMaskedScanVerdict(notNeededResult), false)
})

test("scanTierSignal: an in_catalog verdict is the only evidence of a tier", () => {
  assert.equal(scanTierSignal(maskedResult), "free")
  assert.equal(scanTierSignal(premiumResult), "premium")
  // `not_needed` is served identically to both tiers, so it proves nothing either way.
  assert.equal(scanTierSignal(notNeededResult), "unknown")
  assert.equal(
    scanTierSignal({
      kind: "unknown_product",
      identifier: { type: "ean", value: "4006381333931" },
      categories: [],
    }),
    "unknown",
  )
  assert.equal(
    scanTierSignal({
      kind: "pending_submission",
      submissionId: "s1",
      headline: "Wir schauen uns das an",
      status: "pending_review",
    }),
    "unknown",
  )
})

test("nextScanTierSignal: a proven tier survives a later verdict that carries no evidence", () => {
  assert.equal(nextScanTierSignal("free", "unknown"), "free")
  assert.equal(nextScanTierSignal("premium", "unknown"), "premium")
  assert.equal(nextScanTierSignal("unknown", "free"), "free")
  assert.equal(nextScanTierSignal("unknown", "premium"), "premium")
  // A real change of evidence still wins (the same session after a purchase).
  assert.equal(nextScanTierSignal("free", "premium"), "premium")
})

test("scanRevealCta: the reveal is offered only while the credit is genuinely unspent", () => {
  assert.equal(scanRevealCta({ freeRevealAvailable: true, revealUnavailable: false }), "reveal")
  assert.equal(scanRevealCta({ freeRevealAvailable: false, revealUnavailable: false }), "premium")
  // 409 `already_used`: the server has since proven the credit is gone.
  assert.equal(scanRevealCta({ freeRevealAvailable: true, revealUnavailable: true }), "premium")
})
