import assert from "node:assert/strict"
import test from "node:test"

import {
  createScanResolveRouteHandler,
  type ScanResolveRouteDeps,
} from "../src/app/api/scan/resolve/route"

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

const inCatalogVerdict = {
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
  coverage: { matches: 1, total: 3 },
  fitNarrative: null,
  alternatives: [
    {
      productId: alternativeId,
      displayName: "Sanftes Shampoo",
      imageUrl: "https://example.test/alt.jpg",
      priceLabel: "18,00 €",
      netContentLabel: "250 ml",
      verdict: "ideal" as const,
      verdictLabel: "Passt",
      criteria: [
        {
          criterionId: "shampoo.scalp_route",
          label: "Kopfhaut-Fokus",
          result: "pass" as const,
          explanation: "Erfüllt deinen bestätigten Kopfhaut-Bedarf.",
        },
        {
          criterionId: "shampoo.cleansing_intensity",
          label: "Reinigungsstärke",
          result: "caution" as const,
          explanation: "Etwas milder als dein Zielbereich.",
        },
      ],
    },
  ],
}

const notNeededVerdict = {
  kind: "not_needed" as const,
  mode: "not_needed" as const,
  status: "neutral" as const,
  headline: "Du brauchst aktuell keine Maske",
  subtitle: "Keine Maske in deinem Bedarf",
  reasons: [],
  dimensions: [],
  coveredBy: [],
}

const presentationRow = {
  id: productId,
  name: "Repair Shampoo",
  brand: "Olaplex",
  category: "shampoo" as const,
  imageUrl: null,
  priceEur: 24.9,
  currency: "EUR",
  affiliateLink: "https://shop.test/a",
  purchaseLinkStatus: "available" as const,
  priceCheckedAt: "2026-08-19T00:00:00.000Z",
}

const alternativePresentationRow = {
  ...presentationRow,
  id: alternativeId,
  name: "Sanftes Shampoo",
  brand: "Kérastase",
  affiliateLink: "https://shop.test/b",
}

function baseDeps(overrides: Partial<ScanResolveRouteDeps> = {}): ScanResolveRouteDeps {
  return {
    getUserId: async () => userId,
    checkRateLimit: async () => ({ allowed: true }),
    createAdminClient: () => ({}) as never,
    validateEanInput: () => ({ ok: true, type: "ean", value: "4006381333931" }),
    findOpenScanSubmission: async () => null,
    createScanResolveAttemptId: () => "attempt-1",
    recordScanResolveAttempt: async () => {},
    completeScanResolveAttempt: async () => {},
    lookupCatalogProductByIdentifier: async () => ({ productId, category: "shampoo" }),
    isProductSearchQuarantined: async () => false,
    loadQuarantinedProductIdsAmong: async () => new Set<string>(),
    loadScanEvaluationContext: async () => context,
    loadScanProductFacts: async () => null,
    loadRecommendationCandidates: async (_client, input) =>
      Object.fromEntries(input.roles.map((role) => [role, []])),
    loadScanSavedState: async () => ({ state: null, managedByScan: false }),
    buildScanVerdict: () => inCatalogVerdict,
    loadActiveProductById: async () => ({ id: productId, category: "shampoo" }),
    loadPresentationRows: async () => [presentationRow, alternativePresentationRow],
    resolvePaidAccess: async () => "denied",
    hasUsedFreeReveal: async () => false,
    after: () => {},
    ...overrides,
  }
}

function request(body: unknown) {
  return new Request("http://test/api/scan/resolve", { method: "POST", body: JSON.stringify(body) })
}

async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  if (value === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = value
  try {
    // Awaited (not just returned) so the `finally` below cannot restore the env var while
    // the handler's async work is still in flight and reading it.
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = previous
  }
}

test("scan resolve masking: flag off never calls resolvePaidAccess, even for a free user", async () => {
  await withFlag(undefined, async () => {
    const handler = createScanResolveRouteHandler(
      baseDeps({
        resolvePaidAccess: async () => {
          throw new Error("must not be called with the flag off")
        },
      }),
    )
    const response = await handler(request({ productId }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.alternatives[0].productId, alternativeId)
    assert.equal(body.alternatives[0].displayName, "Sanftes Shampoo")
    assert.equal(body.freeRevealAvailable, undefined)
  })
})

test("scan resolve masking: a free user (flag on, denied) gets masked alternatives plus the reveal affordance", async () => {
  await withFlag("true", async () => {
    const handler = createScanResolveRouteHandler(
      baseDeps({
        resolvePaidAccess: async () => "denied",
        hasUsedFreeReveal: async () => false,
      }),
    )
    const response = await handler(request({ productId }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.freeRevealAvailable, true)
    assert.deepEqual(body.alternatives, [
      {
        verdict: "ideal",
        verdictLabel: "Passt",
        comparison: {
          rows: [
            { rowId: "shampoo.scalp_route", label: "Kopfhaut-Fokus", state: "match" },
            { rowId: "shampoo.cleansing_intensity", label: "Reinigungsstärke", state: "partial" },
          ],
          summaryScore: 0.5,
        },
      },
    ])
    // The scanned product itself is never masked — the caller already knows what it scanned.
    assert.equal(body.product.productId, productId)
    assert.equal(body.product.name, "Repair Shampoo")
  })
})

test("scan resolve masking: freeRevealAvailable is false once the credit is used", async () => {
  await withFlag("true", async () => {
    const handler = createScanResolveRouteHandler(
      baseDeps({ resolvePaidAccess: async () => "denied", hasUsedFreeReveal: async () => true }),
    )
    const response = await handler(request({ productId }))
    const body = await response.json()
    assert.equal(body.freeRevealAvailable, false)
  })
})

test("scan resolve masking: hasUsedFreeReveal is called with the admin client, not a fresh one", async () => {
  await withFlag("true", async () => {
    const adminClient = { marker: "admin" }
    let seenClient: unknown = null
    const handler = createScanResolveRouteHandler(
      baseDeps({
        createAdminClient: () => adminClient as never,
        resolvePaidAccess: async () => "denied",
        hasUsedFreeReveal: async (client) => {
          seenClient = client
          return false
        },
      }),
    )
    await handler(request({ productId }))
    assert.equal(seenClient, adminClient)
  })
})

test("scan resolve masking: an unavailable paid-access lookup fails closed with 503", async () => {
  await withFlag("true", async () => {
    const handler = createScanResolveRouteHandler(
      baseDeps({ resolvePaidAccess: async () => "unavailable" }),
    )
    const response = await handler(request({ productId }))
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: "temporarily_unavailable" })
  })
})

test("scan resolve masking: a not_needed verdict never calls resolvePaidAccess (nothing to mask)", async () => {
  await withFlag("true", async () => {
    const handler = createScanResolveRouteHandler(
      baseDeps({
        buildScanVerdict: () => notNeededVerdict,
        resolvePaidAccess: async () => {
          throw new Error("must not be called for a not_needed verdict")
        },
      }),
    )
    const response = await handler(request({ productId }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.kind, "not_needed")
  })
})

test("scan resolve masking: premium (flag on, allowed) is byte-identical to the flag-off response", async () => {
  // Fix round 1 (F5): compare the raw response TEXT, not parsed objects — `assert.deepEqual`
  // on parsed JSON is key-order-insensitive and doesn't actually prove byte-identity.
  const texts: string[] = []
  const bodies: Array<Record<string, unknown>> = []
  for (const flag of [undefined, "true"]) {
    // eslint-disable-next-line no-await-in-loop
    await withFlag(flag, async () => {
      const handler = createScanResolveRouteHandler(
        baseDeps({ resolvePaidAccess: async () => "allowed" }),
      )
      const response = await handler(request({ productId }))
      assert.equal(response.status, 200)
      const text = await response.text()
      texts.push(text)
      bodies.push(JSON.parse(text))
    })
  }
  assert.equal(texts[0], texts[1])
  assert.equal(bodies[1].freeRevealAvailable, undefined)
  assert.equal(
    (bodies[1].alternatives as unknown[])[0] &&
      (bodies[1].alternatives as Array<Record<string, unknown>>)[0].productId,
    alternativeId,
  )
})

test("scan resolve masking: premium alternatives never carry the server-internal criteria field", async () => {
  await withFlag("true", async () => {
    const handler = createScanResolveRouteHandler(
      baseDeps({ resolvePaidAccess: async () => "allowed" }),
    )
    const response = await handler(request({ productId }))
    const body = await response.json()
    assert.equal(Object.hasOwn(body.alternatives[0], "criteria"), false)
  })
})
