import assert from "node:assert/strict"
import test from "node:test"

import {
  createScanRevealRouteHandler,
  type ScanRevealRouteDeps,
} from "../src/app/api/scan/reveal/route"
import { SCAN_RATE_LIMIT } from "../src/lib/rate-limit"
import type {
  ScanInCatalogVerdictPayload,
  ScanNotNeededVerdictPayload,
} from "../src/lib/scan/types"

const userId = "11111111-1111-4111-8111-111111111111"
const productId = "22222222-2222-4222-8222-222222222222"
const alternativeId = "33333333-3333-4333-8333-333333333333"

const decision = {
  category: "shampoo" as const,
  resolution: "resolved" as const,
  needTier: "basis" as const,
  roles: ["shampoo_everyday" as const],
  target: null,
  frequency: null,
  reasons: [],
  executionState: "available" as const,
  executionPauseReason: null,
  deferredFacts: [],
}

const snapshot = {
  schemaVersion: 1 as const,
  snapshotKind: "initial_need" as const,
  computationVersion: "v1",
  inputHash: "hash",
  createdAt: "2026-08-01T00:00:00.000Z",
  sourceQuiz: {} as never,
  profile: { hair: { thickness: "normal" } } as never,
  assessments: {} as never,
  decisions: [decision],
  coverage: [],
  productPreviews: [],
  renderedOrder: [],
  deferredFacts: [],
}

const context = {
  snapshot,
  snapshotSource: "refined" as const,
  refinedVersionId: "refined-1",
  refinedInputHash: "input-hash",
}

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
  alternatives: [
    {
      productId: alternativeId,
      displayName: "Sanftes Shampoo",
      imageUrl: null,
      priceLabel: null,
      netContentLabel: "250 ml",
      verdict: "ideal",
      verdictLabel: "Passt",
      criteria: [
        {
          criterionId: "shampoo.scalp_route",
          label: "Kopfhaut-Fokus",
          result: "pass",
          explanation: "x",
        },
      ],
    },
  ],
}

const notNeededVerdict: ScanNotNeededVerdictPayload = {
  kind: "not_needed",
  mode: "not_needed",
  status: "neutral",
  headline: "Du brauchst aktuell keine Maske",
  subtitle: "Keine Maske in deinem Bedarf",
  reasons: [],
  dimensions: [],
  coveredBy: [],
}

const presentationRow = {
  id: alternativeId,
  name: "Sanftes Shampoo",
  brand: "Kérastase",
  category: "shampoo" as const,
  imageUrl: null,
  priceEur: 18,
  currency: "EUR",
  affiliateLink: "https://shop.test/b",
  purchaseLinkStatus: "available" as const,
  priceCheckedAt: "2026-08-19T00:00:00.000Z",
}

function baseDeps(overrides: Partial<ScanRevealRouteDeps> = {}): ScanRevealRouteDeps {
  return {
    getUserId: async () => userId,
    checkRateLimit: async () => ({ allowed: true }),
    createAdminClient: () => ({}) as never,
    isFreemiumScannerFirstEnabled: () => true,
    resolvePaidAccess: async () => "denied",
    consumeFreeReveal: async () => "consumed",
    loadFreeRevealRecord: async () => null,
    loadActiveProductById: async () => ({ id: productId, category: "shampoo" }),
    isProductSearchQuarantined: async () => false,
    loadQuarantinedProductIdsAmong: async () => new Set<string>(),
    loadScanEvaluationContext: async () => context,
    loadScanProductFacts: async () => null,
    loadRecommendationCandidates: async (_client, input) =>
      Object.fromEntries(input.roles.map((role) => [role, []])),
    buildScanVerdict: () => inCatalogVerdict,
    loadPresentationRows: async () => [presentationRow],
    ...overrides,
  }
}

function request(body: unknown) {
  return new Request("http://test/api/scan/reveal", { method: "POST", body: JSON.stringify(body) })
}

test("scan reveal: unauthenticated is rejected", async () => {
  const handler = createScanRevealRouteHandler(baseDeps({ getUserId: async () => null }))
  const response = await handler(request({ productId }))
  assert.equal(response.status, 401)
})

test("scan reveal: rate limited returns 429", async () => {
  const handler = createScanRevealRouteHandler(
    baseDeps({ checkRateLimit: async () => ({ allowed: false }) }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 429)
})

test("scan reveal: invalid body is rejected", async () => {
  const handler = createScanRevealRouteHandler(baseDeps())
  const response = await handler(request({ productId: "not-a-uuid" }))
  assert.equal(response.status, 400)
})

test("scan reveal: denied when the flag is off, before touching any dependency", async () => {
  const handler = createScanRevealRouteHandler(
    baseDeps({
      isFreemiumScannerFirstEnabled: () => false,
      resolvePaidAccess: async () => {
        throw new Error("must not be called")
      },
      consumeFreeReveal: async () => {
        throw new Error("must not be called")
      },
      loadActiveProductById: async () => {
        throw new Error("must not be called")
      },
    }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: "scan_reveal_disabled" })
})

test("scan reveal: an unknown productId 404s", async () => {
  const handler = createScanRevealRouteHandler(
    baseDeps({ loadActiveProductById: async () => null }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: "product_not_found" })
})

test("scan reveal: a quarantined scanned product 404s", async () => {
  const handler = createScanRevealRouteHandler(
    baseDeps({ isProductSearchQuarantined: async () => true }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: "product_not_found" })
})

test("scan reveal: an unavailable paid-access lookup fails closed with 503", async () => {
  const handler = createScanRevealRouteHandler(
    baseDeps({ resolvePaidAccess: async () => "unavailable" }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "temporarily_unavailable" })
})

test("scan reveal: a free user's first reveal consumes the credit and returns full alternatives", async () => {
  const consumeCalls: unknown[] = []
  const handler = createScanRevealRouteHandler(
    baseDeps({
      consumeFreeReveal: async (_client, input) => {
        consumeCalls.push(input)
        return "consumed"
      },
    }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.productId, productId)
  assert.deepEqual(body.alternatives, [
    {
      productId: alternativeId,
      displayName: "Sanftes Shampoo",
      imageUrl: null,
      priceLabel: null,
      netContentLabel: "250 ml",
      verdict: "ideal",
      verdictLabel: "Passt",
      brand: "Kérastase",
      purchaseUrl: "https://shop.test/b",
    },
  ])
  assert.deepEqual(consumeCalls, [{ userId, productId }])
})

test("scan reveal: an already-used credit for a DIFFERENT product is a distinguishable error, no silver reveal", async () => {
  const otherProductId = "44444444-4444-4444-8444-444444444444"
  const handler = createScanRevealRouteHandler(
    baseDeps({
      consumeFreeReveal: async () => "already_used",
      // The ledger's own product_id (fixture: a different product) decides the outcome,
      // not a canned error — this is a genuine conflict, so no re-serve.
      loadFreeRevealRecord: async () => ({ productId: otherProductId }),
    }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: "already_used" })
})

test("scan reveal: an already-used credit for the SAME product re-serves the reveal (keepsake rule, F1-adjunct)", async () => {
  const handler = createScanRevealRouteHandler(
    baseDeps({
      consumeFreeReveal: async () => "already_used",
      loadFreeRevealRecord: async () => ({ productId }),
    }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.productId, productId)
  assert.equal(body.alternatives.length, 1)
})

test("scan reveal: the verdict is computed BEFORE the credit is spent (F1) — a downstream failure spends nothing", async () => {
  const consumeCalls: unknown[] = []
  const handler = createScanRevealRouteHandler(
    baseDeps({
      buildScanVerdict: () => {
        throw new Error("boom")
      },
      consumeFreeReveal: async (_client, input) => {
        consumeCalls.push(input)
        return "consumed"
      },
    }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 503)
  assert.deepEqual(consumeCalls, [])
})

test("scan reveal: a missing profile is checked before the credit is spent", async () => {
  const handler = createScanRevealRouteHandler(
    baseDeps({
      loadScanEvaluationContext: async () => null,
      consumeFreeReveal: async () => {
        throw new Error("must not spend the credit when the profile is missing")
      },
    }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: "profile_missing" })
})

test("scan reveal: a premium user never consumes a credit", async () => {
  const handler = createScanRevealRouteHandler(
    baseDeps({
      resolvePaidAccess: async () => "allowed",
      consumeFreeReveal: async () => {
        throw new Error("premium must not spend the credit")
      },
    }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.alternatives.length, 1)
})

test("scan reveal: a not_needed verdict has nothing to reveal, and spends no credit (F1)", async () => {
  const consumeCalls: unknown[] = []
  const handler = createScanRevealRouteHandler(
    baseDeps({
      buildScanVerdict: () => notNeededVerdict,
      consumeFreeReveal: async (_client, input) => {
        consumeCalls.push(input)
        return "consumed"
      },
    }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.alternatives, [])
  assert.deepEqual(consumeCalls, [])
})

test("scan reveal: a quarantined alternative is never revealed (ruling R7), and spends no credit (F1)", async () => {
  const consumeCalls: unknown[] = []
  const handler = createScanRevealRouteHandler(
    baseDeps({
      loadQuarantinedProductIdsAmong: async () => new Set([alternativeId]),
      consumeFreeReveal: async (_client, input) => {
        consumeCalls.push(input)
        return "consumed"
      },
    }),
  )
  const response = await handler(request({ productId }))
  const body = await response.json()
  assert.deepEqual(body.alternatives, [])
  assert.deepEqual(consumeCalls, [])
})
