import assert from "node:assert/strict"
import test from "node:test"

import {
  createScanResolveRouteHandler,
  type ScanResolveRouteDeps,
} from "../src/app/api/scan/resolve/route"
import { SCAN_RATE_LIMIT } from "../src/lib/rate-limit"
import {
  recordScanResolveAttempt,
  resetAttemptLogCaptureThrottleForTests,
} from "../src/lib/scan/resolve-event-log"

const userId = "11111111-1111-4111-8111-111111111111"
const productId = "22222222-2222-4222-8222-222222222222"

const inCatalogVerdict = {
  kind: "in_catalog" as const,
  verdict: "ideal" as const,
  verdictLabel: "Passt",
  verdictTitle: "Passt zu deinem Haar",
  status: "ok" as const,
  subtitle: "Bewertet anhand deines Profils",
  evaluatedRole: null,
  evaluatedRoleLabel: null,
  dimensions: [],
  criteria: [],
  coverage: null,
  fitNarrative: null,
  alternatives: [],
}

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
    loadPresentationRows: async () => [presentationRow],
    // Freemium scanner-first (T8): both defaults keep every existing test on the
    // pre-T8 full/premium path. `resolvePaidAccess` only runs at all when the flag is on
    // AND the verdict is in_catalog (see route.ts) — with the flag unset in this test
    // process, it is never even called, so "allowed" here is a value that is never
    // observed either. Masking-specific tests below set `FREEMIUM_SCANNER_FIRST_ENABLED`
    // and override both.
    resolvePaidAccess: async () => "allowed",
    hasUsedFreeReveal: async () => false,
    autoSaveScanWishlist: async () => {},
    // Next's real `after` throws outside a request scope, and these tests assert on the
    // response only. Tests that assert on the deferred telemetry swap in
    // `collectAttempts().deps.after`, which records the task so `flush()` can drain it.
    after: () => {},
    ...overrides,
  }
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

const expectedProductHeader = {
  productId,
  name: "Repair Shampoo",
  brand: "Olaplex",
  category: "shampoo",
  categoryLabel: "Shampoo",
  imageUrl: null,
  priceLabel: "24,90 €",
  purchaseUrl: "https://shop.test/a",
}

function request(body: unknown) {
  return new Request("http://test/api/scan/resolve", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

test("scan resolve: unauthenticated is rejected", async () => {
  const handler = createScanResolveRouteHandler(baseDeps({ getUserId: async () => null }))
  const response = await handler(request({ productId }))
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: "unauthorized" })
})

test("scan resolve: rate limited returns 429 with Retry-After", async () => {
  const handler = createScanResolveRouteHandler(
    baseDeps({ checkRateLimit: async () => ({ allowed: false }) }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 429)
  assertRetryAfter(response)
  assert.deepEqual(await response.json(), { error: "rate_limited" })
})

test("scan resolve: rate limiter unavailable fails closed with 503, without a Sentry capture", async () => {
  const captured: unknown[] = []
  const handler = createScanResolveRouteHandler(
    baseDeps({
      checkRateLimit: async () => ({ allowed: false, error: "service_unavailable" }),
      captureScanException: (_error, details) => {
        captured.push(details)
      },
    }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "temporarily_unavailable" })
  // The rate limiter's fail-closed 503 is an upstream outage already logged inside
  // checkRateLimit itself — not an unexpected route-level throw, so it must not also
  // page through Sentry.
  assert.deepEqual(captured, [])
})

test("scan resolve: body with both identifier and productId is rejected", async () => {
  const handler = createScanResolveRouteHandler(baseDeps())
  const response = await handler(
    request({ productId, identifier: { type: "ean", value: "4006381333931" } }),
  )
  assert.equal(response.status, 400)
})

test("scan resolve: bad EAN checksum is rejected before any lookup", async () => {
  const handler = createScanResolveRouteHandler(
    baseDeps({
      validateEanInput: () => ({ ok: false, reason: "checksum" }),
      findOpenScanSubmission: async () => {
        throw new Error("must not be called")
      },
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333930" } }))
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: "invalid_identifier" })
})

test("scan resolve: an open submission answers a catalog miss", async () => {
  const handler = createScanResolveRouteHandler(
    baseDeps({
      lookupCatalogProductByIdentifier: async () => null,
      findOpenScanSubmission: async () => ({ submissionId: "sub-1", status: "researching" }),
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    kind: "pending_submission",
    submissionId: "sub-1",
    headline: "Eingereicht!",
    status: "researching",
  })
})

test("scan resolve: a cataloged EAN resolves to a verdict even while a submission is open", async () => {
  const handler = createScanResolveRouteHandler(
    baseDeps({
      // The catalog is the authority: with a hit, the submission never even gets checked.
      findOpenScanSubmission: async () => {
        throw new Error("must not be called for a cataloged product")
      },
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.kind, "in_catalog")
})

test("scan resolve: a quarantined hit with an open submission answers pending, not unknown", async () => {
  const handler = createScanResolveRouteHandler(
    baseDeps({
      isProductSearchQuarantined: async () => true,
      findOpenScanSubmission: async () => ({ submissionId: "sub-2", status: "pending_review" }),
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.kind, "pending_submission")
  assert.equal(body.submissionId, "sub-2")
})

test("scan resolve: identifier miss returns unknown_product with all 10 categories", async () => {
  const handler = createScanResolveRouteHandler(
    baseDeps({ lookupCatalogProductByIdentifier: async () => null }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.kind, "unknown_product")
  assert.deepEqual(body.identifier, { type: "ean", value: "4006381333931" })
  assert.equal(body.categories.length, 10)
  assert.ok(body.categories.every((entry: { key: string; label: string }) => entry.label))
})

test("scan resolve: productId not found is 404", async () => {
  const handler = createScanResolveRouteHandler(
    baseDeps({ loadActiveProductById: async () => null }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: "product_not_found" })
})

test("scan resolve: a non-ean identifier type is rejected (v1 surface is ean-only)", async () => {
  const handler = createScanResolveRouteHandler(baseDeps())
  const response = await handler(request({ identifier: { type: "gtin", value: "4006381333931" } }))
  assert.equal(response.status, 400)
})

test("scan resolve: a disposition-quarantined identifier hit is treated as unknown_product", async () => {
  const handler = createScanResolveRouteHandler(
    baseDeps({
      isProductSearchQuarantined: async () => true,
      loadScanEvaluationContext: async () => {
        throw new Error("must not reach profile evaluation for a quarantined product")
      },
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.kind, "unknown_product")
  assert.deepEqual(body.identifier, { type: "ean", value: "4006381333931" })
})

test("scan resolve: a disposition-quarantined productId is 404 product_not_found", async () => {
  const handler = createScanResolveRouteHandler(
    baseDeps({
      isProductSearchQuarantined: async () => true,
      loadScanEvaluationContext: async () => {
        throw new Error("must not reach profile evaluation for a quarantined product")
      },
    }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: "product_not_found" })
})

test("scan resolve: no personal plan at all is 409 profile_missing", async () => {
  const handler = createScanResolveRouteHandler(
    baseDeps({ loadScanEvaluationContext: async () => null }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: "profile_missing" })
})

test("scan resolve: identifier hit resolves a verdict with snapshotSource and savedState", async () => {
  const buildScanVerdictCalls: unknown[] = []
  const handler = createScanResolveRouteHandler(
    baseDeps({
      buildScanVerdict: (input) => {
        buildScanVerdictCalls.push(input)
        return inCatalogVerdict
      },
      loadScanSavedState: async () => ({ state: "merkliste" as const, managedByScan: true }),
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ...inCatalogVerdict,
    product: expectedProductHeader,
    snapshotSource: "refined",
    savedState: { state: "merkliste", managedByScan: true },
  })
  assert.equal(buildScanVerdictCalls.length, 1)
})

test("scan resolve: a missing catalog presentation row fails closed with 503", async () => {
  const handler = createScanResolveRouteHandler(baseDeps({ loadPresentationRows: async () => [] }))
  const response = await handler(request({ productId }))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "temporarily_unavailable" })
})

test("scan resolve: alternatives are enriched with brand and purchase link", async () => {
  const alternativeId = "33333333-3333-4333-8333-333333333333"
  const handler = createScanResolveRouteHandler(
    baseDeps({
      buildScanVerdict: () => ({
        ...inCatalogVerdict,
        verdict: "mismatch",
        alternatives: [
          {
            productId: alternativeId,
            displayName: "Sanftes Shampoo",
            imageUrl: null,
            priceLabel: null,
            netContentLabel: null,
            verdict: "ideal" as const,
            verdictLabel: "Passt",
          },
        ],
      }),
      loadPresentationRows: async (_client, productIds) => {
        assert.deepEqual(productIds, [productId, alternativeId])
        return [
          presentationRow,
          {
            ...presentationRow,
            id: alternativeId,
            name: "Sanftes Shampoo",
            brand: "Kérastase",
            affiliateLink: "https://shop.test/b",
          },
        ]
      },
    }),
  )
  const response = await handler(request({ productId }))
  const body = await response.json()
  assert.equal(body.alternatives[0].brand, "Kérastase")
  assert.equal(body.alternatives[0].purchaseUrl, "https://shop.test/b")
})

test("scan resolve: a quarantined alternative is never offered (ruling R7)", async () => {
  const goodId = "33333333-3333-4333-8333-333333333333"
  const quarantinedId = "44444444-4444-4444-8444-444444444444"
  const alternative = (id: string, displayName: string) => ({
    productId: id,
    displayName,
    imageUrl: null,
    priceLabel: null,
    netContentLabel: null,
    verdict: "ideal" as const,
    verdictLabel: "Passt",
  })
  let askedFor: string[] = []
  const handler = createScanResolveRouteHandler(
    baseDeps({
      buildScanVerdict: () => ({
        ...inCatalogVerdict,
        verdict: "mismatch",
        alternatives: [
          alternative(quarantinedId, "Zurückgestelltes Shampoo"),
          alternative(goodId, "Sanftes Shampoo"),
        ],
      }),
      loadQuarantinedProductIdsAmong: async (_client, ids) => {
        askedFor = [...ids]
        return new Set([quarantinedId])
      },
      loadPresentationRows: async () => [
        presentationRow,
        { ...presentationRow, id: goodId, name: "Sanftes Shampoo" },
        { ...presentationRow, id: quarantinedId, name: "Zurückgestelltes Shampoo" },
      ],
    }),
  )
  const response = await handler(request({ productId }))
  const body = await response.json()
  // Only the ≤3 offered alternatives are checked, not the whole candidate pool.
  assert.deepEqual(askedFor, [quarantinedId, goodId])
  assert.deepEqual(
    body.alternatives.map((entry: { productId: string }) => entry.productId),
    [goodId],
  )
})

test("scan resolve: productId path resolves the same way as an identifier hit", async () => {
  const handler = createScanResolveRouteHandler(baseDeps())
  const response = await handler(request({ productId }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.kind, "in_catalog")
  assert.equal(body.snapshotSource, "refined")
})

test("scan resolve: a not-needed decision skips the recommendation-candidates load", async () => {
  const notNeededDecision = { ...decision, needTier: "not_needed" as const }
  const notNeededSnapshot = { ...snapshot, decisions: [notNeededDecision] }
  const handler = createScanResolveRouteHandler(
    baseDeps({
      loadScanEvaluationContext: async () => ({ ...context, snapshot: notNeededSnapshot }),
      loadRecommendationCandidates: async () => {
        throw new Error("must not be called for a not-needed decision")
      },
    }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 200)
})

/* ------------------------------------------------- role-sensitive fact loads */

const twoRoleShampooContext = {
  ...context,
  snapshot: {
    ...snapshot,
    decisions: [{ ...decision, roles: ["shampoo_everyday" as const, "shampoo_dandruff" as const] }],
  },
}

/** Facts stubbed to carry the role they were loaded for, so misuse is visible. */
const factsLoadedFor = (role: string) => ({ productId, role }) as never

test("scan resolve: a role-sensitive category loads product facts per role and the candidate pool once", async () => {
  const factsRoles: string[] = []
  const candidateLoads: Array<{ category: string; roles: readonly string[] }> = []
  let received: { perRoleFacts?: Record<string, unknown> } | null = null

  const handler = createScanResolveRouteHandler(
    baseDeps({
      loadScanEvaluationContext: async () => twoRoleShampooContext,
      loadScanProductFacts: async (_client, _category, _productId, selection) => {
        factsRoles.push(selection.role)
        return factsLoadedFor(selection.role)
      },
      loadRecommendationCandidates: async (_client, input) => {
        candidateLoads.push({ category: input.category, roles: input.roles })
        return Object.fromEntries(input.roles.map((role) => [role, [factsLoadedFor(role)]]))
      },
      buildScanVerdict: (input) => {
        received = input as never
        return inCatalogVerdict
      },
    }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 200)

  assert.deepEqual(factsRoles.sort(), ["shampoo_dandruff", "shampoo_everyday"])
  // F12: the candidate pool is role-independent, so two roles must cost ONE load that is
  // asked for both roles — not one full catalog load per role.
  assert.equal(candidateLoads.length, 1)
  assert.equal(candidateLoads[0]!.category, "shampoo")
  assert.deepEqual([...candidateLoads[0]!.roles].sort(), ["shampoo_dandruff", "shampoo_everyday"])

  const perRoleFacts = received!.perRoleFacts as Record<
    string,
    { productFacts: { role: string }; recommendationCandidates: Array<{ role: string }> }
  >
  // Each role must see the facts loaded for that role, not the first role's load.
  assert.equal(perRoleFacts.shampoo_everyday.productFacts.role, "shampoo_everyday")
  assert.equal(perRoleFacts.shampoo_dandruff.productFacts.role, "shampoo_dandruff")
  assert.equal(perRoleFacts.shampoo_everyday.recommendationCandidates[0].role, "shampoo_everyday")
  assert.equal(perRoleFacts.shampoo_dandruff.recommendationCandidates[0].role, "shampoo_dandruff")
})

test("scan resolve: a candidate load that omits a requested role fails closed as 503", async () => {
  const attempts = collectAttempts()
  let verdictCalls = 0
  const handler = createScanResolveRouteHandler(
    baseDeps({
      ...attempts.deps,
      loadScanEvaluationContext: async () => twoRoleShampooContext,
      // Only the first role comes back — a loader bug must not grade the second role
      // against empty or borrowed candidates.
      loadRecommendationCandidates: async (_client, input) => ({
        [input.roles[0]!]: [factsLoadedFor(input.roles[0]!)],
      }),
      buildScanVerdict: () => {
        verdictCalls += 1
        return inCatalogVerdict
      },
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "temporarily_unavailable" })
  assert.equal(verdictCalls, 0)
  await attempts.flush()
  assert.deepEqual(attempts.completions, [
    {
      attemptId: "attempt-1",
      lookupOutcome: "hit",
      terminalOutcome: "temporarily_unavailable",
      matchedProductId: productId,
      failureStage: "product_facts",
    },
  ])
})

test("scan resolve: a buildScanVerdict throw reports the 'verdict' failure stage (T8 fix round 1, F4)", async () => {
  const attempts = collectAttempts()
  const handler = createScanResolveRouteHandler(
    baseDeps({
      ...attempts.deps,
      buildScanVerdict: () => {
        throw new Error("boom")
      },
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 503)
  await attempts.flush()
  assert.deepEqual(attempts.completions, [
    {
      attemptId: "attempt-1",
      lookupOutcome: "hit",
      terminalOutcome: "temporarily_unavailable",
      matchedProductId: productId,
      failureStage: "verdict",
    },
  ])
})

test("scan resolve: a category whose facts do not vary by role loads exactly once", async () => {
  const conditionerDecision = {
    ...decision,
    category: "conditioner" as const,
    roles: ["conditioner_rinse_out" as const],
  }
  const factsRoles: string[] = []
  let received: { perRoleFacts?: unknown } | null = null

  const handler = createScanResolveRouteHandler(
    baseDeps({
      loadActiveProductById: async () => ({ id: productId, category: "conditioner" }),
      loadScanEvaluationContext: async () => ({
        ...context,
        snapshot: { ...snapshot, decisions: [conditionerDecision] },
      }),
      loadScanProductFacts: async (_client, _category, _productId, selection) => {
        factsRoles.push(selection.role)
        return null
      },
      loadPresentationRows: async () => [{ ...presentationRow, category: "conditioner" as const }],
      buildScanVerdict: (input) => {
        received = input as never
        return inCatalogVerdict
      },
    }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 200)
  assert.deepEqual(factsRoles, ["conditioner_rinse_out"])
  assert.equal(received!.perRoleFacts, undefined)
})

test("scan resolve: an unexpected lib error maps to 503 and captures to Sentry", async () => {
  const thrown = new Error("scan_profile_context_unavailable")
  const captured: unknown[] = []
  const handler = createScanResolveRouteHandler(
    baseDeps({
      loadScanEvaluationContext: async () => {
        throw thrown
      },
      captureScanException: (error, details) => {
        assert.equal(error, thrown)
        captured.push(details)
      },
    }),
  )
  const response = await handler(request({ productId }))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "temporarily_unavailable" })
  assert.deepEqual(captured, [{ route: "resolve", status: 503, reason: "resolve_failed", userId }])
})

/**
 * Attempt telemetry is deferred off the response path via `after` (F11), so the writes have
 * not run yet when the handler resolves. The fake queues each task the way Next does and
 * `flush()` drains it, which is what the assertions below wait on.
 */
function collectAttempts() {
  const starts: unknown[] = []
  const completions: unknown[] = []
  const queued: Array<() => Promise<void> | void> = []
  const deps: Partial<ScanResolveRouteDeps> = {
    recordScanResolveAttempt: (async (_client: unknown, attempt: unknown) => {
      starts.push(attempt)
    }) as never,
    completeScanResolveAttempt: (async (_client: unknown, completion: unknown) => {
      completions.push(completion)
    }) as never,
    // Real `after` callbacks run only once the response has been sent, so the fake holds
    // the task until `flush()` — running it earlier would not model production.
    after: (task) => {
      queued.push(task)
    },
  }
  const flush = async () => {
    // Mirrors Next's real `after` queue (p-queue, concurrency: Infinity): every queued task
    // starts at once, so a regression to two independent `after()` calls (record + complete)
    // is not silently serialized back into order by the fake itself.
    while (queued.length > 0) {
      await Promise.all(queued.splice(0).map((task) => task()))
    }
  }
  return { starts, completions, deps, flush }
}

test("attempt telemetry: catalog hit starts before lookup and completes only after payload build", async () => {
  const attempts = collectAttempts()
  const handler = createScanResolveRouteHandler(baseDeps(attempts.deps))
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 200)
  await attempts.flush()
  assert.equal(attempts.starts.length, 1)
  const { createdAt, ...start } = attempts.starts[0] as Record<string, unknown>
  assert.deepEqual(start, {
    attemptId: "attempt-1",
    userId,
    identifierType: "ean",
    rawValue: "4006381333931",
  })
  assert.match(String(createdAt), /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  assert.deepEqual(attempts.completions, [
    {
      attemptId: "attempt-1",
      lookupOutcome: "hit",
      terminalOutcome: "resolved",
      matchedProductId: productId,
      failureStage: null,
    },
  ])
})

test("attempt telemetry: created_at is the request start, never later than the completion", async () => {
  const attempts = collectAttempts()
  const completionStamps: string[] = []
  const handler = createScanResolveRouteHandler(
    baseDeps({
      ...attempts.deps,
      completeScanResolveAttempt: (async () => {
        // The real helper stamps completed_at when it runs — i.e. inside the `after` drain.
        completionStamps.push(new Date().toISOString())
      }) as never,
    }),
  )

  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 200)
  const beforeDrain = new Date().toISOString()
  // The drain runs after the response; make that gap observable.
  await new Promise((resolve) => setTimeout(resolve, 5))
  await attempts.flush()

  const createdAt = (attempts.starts[0] as { createdAt?: string }).createdAt
  assert.ok(createdAt, "expected the attempt to carry an explicit created_at")
  // Captured while the request was still in flight, so the deferred INSERT cannot stamp a
  // created_at that sits after the completed_at written moments later in the same drain.
  assert.ok(createdAt <= beforeDrain, `${createdAt} should not be later than ${beforeDrain}`)
  assert.equal(completionStamps.length, 1)
  assert.ok(
    createdAt <= completionStamps[0]!,
    `${createdAt} should not be later than ${completionStamps[0]}`,
  )
})

test("attempt telemetry: an unknown fit verdict is completed but not counted as resolved", async () => {
  const attempts = collectAttempts()
  const handler = createScanResolveRouteHandler(
    baseDeps({
      ...attempts.deps,
      buildScanVerdict: () => ({ ...inCatalogVerdict, verdict: "unknown" }),
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 200)
  await attempts.flush()
  assert.deepEqual(attempts.completions, [
    {
      attemptId: "attempt-1",
      lookupOutcome: "hit",
      terminalOutcome: "verdict_unknown",
      matchedProductId: productId,
      failureStage: null,
    },
  ])
})

test("attempt telemetry: catalog miss completes as unknown_product", async () => {
  const attempts = collectAttempts()
  const handler = createScanResolveRouteHandler(
    baseDeps({ ...attempts.deps, lookupCatalogProductByIdentifier: async () => null }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 200)
  await attempts.flush()
  assert.equal(attempts.starts.length, 1)
  assert.deepEqual(attempts.completions, [
    {
      attemptId: "attempt-1",
      lookupOutcome: "miss",
      terminalOutcome: "unknown_product",
      matchedProductId: null,
      failureStage: null,
    },
  ])
})

test("attempt telemetry: invalid checksum starts then completes as invalid_identifier", async () => {
  const attempts = collectAttempts()
  const handler = createScanResolveRouteHandler(
    baseDeps({ ...attempts.deps, validateEanInput: () => ({ ok: false, reason: "checksum" }) }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333930" } }))
  assert.equal(response.status, 400)
  await attempts.flush()
  assert.equal(attempts.starts.length, 1)
  assert.deepEqual(attempts.completions, [
    {
      attemptId: "attempt-1",
      lookupOutcome: "invalid",
      terminalOutcome: "invalid_identifier",
      matchedProductId: null,
      failureStage: "identifier_lookup",
    },
  ])
})

test("attempt telemetry: quarantined hit retains its matching product", async () => {
  const attempts = collectAttempts()
  const handler = createScanResolveRouteHandler(
    baseDeps({ ...attempts.deps, isProductSearchQuarantined: async () => true }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 200)
  await attempts.flush()
  assert.deepEqual(attempts.completions, [
    {
      attemptId: "attempt-1",
      lookupOutcome: "quarantined",
      terminalOutcome: "unknown_product",
      matchedProductId: productId,
      failureStage: null,
    },
  ])
})

test("attempt telemetry: open submission completes as pending_submission", async () => {
  const attempts = collectAttempts()
  const handler = createScanResolveRouteHandler(
    baseDeps({
      ...attempts.deps,
      lookupCatalogProductByIdentifier: async () => null,
      findOpenScanSubmission: async () => ({ submissionId: "sub-1", status: "researching" }),
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 200)
  await attempts.flush()
  assert.deepEqual(attempts.completions, [
    {
      attemptId: "attempt-1",
      lookupOutcome: "miss",
      terminalOutcome: "pending_submission",
      matchedProductId: null,
      failureStage: null,
    },
  ])
})

test("attempt telemetry: resolve-by-productId logs nothing — no barcode involved", async () => {
  const attempts = collectAttempts()
  const handler = createScanResolveRouteHandler(baseDeps(attempts.deps))
  const response = await handler(request({ productId }))
  assert.equal(response.status, 200)
  await attempts.flush()
  assert.deepEqual(attempts.starts, [])
  assert.deepEqual(attempts.completions, [])
})

test("attempt telemetry: F11 — nothing is written before the response, record before completion", async () => {
  const order: string[] = []
  const attempts = collectAttempts()
  const handler = createScanResolveRouteHandler(
    baseDeps({
      ...attempts.deps,
      recordScanResolveAttempt: (async () => {
        order.push("start")
      }) as never,
      completeScanResolveAttempt: (async () => {
        order.push("complete")
      }) as never,
      validateEanInput: () => {
        order.push("validate")
        return { ok: false, reason: "checksum" }
      },
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333930" } }))
  assert.equal(response.status, 400)
  // The attempt is queued before validation runs, but neither write has touched the DB by
  // the time the client has its answer.
  assert.deepEqual(order, ["validate"])
  await attempts.flush()
  assert.deepEqual(order, ["validate", "start", "complete"])
})

test("attempt telemetry: the completion never overtakes the record, even on a slow insert", async () => {
  const order: string[] = []
  const attempts = collectAttempts()
  const handler = createScanResolveRouteHandler(
    baseDeps({
      ...attempts.deps,
      // A slow INSERT is exactly the case Next's `after` queue would not serialise on its
      // own (p-queue defaults to concurrency: Infinity) — the UPDATE must still come last.
      recordScanResolveAttempt: (async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push("start")
      }) as never,
      completeScanResolveAttempt: (async () => {
        order.push("complete")
      }) as never,
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 200)
  await attempts.flush()
  assert.deepEqual(order, ["start", "complete"])
})

test("attempt telemetry: a missing profile is a hit but profile_ineligible, not a catalog miss", async () => {
  const attempts = collectAttempts()
  const handler = createScanResolveRouteHandler(
    baseDeps({ ...attempts.deps, loadScanEvaluationContext: async () => null }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 409)
  await attempts.flush()
  assert.deepEqual(attempts.completions, [
    {
      attemptId: "attempt-1",
      lookupOutcome: "hit",
      terminalOutcome: "profile_ineligible",
      matchedProductId: productId,
      failureStage: null,
    },
  ])
})

test("attempt telemetry: a post-lookup failure records the current bounded stage", async () => {
  const attempts = collectAttempts()
  const handler = createScanResolveRouteHandler(
    baseDeps({
      ...attempts.deps,
      loadScanProductFacts: async () => {
        throw new Error("facts unavailable")
      },
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 503)
  await attempts.flush()
  assert.deepEqual(attempts.completions, [
    {
      attemptId: "attempt-1",
      lookupOutcome: "hit",
      terminalOutcome: "temporarily_unavailable",
      matchedProductId: productId,
      failureStage: "product_facts",
    },
  ])
})

test("attempt telemetry: F15 — a quarantine-lookup failure keeps the matched product", async () => {
  const attempts = collectAttempts()
  const handler = createScanResolveRouteHandler(
    baseDeps({
      ...attempts.deps,
      isProductSearchQuarantined: async () => {
        throw new Error("dispositions unavailable")
      },
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 503)
  await attempts.flush()
  assert.deepEqual(attempts.completions, [
    {
      attemptId: "attempt-1",
      lookupOutcome: "hit",
      terminalOutcome: "temporarily_unavailable",
      matchedProductId: productId,
      failureStage: "quarantine_lookup",
    },
  ])
})

test("attempt telemetry: one admin client per request, shared with the onError path", async () => {
  const attempts = collectAttempts()
  let created = 0
  const handler = createScanResolveRouteHandler(
    baseDeps({
      ...attempts.deps,
      createAdminClient: (() => {
        created += 1
        return {} as never
      }) as never,
      loadScanProductFacts: async () => {
        throw new Error("facts unavailable")
      },
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 503)
  await attempts.flush()
  assert.equal(created, 1)
})

test("attempt telemetry: an attempt-log write failure reaches Sentry through the route's injected captureScanException", async () => {
  // Uses the REAL recordScanResolveAttempt (not the fake) so the assertion proves the route
  // actually threads its `deps.captureScanException` override into the writer, not just that
  // a fake records whatever it's handed.
  resetAttemptLogCaptureThrottleForTests()
  const queued: Array<() => Promise<void> | void> = []
  const captured: unknown[] = []
  const failingClient = {
    from() {
      return {
        insert: async () => ({ error: { message: "boom" } }),
      }
    },
  }
  const handler = createScanResolveRouteHandler(
    baseDeps({
      recordScanResolveAttempt,
      createAdminClient: () => failingClient as never,
      captureScanException: (_error, details) => {
        captured.push(details)
      },
      after: (task) => {
        queued.push(task)
      },
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 200)
  await Promise.all(queued.splice(0).map((task) => task()))
  assert.deepEqual(captured, [
    // Fail-open telemetry: warning, not error (plan §5 task 5).
    { route: "resolve", status: 200, reason: "attempt_log_write_failed", level: "warning" },
  ])
})

test("attempt telemetry: a synchronously throwing after() cannot turn a resolved scan into a 503", async () => {
  const handler = createScanResolveRouteHandler(
    baseDeps({
      after: () => {
        throw new Error("no store")
      },
    }),
  )
  const response = await handler(request({ identifier: { type: "ean", value: "4006381333931" } }))
  assert.equal(response.status, 200)
})

/**
 * The header is computed inside the handler, so recomputing `fixedWindowRetryAfterSeconds`
 * here can straddle a second boundary and flake. Assert the bound instead (precedent:
 * tests/personal-plan-api-stage3.test.ts).
 */
function assertRetryAfter(response: Response) {
  const header = response.headers.get("Retry-After") ?? ""
  assert.match(header, /^[1-9][0-9]?$/)
  assert.ok(Number(header) <= SCAN_RATE_LIMIT.windowMs / 1000)
}
