import assert from "node:assert/strict"
import test from "node:test"

import {
  createScanWishlistRouteHandler,
  listScanWishlist,
  type ScanWishlistRouteDeps,
} from "../src/app/api/scan/wishlist/route"
import { SCAN_RATE_LIMIT } from "../src/lib/rate-limit"

const userId = "11111111-1111-4111-8111-111111111111"

function baseDeps(overrides: Partial<ScanWishlistRouteDeps> = {}): ScanWishlistRouteDeps {
  return {
    getUserId: async () => userId,
    checkRateLimit: async () => ({ allowed: true }),
    createAdminClient: () => ({}) as never,
    listWishlist: async () => [],
    requirePremiumAccess: async () => "allowed",
    ...overrides,
  }
}

function request() {
  return new Request("http://test/api/scan/wishlist")
}

test("scan wishlist GET: unauthenticated is rejected", async () => {
  const handler = createScanWishlistRouteHandler(baseDeps({ getUserId: async () => null }))
  const response = await handler(request())
  assert.equal(response.status, 401)
})

test("scan wishlist GET: rate limited returns 429 with Retry-After, before any load", async () => {
  const handler = createScanWishlistRouteHandler(
    baseDeps({
      checkRateLimit: async () => ({ allowed: false }),
      listWishlist: async () => {
        throw new Error("must not be called")
      },
    }),
  )
  const response = await handler(request())
  assert.equal(response.status, 429)
  assertRetryAfter(response)
  assert.deepEqual(await response.json(), { error: "rate_limited" })
})

test("scan wishlist GET: rate limiter unavailable fails closed with 503, without a Sentry capture", async () => {
  const captured: unknown[] = []
  const handler = createScanWishlistRouteHandler(
    baseDeps({
      checkRateLimit: async () => ({ allowed: false, error: "service_unavailable" }),
      captureScanException: (_error, details) => {
        captured.push(details)
      },
    }),
  )
  const response = await handler(request())
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "temporarily_unavailable" })
  assert.deepEqual(captured, [])
})

test("scan wishlist GET: returns the injected entries", async () => {
  const entry = {
    productId: "prod-1",
    name: "Shampoo X",
    brand: "Marke",
    imageUrl: null,
    priceLabel: "12,99 €",
    purchaseUrl: "https://example.com/p",
  }
  const handler = createScanWishlistRouteHandler(baseDeps({ listWishlist: async () => [entry] }))
  const response = await handler(request())
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { entries: [entry] })
})

test("scan wishlist GET: an unexpected error maps to 503 and captures to Sentry", async () => {
  const thrown = new Error("boom")
  const captured: unknown[] = []
  const handler = createScanWishlistRouteHandler(
    baseDeps({
      listWishlist: async () => {
        throw thrown
      },
      captureScanException: (error, details) => {
        assert.equal(error, thrown)
        captured.push(details)
      },
    }),
  )
  const response = await handler(request())
  assert.equal(response.status, 503)
  assert.deepEqual(captured, [
    { route: "wishlist", status: 503, reason: "wishlist_list_failed", userId },
  ])
})

/** `listScanWishlist` itself, against a stub client — join + commerce presentation. */
function stubWishlistClient(rows: unknown[], quarantinedIds: string[] = []) {
  const filters = new Map<string, unknown>()
  let ordered = false

  function tableChain(table: string) {
    const data =
      table === "scan_wishlist" ? rows : quarantinedIds.map((product_id) => ({ product_id }))
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.set(column, value)
        return chain
      },
      in: () => chain,
      order: (column: string, options: { ascending: boolean }) => {
        assert.equal(column, "created_at")
        assert.equal(options.ascending, false)
        ordered = true
        return chain
      },
      then: (resolve: (value: unknown) => unknown) => resolve({ data, error: null }),
    }
    return chain
  }

  const client = { from: (table: string) => tableChain(table) }
  return { client, filters, isOrdered: () => ordered }
}

/** Shape of the joined product row the wishlist listing reads. */
function wishlistProduct(patch: Record<string, unknown> = {}) {
  return {
    name: "Shampoo X",
    brand: "Marke",
    image_url: "https://example.com/img.jpg",
    is_active: true,
    lifecycle_status: "active",
    price_eur: 12.99,
    currency: "EUR",
    affiliate_link: "https://example.com/p",
    purchase_link_status: "available",
    price_checked_at: "2026-08-01T00:00:00.000Z",
    ...patch,
  }
}

test("listScanWishlist: joins product fields and presents commerce data", async () => {
  const { client, filters, isOrdered } = stubWishlistClient([
    { product_id: "prod-1", products: wishlistProduct() },
  ])
  const entries = await listScanWishlist(client as never, userId)
  assert.equal(filters.get("user_id"), userId)
  assert.ok(isOrdered())
  assert.deepEqual(entries, [
    {
      productId: "prod-1",
      name: "Shampoo X",
      brand: "Marke",
      imageUrl: "https://example.com/img.jpg",
      priceLabel: new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(
        12.99,
      ),
      purchaseUrl: "https://example.com/p",
    },
  ])
})

test("listScanWishlist: drops a row whose joined product is gone (deleted/deactivated)", async () => {
  const { client } = stubWishlistClient([{ product_id: "prod-orphan", products: null }])
  const entries = await listScanWishlist(client as never, userId)
  assert.deepEqual(entries, [])
})

test("listScanWishlist: a load error throws a stable error", async () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    then: (resolve: (value: unknown) => unknown) =>
      resolve({ data: null, error: { message: "boom" } }),
  }
  const client = { from: () => chain }
  await assert.rejects(() => listScanWishlist(client as never, userId), /scan_wishlist_list_failed/)
})

test("listScanWishlist: drops a product that has since been deactivated or discontinued", async () => {
  const { client } = stubWishlistClient([
    { product_id: "prod-inactive", products: wishlistProduct({ is_active: false }) },
    {
      product_id: "prod-discontinued",
      products: wishlistProduct({ lifecycle_status: "discontinued" }),
    },
    { product_id: "prod-1", products: wishlistProduct() },
  ])
  const entries = await listScanWishlist(client as never, userId)
  assert.deepEqual(
    entries.map((entry) => entry.productId),
    ["prod-1"],
  )
})

test("listScanWishlist: drops a disposition-quarantined product (ruling R7)", async () => {
  const { client } = stubWishlistClient(
    [
      { product_id: "prod-quarantined", products: wishlistProduct() },
      { product_id: "prod-1", products: wishlistProduct() },
    ],
    ["prod-quarantined"],
  )
  const entries = await listScanWishlist(client as never, userId)
  assert.deepEqual(
    entries.map((entry) => entry.productId),
    ["prod-1"],
  )
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
