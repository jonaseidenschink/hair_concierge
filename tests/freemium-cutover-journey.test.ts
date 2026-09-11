import assert from "node:assert/strict"
import test from "node:test"

import { resolveQuizCompletionDestination } from "../src/lib/auth/free-registration"
import {
  isFreemiumAdmittedRoutePath,
  shouldRedirectToReactivation,
} from "../src/lib/supabase/middleware"
import { resolveAuthenticatedAppNavigationAccess } from "../src/lib/personal-plan/navigation-access"
import { classifyRoute, type RouteEnvironment } from "../src/lib/auth/route-classification"
import {
  firesErsterPasstNicht,
  scanTriggerSheetContext,
} from "../src/lib/scan/triggers/trigger-rules"

/**
 * T19 named journey test: the funnel cutover + de-stealth story, both flag states, told as
 * one connected sequence of real decisions rather than re-deriving T18's already-proven
 * quiz -> e-mail -> magic-link -> /auth/confirm -> /scan route chain
 * (`tests/free-registration-journey.test.ts` owns that transport-level journey with faked
 * Supabase auth + database seams).
 *
 * This suite instead stitches together the PURE decision points a new user's browser and
 * the server actually consult along the way, each already unit-tested in isolation
 * elsewhere (`tests/free-registration-contract.test.ts`, `freemium-admission-middleware.test.ts`,
 * `freemium-lapsed-user-matrix.test.ts`, scan-trigger-rules coverage) — proving here that
 * they compose into the SAME journey end to end, in both flag states, using the real
 * exported functions with no re-implementation.
 *
 * Journey beats covered:
 *  1. Quiz completion -> destination resolver (T18's switch).
 *  2. Middleware admission for the resolved destination + `/scan` (T2).
 *  3. Five-tab nav resolution for a signed-in user with no paid access (T3).
 *  4. A scan gate firing the shared PremiumSheet contract ("gates -> sheet reachable", T9/T10).
 *  5. Legacy offer routes (`/pricing`, `/lp/<slug>/angebot`, `/result/<leadId>/reveal`) stay
 *     routable in both states — `classifyRoute` never reads the flag at all, so this is
 *     verified by construction and pinned here as an explicit regression guard.
 */

const NEW_LEAD_ID = "11111111-1111-4111-8111-111111111111"

const ROUTE_ENVIRONMENT: RouteEnvironment = {
  nodeEnv: "production",
  localDevLoginEnabled: false,
  vercelEnv: "production",
}

/**
 * `resolveAuthenticatedAppNavigationAccess` reads `isFreemiumScannerFirstEnabled()`
 * directly (Edge-safe module-level env read, not threaded through its deps) — same
 * convention `tests/auth-middleware-personal-plan-routine.test.ts` follows.
 */
async function withFreemiumFlag<T>(enabled: boolean, run: () => Promise<T>): Promise<T> {
  const original = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  process.env.FREEMIUM_SCANNER_FIRST_ENABLED = enabled ? "true" : "false"
  try {
    return await run()
  } finally {
    if (original === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = original
  }
}

test("flag ON — new user: quiz completion routes into the free-registration destination, /scan is admitted, five-tab free nav renders, and a scan gate opens the shared sheet contract", async () => {
  // 1. Quiz completion (T18's switch).
  const destination = resolveQuizCompletionDestination({
    leadId: NEW_LEAD_ID,
    freemiumScannerFirstEnabled: true,
  })
  assert.equal(destination, "/registrierung")

  // 2. Middleware admission: a signed-in user with no paid access reaches /scan (and the
  // rest of the app shell) instead of bouncing to /reactivate — the de-stealth surface for
  // the NEW free-tier population that T1-T17 built and this task ties the flag to.
  assert.equal(isFreemiumAdmittedRoutePath("/scan"), true)
  assert.equal(
    shouldRedirectToReactivation({ pathname: "/scan", freemiumScannerFirstEnabled: true }),
    false,
  )

  // 3. Nav: the same authenticated user (real Personal Plan journey access resolves to
  // "legacy" because there is none) gets the five-tab free-tier shell, not the empty legacy
  // header — this IS the de-stealth control for a brand-new free user (see report for why
  // the pre-existing nav-tab-comment stealth control no longer applies to paid users).
  const freeNav = await withFreemiumFlag(true, () =>
    resolveAuthenticatedAppNavigationAccess({
      getUserId: async () => "free-user-id",
      loadJourneyAccess: async () => ({ kind: "legacy" }),
      loadHasAppAccess: async () => false,
    }),
  )
  assert.equal(freeNav.kind, "personal_plan")
  if (freeNav.kind === "personal_plan") {
    assert.equal(freeNav.tier, "free")
    assert.deepEqual(
      freeNav.items.map((item) => item.key),
      ["chat", "routine", "scan", "application", "profile"],
    )
  }

  // 4. Gates -> sheet reachable: the free user's first mismatch verdict fires the
  // "erster_passt_nicht" trigger, which resolves to a concrete, openable PremiumSheetContext.
  const fires = firesErsterPasstNicht({ isMismatchVerdict: true, freeRevealAvailable: true })
  assert.equal(fires, true)
  const sheetContext = scanTriggerSheetContext("erster_passt_nicht")
  assert.deepEqual(sheetContext, { feature: "empfehlungen", source: "trigger:erster-passt-nicht" })

  // 5. Legacy offer routes stay routable — unaffected by construction (classifyRoute takes
  // no flag), pinned explicitly as part of this journey.
  for (const pathname of ["/pricing", "/lp/haarplan/angebot", `/result/${NEW_LEAD_ID}/reveal`]) {
    assert.equal(classifyRoute(pathname, ROUTE_ENVIRONMENT), "public", pathname)
  }
})

test("flag OFF — new user: quiz completion stays on today's paid destination, /scan is NOT admitted (scanner back in stealth for a non-paying account), and nav stays the unchanged legacy shell", async () => {
  // 1. Quiz completion — byte-identical to today.
  const destination = resolveQuizCompletionDestination({
    leadId: NEW_LEAD_ID,
    freemiumScannerFirstEnabled: false,
  })
  assert.equal(destination, `/result/${NEW_LEAD_ID}/reveal`)

  // 2. Middleware: with the flag off, `/scan` is never freemium-admitted — a signed-in user
  // with no paid access is redirected to /reactivate exactly as before this restructure
  // existed. This is "the scanner back in stealth" for a new, non-paying account: there is
  // no free path in, only the paid one.
  assert.equal(
    shouldRedirectToReactivation({ pathname: "/scan", freemiumScannerFirstEnabled: false }),
    true,
  )

  // 3. Nav: the same signed-in, non-paying user gets the unchanged legacy shell — no five
  // tabs, no Scan tab, no lock markers. `loadHasAppAccess` is deliberately never even
  // consulted when the flag is off (see navigation-access.ts), so passing one that would
  // grant free tier if it WERE consulted proves the flag gate itself, not just the deps.
  const legacyNav = await withFreemiumFlag(false, () =>
    resolveAuthenticatedAppNavigationAccess({
      getUserId: async () => "still-a-new-user-id",
      loadJourneyAccess: async () => ({ kind: "legacy" }),
      loadHasAppAccess: async () => true,
    }),
  )
  assert.deepEqual(legacyNav, { kind: "legacy" })

  // 4. Legacy offer routes stay routable — identical assertion, same construction argument,
  // proving flag-off byte-identity for this surface too.
  for (const pathname of ["/pricing", "/lp/haarplan/angebot", `/result/${NEW_LEAD_ID}/reveal`]) {
    assert.equal(classifyRoute(pathname, ROUTE_ENVIRONMENT), "public", pathname)
  }
})

test("existing premium (paid Personal Plan) users are unaffected by the flag in either state — de-stealth and cutover only ever touch the NEW free-tier entry path", async () => {
  for (const freemiumScannerFirstEnabled of [true, false]) {
    const paidNav = await withFreemiumFlag(freemiumScannerFirstEnabled, () =>
      resolveAuthenticatedAppNavigationAccess({
        getUserId: async () => "paid-user-id",
        loadJourneyAccess: async () => ({
          kind: "personal_plan",
          frontier: "stage4",
          allowed: {
            stage1: true,
            stage2: true,
            stage3: true,
            stage4: true,
            stage5: true,
          },
          nextHref: "/routine",
          personalPlanId: "plan-1",
        }),
        // Never consulted for a real `personal_plan` journey access — included to prove
        // that: a value that WOULD flip a free user's tier has zero effect here.
        loadHasAppAccess: async () => !freemiumScannerFirstEnabled,
      }),
    )
    assert.equal(paidNav.kind, "personal_plan")
    // Always "premium", in both flag states — `toAuthenticatedAppNavigationAccess` assigns
    // it unconditionally for a real Personal Plan journey access (see navigation-access.ts).
    if (paidNav.kind === "personal_plan") assert.equal(paidNav.tier, "premium")
  }

  // The outer subscription paywall (not exercised here — see
  // `tests/freemium-admission-middleware.test.ts`) already resolves a paid user's
  // `hasPaidAppAccess: true` before `shouldRedirectToReactivation` is ever consulted, in
  // both flag states; this function only decides the fallback for someone who has none.
})
