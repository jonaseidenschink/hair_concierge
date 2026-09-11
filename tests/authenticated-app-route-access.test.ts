import assert from "node:assert/strict"
import test from "node:test"

import {
  resolveScanPageTier,
  resolveScanRouteAccess,
  resolveTrackerRouteAccess,
  type ScanPageTierDependencies,
  type ScanRouteAccessDependencies,
  type TrackerRouteAccessDependencies,
} from "../src/lib/auth/authenticated-app-route-access"
import type { FreemiumAccessResult } from "../src/lib/entitlements/access"

const completeQuizProfile = {
  hair_texture: "wavy",
  thickness: "normal",
  density: "medium",
  cuticle_condition: "slightly_rough",
  protein_moisture_balance: "stretches_stays",
  scalp_type: "dry",
  scalp_condition: "dry_flakes",
  chemical_treatment: ["colored"],
  concerns: ["dryness"],
}

function dependencies(overrides: Partial<TrackerRouteAccessDependencies> = {}) {
  return {
    getUser: async () => ({ id: "user-1" }),
    ...overrides,
  } satisfies TrackerRouteAccessDependencies
}

function scanDependencies(overrides: Partial<ScanRouteAccessDependencies> = {}) {
  return {
    getUser: async () => ({ id: "user-1" }),
    getHairProfile: async () => completeQuizProfile,
    ...overrides,
  } satisfies ScanRouteAccessDependencies
}

test("tracker boundary only checks the authenticated user", async () => {
  const result = await resolveTrackerRouteAccess(dependencies())
  assert.deepEqual(result, { kind: "allow" })
})

test("tracker boundary fails closed without an authenticated user", async () => {
  const result = await resolveTrackerRouteAccess(dependencies({ getUser: async () => null }))
  assert.deepEqual(result, { kind: "redirect", href: "/quiz" })
})

test("tracker boundary fails closed when the authenticated-user read is unavailable", async () => {
  const result = await resolveTrackerRouteAccess(
    dependencies({
      getUser: async () => {
        throw new Error("auth unavailable")
      },
    }),
  )
  assert.deepEqual(result, { kind: "redirect", href: "/quiz" })
})

test("scan boundary allows an authenticated user with a completed quiz", async () => {
  const result = await resolveScanRouteAccess(scanDependencies())
  assert.deepEqual(result, { kind: "allow" })
})

test("scan boundary redirects without an authenticated user", async () => {
  const result = await resolveScanRouteAccess(scanDependencies({ getUser: async () => null }))
  assert.deepEqual(result, { kind: "redirect", href: "/quiz" })
})

test("scan boundary redirects when the quiz diagnostics are incomplete", async () => {
  const result = await resolveScanRouteAccess(
    scanDependencies({ getHairProfile: async () => null }),
  )
  assert.deepEqual(result, { kind: "redirect", href: "/quiz" })
})

test("scan boundary redirects when a single quiz field is missing", async () => {
  const result = await resolveScanRouteAccess(
    scanDependencies({
      getHairProfile: async () => ({ ...completeQuizProfile, density: null }),
    }),
  )
  assert.deepEqual(result, { kind: "redirect", href: "/quiz" })
})

test("scan boundary fails closed when the authenticated-user read is unavailable", async () => {
  const result = await resolveScanRouteAccess(
    scanDependencies({
      getUser: async () => {
        throw new Error("auth unavailable")
      },
    }),
  )
  assert.deepEqual(result, { kind: "redirect", href: "/quiz" })
})

test("scan boundary fails closed when the hair-profile read is unavailable", async () => {
  const result = await resolveScanRouteAccess(
    scanDependencies({
      getHairProfile: async () => {
        throw new Error("profile unavailable")
      },
    }),
  )
  assert.deepEqual(result, { kind: "redirect", href: "/quiz" })
})

// --- resolveScanPageTier (PR2 review fix, C1) --------------------------------

function tierDependencies(overrides: Partial<ScanPageTierDependencies> = {}) {
  return {
    getUser: async () => ({ id: "user-1", email: "user@example.com" }),
    resolvePaidAccess: async () => "denied" as FreemiumAccessResult,
    ...overrides,
  } satisfies ScanPageTierDependencies
}

test("scan page tier: a paid-access composite of 'allowed' is premium", async () => {
  const tier = await resolveScanPageTier(
    tierDependencies({ resolvePaidAccess: async () => "allowed" }),
  )
  assert.equal(tier, "premium")
})

test("scan page tier: a paid-access composite of 'denied' is free", async () => {
  const tier = await resolveScanPageTier(
    tierDependencies({ resolvePaidAccess: async () => "denied" }),
  )
  assert.equal(tier, "free")
})

test("scan page tier: an email-only manual/moderator grant is premium (C1 repro) — the nav classification's id-only lookup would have called this user free", async () => {
  const seenArgs: Array<[string, string | null | undefined, boolean]> = []
  const tier = await resolveScanPageTier(
    tierDependencies({
      getUser: async () => ({ id: "user-1", email: "grant@example.com" }),
      resolvePaidAccess: async (userId, email, fieldTestGuest) => {
        seenArgs.push([userId, email, fieldTestGuest])
        // Simulates `resolvePaidAppAccess`: an email-keyed manual access grant with no
        // `user_id` row resolves "allowed" only because `email` was threaded through.
        return email === "grant@example.com" ? "allowed" : "denied"
      },
    }),
  )
  assert.equal(tier, "premium")
  assert.deepEqual(seenArgs, [["user-1", "grant@example.com", false]])
})

test("scan page tier: a field-test guest is passed through to the paid-access composite", async () => {
  let sawFieldTestGuest = false
  await resolveScanPageTier(
    tierDependencies({
      getUser: async () => ({
        id: "user-1",
        email: null,
        app_metadata: { access_kind: "field_test" },
      }),
      resolvePaidAccess: async (_userId, _email, fieldTestGuest) => {
        sawFieldTestGuest = fieldTestGuest
        return "denied"
      },
    }),
  )
  assert.equal(sawFieldTestGuest, true)
})

test("scan page tier: fails closed to premium (never free) when the paid-access composite is unavailable", async () => {
  const tier = await resolveScanPageTier(
    tierDependencies({ resolvePaidAccess: async () => "unavailable" }),
  )
  assert.equal(tier, "premium")
})

test("scan page tier: no authenticated user is premium (never free)", async () => {
  const tier = await resolveScanPageTier(tierDependencies({ getUser: async () => null }))
  assert.equal(tier, "premium")
})
