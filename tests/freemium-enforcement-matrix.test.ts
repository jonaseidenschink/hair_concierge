import assert from "node:assert/strict"
import test from "node:test"
import { NextRequest } from "next/server"

import { createUpdateSession, type UpdateSessionDependencies } from "../src/lib/supabase/middleware"
import { createScanSaveRouteHandlers, type ScanSaveRouteDeps } from "../src/app/api/scan/save/route"
import {
  createScanWishlistRouteHandler,
  type ScanWishlistRouteDeps,
} from "../src/app/api/scan/wishlist/route"
import {
  hasFreemiumPaidAccess,
  type FreemiumAccessResult,
  type HasFreemiumPaidAccessDeps,
} from "../src/lib/entitlements/access"
import type { ModeratorAccessResolution } from "../src/lib/personal-plan-field-test/moderator"
import type { OneTimeAccessState } from "../src/lib/billing/types"

/**
 * Adversarial direct-request suite for plans/freemium-scanner-first/enforcement-matrix.md
 * (task T4). Two seams are exercised:
 *
 * 1. Middleware (T2): premium API prefixes that stay fully subscription-gated
 *    (no freemium admission). `/api/chat` already has this proof in
 *    tests/auth-middleware-personal-plan-routine.test.ts; the two rows below
 *    (`/api/profile`, `/api/personal-plan/stage-1/previews`) had no
 *    dedicated e2e proof yet, only the pure `shouldRedirectToReactivation`
 *    prefix-list test — added here per the matrix doc.
 * 2. In-route guards (T4, this task): `/api/scan/save` and
 *    `/api/scan/wishlist`, which the middleware now admits to free users
 *    (see enforcement-matrix.md) and which therefore need their own
 *    server-side premium check.
 */

// --- 1. Middleware-enforced premium rows without a prior e2e test ----------

const freeUserId = "33333333-3333-4333-8333-333333333333"

function createFreeUserMiddleware() {
  const fakeSupabase = {
    auth: {
      getUser: async () => ({
        data: { user: { id: freeUserId, email: "free@example.com", app_metadata: {} } },
      }),
    },
    from(table: string) {
      throw new Error(`unexpected table read: ${table}`)
    },
  }

  const dependencies: UpdateSessionDependencies = {
    createServerClient: (() =>
      fakeSupabase) as unknown as UpdateSessionDependencies["createServerClient"],
    hasCurrentAppAccess: (async () => false) as UpdateSessionDependencies["hasCurrentAppAccess"],
    hasCurrentPaidAppAccess: (async () =>
      false) as UpdateSessionDependencies["hasCurrentPaidAppAccess"],
    resolveOneTimeAccessState: (async () =>
      "none") as UpdateSessionDependencies["resolveOneTimeAccessState"],
    resolveModeratorAccess: (async () =>
      "none") as UpdateSessionDependencies["resolveModeratorAccess"],
    getRouteEnvironment: () => ({ nodeEnv: "test", localDevLoginEnabled: false }),
  }

  return createUpdateSession(dependencies)
}

async function withFlagOn(fn: () => Promise<void>) {
  const original = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  process.env.FREEMIUM_SCANNER_FIRST_ENABLED = "true"
  try {
    await fn()
  } finally {
    if (original === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = original
  }
}

test("flag on: a free authenticated user is still denied /api/profile (non-admitted, subscription_required)", async () => {
  await withFlagOn(async () => {
    const response = await createFreeUserMiddleware()(
      new NextRequest("https://chaarlie.de/api/profile"),
    )
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: "subscription_required" })
  })
})

test("flag on: a free authenticated user is still denied /api/personal-plan/stage-1/previews (non-admitted, subscription_required)", async () => {
  await withFlagOn(async () => {
    const response = await createFreeUserMiddleware()(
      new NextRequest("https://chaarlie.de/api/personal-plan/stage-1/previews"),
    )
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: "subscription_required" })
  })
})

// --- 2. In-route guards: /api/scan/save -------------------------------------

const userId = "11111111-1111-4111-8111-111111111111"
const productId = "22222222-2222-4222-8222-222222222222"

function saveDeps(overrides: Partial<ScanSaveRouteDeps> = {}): ScanSaveRouteDeps {
  return {
    getUserId: async () => userId,
    checkRateLimit: async () => ({ allowed: true }),
    createAdminClient: () => ({}) as never,
    moveSavedProduct: async (_client, _userId, _productId, kind) => ({
      outcome: "saved",
      savedState: { state: kind === "merkliste" ? "merkliste" : "routine", managedByScan: true },
    }),
    removeWishlist: async () => ({ outcome: "removed" }),
    removeRoutine: async () => ({ outcome: "removed" }),
    loadSavedState: async () => ({ state: null, managedByScan: false }),
    requirePremiumAccess: async () => "allowed",
    ...overrides,
  }
}

function saveRequest(method: "POST" | "DELETE", body: unknown) {
  return new Request("http://test/api/scan/save", { method, body: JSON.stringify(body) })
}

test("scan save POST: a free-tier user (flag-ON reachable) is denied with the middleware's subscription_required shape", async () => {
  const handlers = createScanSaveRouteHandlers(
    saveDeps({
      requirePremiumAccess: async () => "denied",
      moveSavedProduct: async () => {
        throw new Error("must not be called")
      },
    }),
  )
  const response = await handlers.POST(saveRequest("POST", { productId, kind: "merkliste" }))
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: "subscription_required" })
})

test("scan save DELETE: a free-tier user is denied before any removal", async () => {
  const handlers = createScanSaveRouteHandlers(
    saveDeps({
      requirePremiumAccess: async () => "denied",
      removeWishlist: async () => {
        throw new Error("must not be called")
      },
    }),
  )
  const response = await handlers.DELETE(saveRequest("DELETE", { productId, kind: "merkliste" }))
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: "subscription_required" })
})

test("scan save POST: a paid user (composite allowed) passes through unchanged", async () => {
  const handlers = createScanSaveRouteHandlers(
    saveDeps({ requirePremiumAccess: async () => "allowed" }),
  )
  const response = await handlers.POST(saveRequest("POST", { productId, kind: "merkliste" }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    kind: "merkliste",
    productId,
    savedState: { state: "merkliste", managedByScan: true },
  })
})

// I2: an unreadable moderator lookup with no independent paid access must
// surface as the wrapper's existing retriable-503 vocabulary, not a 403 —
// this is a route-level distinction, not just a util-level one, since the
// route is what a client actually sees.
test("scan save POST: an unavailable premium-access check returns 503 temporarily_unavailable, not 403", async () => {
  const handlers = createScanSaveRouteHandlers(
    saveDeps({
      requirePremiumAccess: async () => "unavailable",
      moveSavedProduct: async () => {
        throw new Error("must not be called")
      },
    }),
  )
  const response = await handlers.POST(saveRequest("POST", { productId, kind: "merkliste" }))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "temporarily_unavailable" })
})

// --- 2. In-route guards: /api/scan/wishlist ---------------------------------

function wishlistDeps(overrides: Partial<ScanWishlistRouteDeps> = {}): ScanWishlistRouteDeps {
  return {
    getUserId: async () => userId,
    checkRateLimit: async () => ({ allowed: true }),
    createAdminClient: () => ({}) as never,
    listWishlist: async () => [],
    requirePremiumAccess: async () => "allowed",
    ...overrides,
  }
}

test("scan wishlist GET: a free-tier user is denied with the middleware's subscription_required shape", async () => {
  const handler = createScanWishlistRouteHandler(
    wishlistDeps({
      requirePremiumAccess: async () => "denied",
      listWishlist: async () => {
        throw new Error("must not be called")
      },
    }),
  )
  const response = await handler(new Request("http://test/api/scan/wishlist"))
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: "subscription_required" })
})

test("scan wishlist GET: a paid user passes through unchanged", async () => {
  const entry = {
    productId: "prod-1",
    name: "Shampoo X",
    brand: "Marke",
    imageUrl: null,
    priceLabel: "12,99 €",
    purchaseUrl: "https://example.com/p",
  }
  const handler = createScanWishlistRouteHandler(
    wishlistDeps({
      requirePremiumAccess: async () => "allowed",
      listWishlist: async () => [entry],
    }),
  )
  const response = await handler(new Request("http://test/api/scan/wishlist"))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { entries: [entry] })
})

test("scan wishlist GET: an unavailable premium-access check returns 503 temporarily_unavailable, not 403", async () => {
  const handler = createScanWishlistRouteHandler(
    wishlistDeps({
      requirePremiumAccess: async () => "unavailable",
      listWishlist: async () => {
        throw new Error("must not be called")
      },
    }),
  )
  const response = await handler(new Request("http://test/api/scan/wishlist"))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "temporarily_unavailable" })
})

// --- 3. hasFreemiumPaidAccess: the composite guard util itself --------------

const userEmail = "user@example.com"

function accessDeps(overrides: Partial<HasFreemiumPaidAccessDeps> = {}): HasFreemiumPaidAccessDeps {
  return {
    client: {} as never,
    hasAppAccess: async () => false,
    hasPaidAppAccess: async () => false,
    resolveOneTimeAccessState: async () => "none",
    resolveModeratorAccess: async () => ({ kind: "none" }) satisfies ModeratorAccessResolution,
    ...overrides,
  }
}

// PR1 review fix (F1a): the guard must be literally inert with the flag off
// — allowed, with no billing/moderator lookup at all — not merely "denies
// the same users middleware already denies". Every dep below throws if
// called, so this fails loudly if the flag-off short-circuit is ever
// removed or moved after a lookup.
test("hasFreemiumPaidAccess: flag off is inert — allowed, no billing/moderator lookups performed", async () => {
  const original = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  try {
    const result = await hasFreemiumPaidAccess(
      userId,
      userEmail,
      false,
      accessDeps({
        hasAppAccess: async () => {
          throw new Error("must not be called when the flag is off")
        },
        hasPaidAppAccess: async () => {
          throw new Error("must not be called when the flag is off")
        },
        resolveOneTimeAccessState: async () => {
          throw new Error("must not be called when the flag is off")
        },
        resolveModeratorAccess: async () => {
          throw new Error("must not be called when the flag is off")
        },
      }),
    )
    assert.equal(result, "allowed")
  } finally {
    if (original === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = original
  }
})

test("hasFreemiumPaidAccess: no active subscription, one-time access, or moderator grant denies", async () => {
  await withFlagOn(async () => {
    const result = await hasFreemiumPaidAccess(userId, userEmail, false, accessDeps())
    assert.equal(result, "denied")
  })
})

test("hasFreemiumPaidAccess: an active subscription (hasAppAccess) grants access", async () => {
  await withFlagOn(async () => {
    const result = await hasFreemiumPaidAccess(
      userId,
      userEmail,
      false,
      accessDeps({ hasAppAccess: async () => true }),
    )
    assert.equal(result, "allowed")
  })
})

test("hasFreemiumPaidAccess: an active one-time purchase grants access even when hasAppAccess is false", async () => {
  await withFlagOn(async () => {
    const result = await hasFreemiumPaidAccess(
      userId,
      userEmail,
      false,
      accessDeps({ resolveOneTimeAccessState: async () => "active" }),
    )
    assert.equal(result, "allowed")
  })
})

test("hasFreemiumPaidAccess: an active moderator grant grants access", async () => {
  await withFlagOn(async () => {
    const result = await hasFreemiumPaidAccess(
      userId,
      userEmail,
      false,
      accessDeps({
        resolveModeratorAccess: async () => ({
          kind: "active",
          campaignId: "c1",
          expiresAt: "2026-12-31T00:00:00.000Z",
        }),
      }),
    )
    assert.equal(result, "allowed")
  })
})

test("hasFreemiumPaidAccess: an ended moderator cannot retain access through a manual grant alone (mirrors T2 I1/I3 fix)", async () => {
  await withFlagOn(async () => {
    const result = await hasFreemiumPaidAccess(
      userId,
      userEmail,
      false,
      accessDeps({
        hasAppAccess: async () => true, // manual-grant-inclusive check says yes
        hasPaidAppAccess: async () => false, // independent (excludes manual grants) check says no
        resolveModeratorAccess: async () => ({ kind: "ended", campaignId: "c1" }),
      }),
    )
    assert.equal(result, "denied")
  })
})

test("hasFreemiumPaidAccess: an ended moderator with independently verified paid access remains admitted", async () => {
  await withFlagOn(async () => {
    const result = await hasFreemiumPaidAccess(
      userId,
      userEmail,
      false,
      accessDeps({
        hasAppAccess: async () => true,
        hasPaidAppAccess: async () => true,
        resolveModeratorAccess: async () => ({ kind: "ended", campaignId: "c1" }),
      }),
    )
    assert.equal(result, "allowed")
  })
})

test("hasFreemiumPaidAccess: an unavailable moderator lookup falls back to the independent paid-access check", async () => {
  await withFlagOn(async () => {
    const denied = await hasFreemiumPaidAccess(
      userId,
      userEmail,
      false,
      accessDeps({
        hasAppAccess: async () => true,
        hasPaidAppAccess: async () => false,
        resolveModeratorAccess: async () => ({ kind: "unavailable" }),
      }),
    )
    assert.equal(denied, "unavailable")

    const admitted = await hasFreemiumPaidAccess(
      userId,
      userEmail,
      false,
      accessDeps({
        hasAppAccess: async () => true,
        hasPaidAppAccess: async () => true,
        resolveModeratorAccess: async () => ({ kind: "unavailable" }),
      }),
    )
    assert.equal(admitted, "allowed")
  })
})

// C1 (Critical): the guard previously called `hasAppAccess(client, { userId
// })`, dropping `email`. `findCurrentManualAccessGrant` looks up
// `manual_access_grants` by email as a first-class path (nullable `user_id`,
// `CHECK user_id OR email`), so an email-bound grant holder (friend/tester/
// admin/support) has no `user_id` row to match — only the email lookup finds
// them. Pin that the composite now threads `email` through so this holder is
// allowed, and that dropping the email (passing `null`) reproduces the
// regression.
test("hasFreemiumPaidAccess: an email-only manual grant is allowed once the authenticated email is threaded through", async () => {
  await withFlagOn(async () => {
    const emailOnlyGrantDeps = accessDeps({
      hasAppAccess: async (_client, lookup) => lookup.email === userEmail,
    })

    const allowed = await hasFreemiumPaidAccess(userId, userEmail, false, emailOnlyGrantDeps)
    assert.equal(allowed, "allowed")

    // Reproduces the C1 regression: without the email, the manual grant is
    // invisible to `hasAppAccess` and the holder is falsely denied.
    const withoutEmail = await hasFreemiumPaidAccess(userId, null, false, emailOnlyGrantDeps)
    assert.equal(withoutEmail, "denied")
  })
})

// PR1 review fix (F1b): a field-test guest's moderator lookup is skipped
// entirely by middleware (`!fieldTestGuest && dependencies.resolveModeratorAccess
// ? ... : Promise.resolve("none")`), so an unrelated moderator outage can
// never surface for them. The `resolveModeratorAccess` stub below returns a
// state that would flip the outcome if it were ever consulted (`"ended"`,
// which forces the independent-paid-access recomputation and — since that
// recomputation says no — would deny), proving the skip actually happens
// rather than coincidentally agreeing.
test("hasFreemiumPaidAccess: a field-test guest's moderator lookup is skipped, mirroring middleware's access_kind exception", async () => {
  await withFlagOn(async () => {
    const result = await hasFreemiumPaidAccess(
      userId,
      userEmail,
      true,
      accessDeps({
        hasAppAccess: async () => true, // valid manual field-test grant
        hasPaidAppAccess: async () => false, // no independent paid entitlement
        resolveModeratorAccess: async () => ({ kind: "ended", campaignId: "c1" }),
      }),
    )
    assert.equal(result, "allowed")
  })
})

// --- 4. I3: parity between the middleware composite and the guard util -----

/**
 * The middleware paywall (src/lib/supabase/middleware.ts) and
 * `hasFreemiumPaidAccess` are independent hand-copies of the same
 * `active || oneTimeAccessState === "active" || moderatorAccess === "active"`
 * composite (plus the ended/unavailable-moderator recomputation). C1 proved
 * they can silently drift. This runs both seams against the same injected
 * billing deps for the same user across the reviewer's matrix
 * (subscription-active, one-time-active, moderator-active, email-only-grant,
 * none, moderator-unavailable) and asserts identical allow/deny/unavailable
 * outcomes.
 *
 * The middleware seam is exercised at `/api/profile` — a premium route that
 * stays outside `FREEMIUM_ADMITTED_ROUTE_PREFIXES` (see
 * enforcement-matrix.md), so the composite's allow/deny/unavailable outcome
 * directly determines the response instead of being masked by the freemium
 * admission carve-out that `/api/scan` gets.
 */

const parityUserId = "44444444-4444-4444-8444-444444444444"
const parityEmail = "grant-holder@example.com"

type ParityScenario = {
  name: string
  hasCurrentAppAccess: (lookup: { userId: string; email?: string | null }) => boolean
  hasCurrentPaidAppAccess: (lookup: { userId: string }) => boolean
  oneTimeAccessState: OneTimeAccessState
  moderatorAccess: ModeratorAccessResolution
  // PR1 review fix (F1): both seams skip the moderator lookup entirely for a
  // field-test guest (access_kind === "field_test"), so `moderatorAccess`
  // above is a trap value for these scenarios — it must never actually be
  // consulted, and the scenario is chosen so that consulting it would flip
  // the outcome (catching a forgotten skip).
  fieldTestGuest: boolean
  expected: FreemiumAccessResult
}

const parityScenarios: ParityScenario[] = [
  {
    name: "subscription-active",
    hasCurrentAppAccess: () => true,
    hasCurrentPaidAppAccess: () => true,
    oneTimeAccessState: "none",
    moderatorAccess: { kind: "none" },
    fieldTestGuest: false,
    expected: "allowed",
  },
  {
    name: "one-time-active",
    hasCurrentAppAccess: () => false,
    hasCurrentPaidAppAccess: () => false,
    oneTimeAccessState: "active",
    moderatorAccess: { kind: "none" },
    fieldTestGuest: false,
    expected: "allowed",
  },
  {
    name: "moderator-active",
    hasCurrentAppAccess: () => false,
    hasCurrentPaidAppAccess: () => false,
    oneTimeAccessState: "none",
    moderatorAccess: { kind: "active", campaignId: "c1", expiresAt: "2026-12-31T00:00:00.000Z" },
    fieldTestGuest: false,
    expected: "allowed",
  },
  {
    // C1's scenario, folded into the parity matrix per the I3 finding.
    name: "email-only-grant",
    hasCurrentAppAccess: (lookup) => lookup.email === parityEmail,
    hasCurrentPaidAppAccess: () => false,
    oneTimeAccessState: "none",
    moderatorAccess: { kind: "none" },
    fieldTestGuest: false,
    expected: "allowed",
  },
  {
    name: "none",
    hasCurrentAppAccess: () => false,
    hasCurrentPaidAppAccess: () => false,
    oneTimeAccessState: "none",
    moderatorAccess: { kind: "none" },
    fieldTestGuest: false,
    expected: "denied",
  },
  {
    name: "moderator-unavailable",
    hasCurrentAppAccess: () => true, // manual-grant-inclusive check says yes
    hasCurrentPaidAppAccess: () => false, // independent check says no
    oneTimeAccessState: "none",
    moderatorAccess: { kind: "unavailable" },
    fieldTestGuest: false,
    expected: "unavailable",
  },
  {
    // F1b: a field-test guest with a valid manual grant. `moderatorAccess`
    // is "ended" here specifically because — if the access_kind-driven skip
    // were missing — "ended" forces the independent-paid-access
    // recomputation (hasCurrentPaidAppAccess: false below), which would flip
    // this to "denied". Only the skip keeps it "allowed".
    name: "field-test-guest",
    hasCurrentAppAccess: () => true,
    hasCurrentPaidAppAccess: () => false,
    oneTimeAccessState: "none",
    moderatorAccess: { kind: "ended", campaignId: "c1" },
    fieldTestGuest: true,
    expected: "allowed",
  },
  {
    // F1's exact composed replay: valid manual field-test access + no
    // independent paid entitlement + an unavailable moderator lookup. Absent
    // the skip, this is exactly the scenario that regressed to a 503/denied
    // outcome that main (which has no per-route guard at all) never
    // produces for this user.
    name: "field-test-guest-moderator-unavailable",
    hasCurrentAppAccess: () => true,
    hasCurrentPaidAppAccess: () => false,
    oneTimeAccessState: "none",
    moderatorAccess: { kind: "unavailable" },
    fieldTestGuest: true,
    expected: "allowed",
  },
]

for (const scenario of parityScenarios) {
  test(`parity (I3/F1): middleware and hasFreemiumPaidAccess agree on "${scenario.name}"`, async () => {
    await withFlagOn(async () => {
      // Seam 1: the in-route guard util.
      const utilResult = await hasFreemiumPaidAccess(
        parityUserId,
        parityEmail,
        scenario.fieldTestGuest,
        {
          client: {} as never,
          hasAppAccess: async (_client, lookup) => scenario.hasCurrentAppAccess(lookup),
          hasPaidAppAccess: async (_client, lookup) => scenario.hasCurrentPaidAppAccess(lookup),
          resolveOneTimeAccessState: async () => scenario.oneTimeAccessState,
          resolveModeratorAccess: async () => scenario.moderatorAccess,
        },
      )
      assert.equal(utilResult, scenario.expected, `hasFreemiumPaidAccess: ${scenario.name}`)

      // Seam 2: the middleware paywall, given the identical deps.
      const fakeSupabase = {
        auth: {
          getUser: async () => ({
            data: {
              user: {
                id: parityUserId,
                email: parityEmail,
                app_metadata: scenario.fieldTestGuest ? { access_kind: "field_test" } : {},
              },
            },
          }),
        },
        from(table: string) {
          throw new Error(`unexpected table read: ${table}`)
        },
      }
      const dependencies: UpdateSessionDependencies = {
        createServerClient: (() =>
          fakeSupabase) as unknown as UpdateSessionDependencies["createServerClient"],
        hasCurrentAppAccess: (async (_client, lookup) =>
          scenario.hasCurrentAppAccess(lookup)) as UpdateSessionDependencies["hasCurrentAppAccess"],
        hasCurrentPaidAppAccess: (async (_client, lookup) =>
          scenario.hasCurrentPaidAppAccess(
            lookup,
          )) as UpdateSessionDependencies["hasCurrentPaidAppAccess"],
        resolveOneTimeAccessState: (async () =>
          scenario.oneTimeAccessState) as UpdateSessionDependencies["resolveOneTimeAccessState"],
        resolveModeratorAccess: (async () =>
          scenario.moderatorAccess) as UpdateSessionDependencies["resolveModeratorAccess"],
        getRouteEnvironment: () => ({ nodeEnv: "test", localDevLoginEnabled: false }),
      }

      const response = await createUpdateSession(dependencies)(
        new NextRequest("https://chaarlie.de/api/profile"),
      )

      if (scenario.expected === "allowed") {
        assert.equal(response.status, 200, `middleware: ${scenario.name}`)
      } else if (scenario.expected === "denied") {
        assert.equal(response.status, 403, `middleware: ${scenario.name}`)
        assert.deepEqual(await response.json(), { error: "subscription_required" })
      } else {
        assert.equal(response.status, 503, `middleware: ${scenario.name}`)
        assert.deepEqual(await response.json(), { error: "moderator_access_unavailable" })
      }
    })
  })
}
