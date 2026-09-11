import assert from "node:assert/strict"
import test from "node:test"

import {
  createScanResolveRouteHandler,
  type ScanResolveRouteDeps,
} from "../src/app/api/scan/resolve/route"

/**
 * T8 adversarial anti-leak lane. Deliverable 4: fixtures asserting the ABSENCE of every
 * identifying field (name, brand, productId, GTIN/EAN, image URLs, purchase URLs, prices,
 * any resolvable ID) in a masked response — by walking the whole serialized JSON tree, not
 * spot-checking known field names. A masked alternative's own field list is short today
 * (`verdict`, `verdictLabel`, `comparison`), but this lane is deliberately shape-agnostic:
 * it would still catch a leak introduced by a future field, a renamed key, or a value
 * nested inside `comparison.rows[].label`.
 */

const userId = "11111111-1111-4111-8111-111111111111"
const productId = "22222222-2222-4222-8222-222222222222"
const alternativeAId = "33333333-3333-4333-8333-333333333333"
const alternativeBId = "44444444-4444-4444-8444-444444444444"

// Distinctive, greppable identity markers — chosen so a substring walk of the response
// catches a leak even if it lands somewhere unexpected (e.g. concatenated into an
// unrelated label), not just an exact key/value match.
const ALT_A_NAME = "GEHEIMPRODUKT-ALPHA-9f3c"
const ALT_A_BRAND = "MARKE-ALPHA-9f3c"
const ALT_A_IMAGE = "https://cdn.example.test/geheim-alpha-9f3c.jpg"
const ALT_A_PURCHASE = "https://shop.example.test/kaufen/geheim-alpha-9f3c"
const ALT_A_PRICE = "13,37 €"
const ALT_A_NET_CONTENT = "137 ml"
const ALT_A_EAN = "4006381999137"

const ALT_B_NAME = "GEHEIMPRODUKT-BETA-2a71"
const ALT_B_BRAND = "MARKE-BETA-2a71"
const ALT_B_IMAGE = "https://cdn.example.test/geheim-beta-2a71.jpg"
const ALT_B_PURCHASE = "https://shop.example.test/kaufen/geheim-beta-2a71"
const ALT_B_PRICE = "27,10 €"

const SCANNED_NAME = "Gescanntes Shampoo"
const SCANNED_BRAND = "Gescannte Marke"

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
      productId: alternativeAId,
      displayName: ALT_A_NAME,
      imageUrl: ALT_A_IMAGE,
      priceLabel: ALT_A_PRICE,
      netContentLabel: ALT_A_NET_CONTENT,
      verdict: "ideal" as const,
      verdictLabel: "Passt",
      criteria: [
        {
          criterionId: "shampoo.scalp_route",
          label: "Kopfhaut-Fokus",
          result: "pass" as const,
          // Deliberately hostile: an explanation string that itself smuggles the
          // identity markers. `deriveAlternativeComparison` must drop `explanation`
          // entirely, so none of this may survive into the masked response.
          explanation: `Passt weil ${ALT_A_NAME} von ${ALT_A_BRAND} genau dazu passt.`,
        },
        {
          criterionId: "shampoo.cleansing_intensity",
          label: "Reinigungsstärke",
          result: "caution" as const,
          explanation: `Kaufen unter ${ALT_A_PURCHASE}`,
        },
      ],
    },
    {
      productId: alternativeBId,
      displayName: ALT_B_NAME,
      imageUrl: ALT_B_IMAGE,
      priceLabel: ALT_B_PRICE,
      netContentLabel: "500 ml",
      verdict: "supportive" as const,
      verdictLabel: "Passt eingeschränkt",
      criteria: [],
    },
  ],
}

const presentationRows = [
  {
    id: productId,
    name: SCANNED_NAME,
    brand: SCANNED_BRAND,
    category: "shampoo" as const,
    imageUrl: "https://cdn.example.test/scanned.jpg",
    priceEur: 24.9,
    currency: "EUR",
    affiliateLink: "https://shop.example.test/kaufen/scanned",
    purchaseLinkStatus: "available" as const,
    priceCheckedAt: "2026-08-19T00:00:00.000Z",
  },
  {
    id: alternativeAId,
    name: ALT_A_NAME,
    brand: ALT_A_BRAND,
    category: "shampoo" as const,
    imageUrl: ALT_A_IMAGE,
    priceEur: 13.37,
    currency: "EUR",
    affiliateLink: ALT_A_PURCHASE,
    purchaseLinkStatus: "available" as const,
    priceCheckedAt: "2026-08-19T00:00:00.000Z",
  },
  {
    id: alternativeBId,
    name: ALT_B_NAME,
    brand: ALT_B_BRAND,
    category: "shampoo" as const,
    imageUrl: ALT_B_IMAGE,
    priceEur: 27.1,
    currency: "EUR",
    affiliateLink: ALT_B_PURCHASE,
    purchaseLinkStatus: "available" as const,
    priceCheckedAt: "2026-08-19T00:00:00.000Z",
  },
]

function baseDeps(overrides: Partial<ScanResolveRouteDeps> = {}): ScanResolveRouteDeps {
  return {
    getUserId: async () => userId,
    checkRateLimit: async () => ({ allowed: true }),
    createAdminClient: () => ({}) as never,
    validateEanInput: () => ({ ok: true, type: "ean", value: ALT_A_EAN }),
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
    loadPresentationRows: async () => presentationRows,
    resolvePaidAccess: async () => "denied",
    hasUsedFreeReveal: async () => false,
    after: () => {},
    ...overrides,
  }
}

function request(body: unknown) {
  return new Request("http://test/api/scan/resolve", { method: "POST", body: JSON.stringify(body) })
}

async function withFlag<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  process.env.FREEMIUM_SCANNER_FIRST_ENABLED = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = previous
  }
}

/** Walks every string leaf of a parsed JSON value (objects, arrays, nested alike). */
function everyStringLeaf(value: unknown, visit: (leaf: string, path: string) => void, path = "$") {
  if (typeof value === "string") {
    visit(value, path)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => everyStringLeaf(entry, visit, `${path}[${index}]`))
    return
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      everyStringLeaf(entry, visit, `${path}.${key}`)
    }
  }
}

/** Every key present anywhere in a parsed JSON value, at any depth. */
function everyKey(value: unknown, keys: Set<string>) {
  if (Array.isArray(value)) {
    for (const entry of value) everyKey(entry, keys)
    return
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      keys.add(key)
      everyKey(entry, keys)
    }
  }
}

const FORBIDDEN_SUBSTRINGS = [
  alternativeAId,
  alternativeBId,
  ALT_A_NAME,
  ALT_A_BRAND,
  ALT_A_IMAGE,
  ALT_A_PURCHASE,
  ALT_A_PRICE,
  ALT_A_NET_CONTENT,
  ALT_B_NAME,
  ALT_B_BRAND,
  ALT_B_IMAGE,
  ALT_B_PURCHASE,
  ALT_B_PRICE,
]

// Field names that would resolve or identify an alternative if they appeared anywhere
// under `alternatives` — walked structurally (Deliverable 4: not a spot-check).
const FORBIDDEN_ALTERNATIVE_KEYS = new Set([
  "productId",
  "displayName",
  "imageUrl",
  "priceLabel",
  "netContentLabel",
  "brand",
  "purchaseUrl",
  "criteria",
  "explanation",
  "criterionId",
])

test("anti-leak: a masked response contains none of the withheld alternatives' identity strings anywhere in the JSON tree", async () => {
  await withFlag("true", async () => {
    const handler = createScanResolveRouteHandler(baseDeps())
    const response = await handler(request({ productId }))
    assert.equal(response.status, 200)
    const raw = await response.text()
    const body = JSON.parse(raw)

    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      assert.equal(
        raw.includes(forbidden),
        false,
        `masked response leaked "${forbidden}" somewhere in the raw JSON`,
      )
    }

    // The scanned product's OWN identity is explicitly allowed — only the alternatives are
    // masked (binding constraint). Confirms the walk above isn't vacuously trivial.
    assert.ok(raw.includes(SCANNED_NAME))
    assert.ok(raw.includes(SCANNED_BRAND))

    everyStringLeaf(body, (leaf, path) => {
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        assert.equal(
          leaf.includes(forbidden),
          false,
          `string leaf at ${path} ("${leaf}") contains withheld value "${forbidden}"`,
        )
      }
    })
  })
})

test("anti-leak: no alternative entry carries an identity/resolvable key at any depth", async () => {
  await withFlag("true", async () => {
    const handler = createScanResolveRouteHandler(baseDeps())
    const response = await handler(request({ productId }))
    const body = await response.json()
    assert.equal(body.alternatives.length, 2)

    const keysSeen = new Set<string>()
    everyKey(body.alternatives, keysSeen)
    for (const forbidden of FORBIDDEN_ALTERNATIVE_KEYS) {
      assert.equal(
        keysSeen.has(forbidden),
        false,
        `masked alternatives carried forbidden key "${forbidden}"`,
      )
    }
    assert.deepEqual([...keysSeen].sort(), [
      "comparison",
      "label",
      "rowId",
      "rows",
      "state",
      "summaryScore",
      "verdict",
      "verdictLabel",
    ])
  })
})

test("anti-leak: comparison row labels come only from the fixture's generic criterion labels, never product names", async () => {
  await withFlag("true", async () => {
    const handler = createScanResolveRouteHandler(baseDeps())
    const response = await handler(request({ productId }))
    const body = await response.json()
    const labels = (
      body.alternatives as Array<{ comparison: { rows: Array<{ label: string }> } }>
    ).flatMap((alternative) => alternative.comparison.rows.map((row) => row.label))
    assert.deepEqual(labels.sort(), ["Kopfhaut-Fokus", "Reinigungsstärke"].sort())
  })
})

test("anti-leak: an alternative's raw EAN/GTIN-shaped identifier never reaches the masked response", async () => {
  await withFlag("true", async () => {
    const handler = createScanResolveRouteHandler(baseDeps())
    const response = await handler(request({ identifier: { type: "ean", value: ALT_A_EAN } }))
    const raw = await response.text()
    assert.equal(raw.includes(ALT_A_EAN), false)
  })
})

test("anti-leak: masking survives an alternative whose productId collides with a substring used elsewhere (no accidental UUID leak)", async () => {
  await withFlag("true", async () => {
    const trickyId = productId // same id family shape as the scanned product, sanity check only
    const verdictWithSharedShapeId = {
      ...inCatalogVerdict,
      alternatives: [{ ...inCatalogVerdict.alternatives[0], productId: trickyId }],
    }
    const handler = createScanResolveRouteHandler(
      baseDeps({ buildScanVerdict: () => verdictWithSharedShapeId }),
    )
    const response = await handler(request({ productId }))
    const body = await response.json()
    // The scanned product's own id is legitimately present (product.productId) — the point
    // is that the alternative carries no id field of its own to compare against at all.
    assert.equal(Object.hasOwn(body.alternatives[0], "productId"), false)
  })
})
