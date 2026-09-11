import "server-only"

import { getEntitlements, type EntitlementTier } from "@/lib/entitlements"
import { hasFreemiumPaidAccess, type FreemiumAccessResult } from "@/lib/entitlements/access"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import {
  hasCompletedQuizDiagnostics,
  type PersistedQuizDiagnosticsProfile,
} from "@/lib/quiz/completion"
import { createClient } from "@/lib/supabase/server"
import { isPersonalPlanFieldTestGuest } from "@/lib/supabase/middleware"

export type TrackerRouteAccess = { kind: "allow" } | { kind: "redirect"; href: "/quiz" }

export type TrackerRouteAccessDependencies = {
  getUser: () => Promise<{ id: string } | null>
}

/**
 * Tracker's server boundary intentionally verifies only an authenticated user.
 * The proxy already owns subscription access; tracker has no intake, frontier,
 * entitlement, or Personal Plan routing decision to repeat here.
 */
export async function resolveTrackerRouteAccess(
  deps: TrackerRouteAccessDependencies,
): Promise<TrackerRouteAccess> {
  try {
    return (await deps.getUser()) ? { kind: "allow" } : { kind: "redirect", href: "/quiz" }
  } catch {
    return { kind: "redirect", href: "/quiz" }
  }
}

export async function loadTrackerRouteAccess(): Promise<TrackerRouteAccess> {
  const supabase = await createClient()
  return resolveTrackerRouteAccess({
    getUser: async () => (await supabase.auth.getUser()).data.user,
  })
}

export type ScanRouteAccess = { kind: "allow" } | { kind: "redirect"; href: "/quiz" }

export type ScanRouteAccessDependencies = {
  getUser: () => Promise<{ id: string } | null>
  getHairProfile: (userId: string) => Promise<PersistedQuizDiagnosticsProfile>
}

/**
 * Scan's server boundary verifies an authenticated user AND a completed quiz:
 * the verdict engine needs the hair profile the quiz writes, so an
 * unqualified user is sent to `/quiz` rather than shown an empty scanner.
 */
export async function resolveScanRouteAccess(
  deps: ScanRouteAccessDependencies,
): Promise<ScanRouteAccess> {
  try {
    const user = await deps.getUser()
    if (!user) return { kind: "redirect", href: "/quiz" }
    const hairProfile = await deps.getHairProfile(user.id)
    return hasCompletedQuizDiagnostics(hairProfile)
      ? { kind: "allow" }
      : { kind: "redirect", href: "/quiz" }
  } catch {
    return { kind: "redirect", href: "/quiz" }
  }
}

export async function loadScanRouteAccess(): Promise<ScanRouteAccess> {
  const supabase = await createClient()
  return resolveScanRouteAccess({
    getUser: async () => (await supabase.auth.getUser()).data.user,
    getHairProfile: async (userId) => {
      const { data } = await supabase
        .from("hair_profiles")
        .select(
          "hair_texture, thickness, density, cuticle_condition, protein_moisture_balance, scalp_type, scalp_condition, chemical_treatment, concerns",
        )
        .eq("user_id", userId)
        .maybeSingle()
      return data
    },
  })
}

export type AuthenticatedAppPageTierDependencies = {
  getUser: () => Promise<{
    id: string
    email?: string | null
    app_metadata?: Record<string, unknown>
  } | null>
  resolvePaidAccess: (
    userId: string,
    email: string | null | undefined,
    fieldTestGuest: boolean,
  ) => Promise<FreemiumAccessResult>
}

/**
 * Original PR2 name, kept as an alias: `/scan` was the first page to need this
 * composite, but nothing in it is scan-specific — T12's gated Routine/Anwendung/Chat
 * pages read the very same tier. Existing `/scan` callers and their tests keep
 * compiling against the old name.
 */
export type ScanPageTierDependencies = AuthenticatedAppPageTierDependencies

/**
 * PR2 review fix (C1): `/scan`'s `tier` prop gates BEHAVIORAL surfaces since T9 (locked
 * Merken, premium pitches, T10's trigger-layer storage) — it can no longer be sourced from
 * `loadAuthenticatedAppNavigationAccess`'s classification, whose free-tier signal
 * (`navigation-access.ts`'s `loadCachedHasAppAccessForUser`) is deliberately looked up by
 * user id ONLY, with no email fallback — a correct choice there because that nav lock
 * marker is purely cosmetic, but wrong here now that the same "free" value also locks
 * behavior. An email-keyed manual/moderator access grant (friend/tester/admin/support —
 * `findCurrentManualAccessGrant`'s nullable-`user_id` email path) would resolve "premium"
 * on `/api/scan/*` (which use `resolvePaidAppAccess`, email-aware) while this page kept
 * showing the locked free-tier UI: masked verdicts and a locked Merken for a user who can
 * actually save and see alternatives.
 *
 * This resolves the tier from the SAME email-aware, field-test-aware paid-access composite
 * the scan APIs use, via `hasFreemiumPaidAccess` — flag-independent-composite `resolvePaidAppAccess`
 * wrapped so the flag-off case is automatically "premium" with no billing/moderator lookup
 * at all, matching the repo-wide "flag off ⇒ byte-identical, tier is always premium"
 * invariant. Fails closed to `"premium"` on `"unavailable"` (an entitlement-source outage):
 * this repo's convention is "premium = no free surfaces", never "free" as the fail-closed
 * choice — mirrored from the same fail-closed rule on `/api/scan/resolve`.
 */
export async function resolveAuthenticatedAppPageTier(
  deps: AuthenticatedAppPageTierDependencies,
): Promise<EntitlementTier> {
  const user = await deps.getUser()
  if (!user) return "premium"

  const access = await deps.resolvePaidAccess(
    user.id,
    user.email,
    isPersonalPlanFieldTestGuest(user),
  )
  if (access === "unavailable") return "premium"

  const entitlements = await getEntitlements(user.id, {
    hasAppAccess: async () => access === "allowed",
  })
  return entitlements.tier
}

/** PR2 name for the route-agnostic resolver above; see `ScanPageTierDependencies`. */
export const resolveScanPageTier = resolveAuthenticatedAppPageTier

/**
 * Separate from `loadScanRouteAccess`'s own `getUser` call: that dependency's return type
 * carries only `{ id }` (the shape `resolveScanRouteAccess` needs), so the email + `access_kind`
 * `resolveAuthenticatedAppPageTier` needs have no path from it without a second
 * `auth.getUser()` read — a deliberate, request-scoped read, same pattern as
 * `resolvePaidAccessForCurrentUser` on `/api/scan/resolve`.
 *
 * T12 adds the flag short-circuit at the top. It changes no outcome —
 * `hasFreemiumPaidAccess` already returns `"allowed"` (hence `"premium"`) with zero
 * billing/moderator lookups while the flag is off — it only skips the request-scoped
 * `auth.getUser()` read in that state, so a flag-off render of Routine/Anwendung/Chat
 * stays cost-identical, not just byte-identical, to today.
 */
export async function loadAuthenticatedAppPageTier(): Promise<EntitlementTier> {
  if (!isFreemiumScannerFirstEnabled()) return "premium"
  const supabase = await createClient()
  return resolveAuthenticatedAppPageTier({
    getUser: async () => (await supabase.auth.getUser()).data.user,
    resolvePaidAccess: hasFreemiumPaidAccess,
  })
}

/** PR2 name for the route-agnostic loader above. */
export const loadScanPageTier = loadAuthenticatedAppPageTier
