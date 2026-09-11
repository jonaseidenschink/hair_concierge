import assert from "node:assert/strict"
import test from "node:test"

import { createScanSaveRouteHandlers, type ScanSaveRouteDeps } from "../src/app/api/scan/save/route"
import type { ScanSavedStatePayload } from "../src/lib/scan/saved-state"
import { SCAN_RATE_LIMIT } from "../src/lib/rate-limit"

const userId = "11111111-1111-4111-8111-111111111111"
const productId = "22222222-2222-4222-8222-222222222222"

const NOT_SAVED: ScanSavedStatePayload = { state: null, managedByScan: false }
const MERKLISTE: ScanSavedStatePayload = { state: "merkliste", managedByScan: true }
const SCAN_ROUTINE: ScanSavedStatePayload = { state: "routine", managedByScan: true }
const FOREIGN_ROUTINE: ScanSavedStatePayload = { state: "routine", managedByScan: false }

function baseDeps(overrides: Partial<ScanSaveRouteDeps> = {}): ScanSaveRouteDeps {
  return {
    getUserId: async () => userId,
    checkRateLimit: async () => ({ allowed: true }),
    createAdminClient: () => ({}) as never,
    moveSavedProduct: async (_client, _userId, _productId, kind) => ({
      outcome: "saved",
      savedState: kind === "merkliste" ? MERKLISTE : SCAN_ROUTINE,
    }),
    removeWishlist: async () => ({ outcome: "removed" }),
    removeRoutine: async () => ({ outcome: "removed" }),
    loadSavedState: async () => NOT_SAVED,
    requirePremiumAccess: async () => "allowed",
    ...overrides,
  }
}

function request(method: "POST" | "DELETE", body: unknown) {
  return new Request("http://test/api/scan/save", { method, body: JSON.stringify(body) })
}

test("scan save POST: unauthenticated is rejected", async () => {
  const handlers = createScanSaveRouteHandlers(baseDeps({ getUserId: async () => null }))
  const response = await handlers.POST(request("POST", { productId, kind: "merkliste" }))
  assert.equal(response.status, 401)
})

test("scan save POST: rate limited returns 429 with Retry-After, before any write", async () => {
  const handlers = createScanSaveRouteHandlers(
    baseDeps({
      checkRateLimit: async () => ({ allowed: false }),
      moveSavedProduct: async () => {
        throw new Error("must not be called")
      },
    }),
  )
  const response = await handlers.POST(request("POST", { productId, kind: "merkliste" }))
  assert.equal(response.status, 429)
  assertRetryAfter(response)
  assert.deepEqual(await response.json(), { error: "rate_limited" })
})

test("scan save POST: rate limiter unavailable fails closed with 503, without a Sentry capture", async () => {
  const captured: unknown[] = []
  const handlers = createScanSaveRouteHandlers(
    baseDeps({
      checkRateLimit: async () => ({ allowed: false, error: "service_unavailable" }),
      captureScanException: (_error, details) => {
        captured.push(details)
      },
    }),
  )
  const response = await handlers.POST(request("POST", { productId, kind: "merkliste" }))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "temporarily_unavailable" })
  assert.deepEqual(captured, [])
})

test("scan save DELETE: rate limited returns 429, before any removal", async () => {
  const handlers = createScanSaveRouteHandlers(
    baseDeps({
      checkRateLimit: async () => ({ allowed: false }),
      removeWishlist: async () => {
        throw new Error("must not be called")
      },
    }),
  )
  const response = await handlers.DELETE(request("DELETE", { productId, kind: "merkliste" }))
  assert.equal(response.status, 429)
  assert.deepEqual(await response.json(), { error: "rate_limited" })
})

test("scan save POST: invalid body is rejected", async () => {
  const handlers = createScanSaveRouteHandlers(baseDeps())
  const response = await handlers.POST(request("POST", { productId, kind: "not_a_kind" }))
  assert.equal(response.status, 400)
})

test("scan save POST: the move spends exactly one rate-limit charge", async () => {
  let charges = 0
  const handlers = createScanSaveRouteHandlers(
    baseDeps({
      checkRateLimit: async () => {
        charges += 1
        return { allowed: true }
      },
    }),
  )
  await handlers.POST(request("POST", { productId, kind: "routine" }))
  assert.equal(charges, 1)
})

test("scan save POST: the move is one RPC call carrying the requested kind", async () => {
  const calls: Array<{ userId: string; productId: string; kind: string }> = []
  const handlers = createScanSaveRouteHandlers(
    baseDeps({
      moveSavedProduct: async (_client, movedUserId, movedProductId, kind) => {
        calls.push({ userId: movedUserId, productId: movedProductId, kind })
        return { outcome: "saved", savedState: MERKLISTE }
      },
      removeRoutine: async () => {
        throw new Error("must not be called")
      },
      removeWishlist: async () => {
        throw new Error("must not be called")
      },
    }),
  )
  const response = await handlers.POST(request("POST", { productId, kind: "merkliste" }))
  assert.equal(response.status, 200)
  // One transactional move, no follow-up cleanup call: F6's two-write window is gone.
  assert.deepEqual(calls, [{ userId, productId, kind: "merkliste" }])
  assert.deepEqual(await response.json(), {
    ok: true,
    kind: "merkliste",
    productId,
    savedState: MERKLISTE,
  })
})

test("scan save POST: a refused product maps to 409, either kind", async () => {
  for (const kind of ["merkliste", "routine"]) {
    const handlers = createScanSaveRouteHandlers(
      baseDeps({ moveSavedProduct: async () => ({ outcome: "product_not_saveable" }) }),
    )
    const response = await handlers.POST(request("POST", { productId, kind }))
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: "product_not_saveable" })
  }
})

test("scan save POST: an inactive/unknown product maps to 404, either kind", async () => {
  for (const kind of ["merkliste", "routine"]) {
    const handlers = createScanSaveRouteHandlers(
      baseDeps({ moveSavedProduct: async () => ({ outcome: "product_not_found" }) }),
    )
    const response = await handlers.POST(request("POST", { productId, kind }))
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: "product_not_found" })
  }
})

test("scan save POST routine: success reports the state the move returned", async () => {
  const handlers = createScanSaveRouteHandlers(baseDeps())
  const response = await handlers.POST(request("POST", { productId, kind: "routine" }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    kind: "routine",
    productId,
    savedState: SCAN_ROUTINE,
  })
})

test("scan save POST routine: an already-owned foreign row reports managedByScan false", async () => {
  const handlers = createScanSaveRouteHandlers(
    baseDeps({ moveSavedProduct: async () => ({ outcome: "saved", savedState: FOREIGN_ROUTINE }) }),
  )
  const response = await handlers.POST(request("POST", { productId, kind: "routine" }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    kind: "routine",
    productId,
    savedState: FOREIGN_ROUTINE,
  })
})

test("scan save POST: a failed move maps to 503 and captures to Sentry", async () => {
  const thrown = new Error("boom")
  const captured: unknown[] = []
  const handlers = createScanSaveRouteHandlers(
    baseDeps({
      moveSavedProduct: async () => {
        throw thrown
      },
      captureScanException: (error, details) => {
        assert.equal(error, thrown)
        captured.push(details)
      },
    }),
  )
  const response = await handlers.POST(request("POST", { productId, kind: "merkliste" }))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "temporarily_unavailable" })
  assert.deepEqual(captured, [{ route: "save", status: 503, reason: "save_failed", userId }])
})

test("scan save DELETE: unauthenticated is rejected", async () => {
  const handlers = createScanSaveRouteHandlers(baseDeps({ getUserId: async () => null }))
  const response = await handlers.DELETE(request("DELETE", { productId, kind: "merkliste" }))
  assert.equal(response.status, 401)
})

test("scan save DELETE merkliste: calls the wishlist remover", async () => {
  const calls: string[] = []
  const handlers = createScanSaveRouteHandlers(
    baseDeps({
      removeWishlist: async () => {
        calls.push("wishlist")
        return { outcome: "removed" }
      },
      removeRoutine: async () => {
        calls.push("routine")
        return { outcome: "removed" }
      },
    }),
  )
  const response = await handlers.DELETE(request("DELETE", { productId, kind: "merkliste" }))
  assert.equal(response.status, 200)
  assert.deepEqual(calls, ["wishlist"])
  assert.deepEqual(await response.json(), {
    ok: true,
    kind: "merkliste",
    productId,
    savedState: NOT_SAVED,
  })
})

test("scan save DELETE merkliste: reports a routine row the removal left behind", async () => {
  const handlers = createScanSaveRouteHandlers(
    baseDeps({ loadSavedState: async () => FOREIGN_ROUTINE }),
  )
  const response = await handlers.DELETE(request("DELETE", { productId, kind: "merkliste" }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    kind: "merkliste",
    productId,
    savedState: FOREIGN_ROUTINE,
  })
})

test("scan save DELETE routine: a foreign row is refused with 409 not_removable_here", async () => {
  const handlers = createScanSaveRouteHandlers(
    baseDeps({
      removeRoutine: async () => ({ outcome: "not_removable_here" }),
      loadSavedState: async () => {
        throw new Error("must not be called")
      },
    }),
  )
  const response = await handlers.DELETE(request("DELETE", { productId, kind: "routine" }))
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: "not_removable_here" })
})

test("scan save DELETE routine: calls the routine remover, is idempotent on repeat calls", async () => {
  const calls: string[] = []
  const handlers = createScanSaveRouteHandlers(
    baseDeps({
      removeRoutine: async () => {
        calls.push("routine")
        return { outcome: "removed" }
      },
    }),
  )
  const first = await handlers.DELETE(request("DELETE", { productId, kind: "routine" }))
  const second = await handlers.DELETE(request("DELETE", { productId, kind: "routine" }))
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.deepEqual(calls, ["routine", "routine"])
})

test("scan save DELETE: an unexpected error maps to 503 and captures to Sentry", async () => {
  const thrown = new Error("boom")
  const captured: unknown[] = []
  const handlers = createScanSaveRouteHandlers(
    baseDeps({
      removeWishlist: async () => {
        throw thrown
      },
      captureScanException: (error, details) => {
        assert.equal(error, thrown)
        captured.push(details)
      },
    }),
  )
  const response = await handlers.DELETE(request("DELETE", { productId, kind: "merkliste" }))
  assert.equal(response.status, 503)
  assert.deepEqual(captured, [
    { route: "save", status: 503, reason: "save_removal_failed", userId },
  ])
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
