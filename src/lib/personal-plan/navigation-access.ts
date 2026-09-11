import "server-only"

import { cache } from "react"
import { after } from "next/server"

import {
  type NavSurfaceVisitedState,
  type PersonalPlanLifecycleClient,
  type PersonalPlanNavSurface,
  loadVisitedNavSurfaces,
  recordNavSurfaceVisited,
  shouldShowNavUnvisitedDot,
} from "@/lib/personal-plan/lifecycle/repository"
import { resolvePaidAppAccess } from "@/lib/entitlements/access"
import { getEntitlements, type EntitlementTier } from "@/lib/entitlements"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import { createAdminClient } from "@/lib/supabase/admin"
import { isPersonalPlanFieldTestGuest } from "@/lib/supabase/middleware"
import { createClient } from "@/lib/supabase/server"
import { loadPersonalPlanJourneyAccessForUser } from "./journey-access-loader"
import type { PersonalPlanJourneyAccess } from "./journey-access"

/**
 * Single source of truth for the nav tab-key union. `PersonalPlanNavSurface`
 * (lifecycle/repository.ts) is declared independently from this — that
 * module has no reason to import the nav module — so
 * tests/personal-plan-nav-surface-union-sync.test.ts asserts the two stay
 * in sync at test time.
 */
export const PERSONAL_PLAN_NAVIGATION_ITEM_KEYS = [
  "chat",
  "routine",
  "scan",
  "application",
  "profile",
] as const
export type PersonalPlanNavigationItemKey = (typeof PERSONAL_PLAN_NAVIGATION_ITEM_KEYS)[number]

export type PersonalPlanNavigationItem = {
  key: PersonalPlanNavigationItemKey
  href: "/chat" | "/routine" | "/scan" | "/anwendung" | "/profile"
  label: "Chat" | "Routine" | "Scan" | "Anwendung" | "Profil"
}

// Product ruling (2026-08-31): the navigation never changes composition —
// every Personal Plan (and, under the freemium restructure, every free-tier)
// user always sees the same five tabs. Access enforcement for pre-plan or
// unpaid users remains the middleware frontier redirect / page-level checks,
// not this list.
const PERSONAL_PLAN_NAVIGATION_ITEMS: readonly PersonalPlanNavigationItem[] = [
  { key: "chat", href: "/chat", label: "Chat" },
  { key: "routine", href: "/routine", label: "Routine" },
  { key: "scan", href: "/scan", label: "Scan" },
  { key: "application", href: "/anwendung", label: "Anwendung" },
  { key: "profile", href: "/profile", label: "Profil" },
]

export type AuthenticatedAppNavigationAccess =
  | { kind: "legacy" }
  | {
      kind: "personal_plan"
      items: readonly PersonalPlanNavigationItem[]
      hasPendingRoutineProposal: boolean
      /**
       * Whether `/routine` is a real destination for this user (Stage 4
       * reached) rather than the deliberately hidden "Routine nicht
       * verfügbar" page. Independent of `items` now that the nav always
       * lists all five tabs (product ruling 2026-08-31) — see
       * `hasRoutineTabAccess`.
       */
      hasRoutineAccess: boolean
      /**
       * Tabs to show the never-visited dot on (Task 2.9, decision 14).
       * Always a subset of `items`' keys — computed from the same list, so
       * a currently-ungated tab never dots — and never contains "routine"
       * (see `shouldShowNavUnvisitedDot`).
       */
      unvisitedNavSurfaces: ReadonlySet<PersonalPlanNavSurface>
      /**
       * T1 entitlements tier (freemium scanner-first restructure). A real
       * Personal Plan owner (this object built from a paid `personal_plan` /
       * `personal_plan_start` journey access) is always "premium". A "free"
       * value only appears for the synthetic five-tab nav built for an
       * authenticated user with no paid app access when the freemium flag is
       * on (see `resolveAuthenticatedAppNavigationAccess`) — `PersonalPlanNavigation`
       * uses it to decide which tabs draw the lock marker.
       */
      tier: EntitlementTier
    }

export type AuthenticatedAppNavigationResolverDeps = {
  getUserId: () => Promise<string | null>
  loadJourneyAccess: (userId: string) => Promise<PersonalPlanJourneyAccess>
  /** Omit to render with no nav dots at all (safe default; see below). */
  loadNavVisitedState?: (userId: string) => Promise<NavSurfaceVisitedState>
  /**
   * T1's `hasAppAccess` signal (same semantics as the existing
   * `hasCurrentAppAccess` check) — only consulted when the freemium
   * scanner-first flag is on and `loadJourneyAccess` resolved to `legacy`.
   * Omit to render exactly today's legacy shell for that population (safe
   * default: never promotes a user to the free-tier five-tab nav without
   * this signal, which also keeps a paid pre-restructure "legacy" customer
   * on their unchanged shell instead of misclassifying them as free tier).
   */
  loadHasAppAccess?: (userId: string) => Promise<boolean>
}

export function toAuthenticatedAppNavigationAccess(
  access: PersonalPlanJourneyAccess,
  navVisitedState?: NavSurfaceVisitedState,
): AuthenticatedAppNavigationAccess {
  if (access.kind !== "personal_plan" && access.kind !== "personal_plan_start") {
    return { kind: "legacy" }
  }

  const items = PERSONAL_PLAN_NAVIGATION_ITEMS

  // No `navVisitedState` (caller didn't wire the lifecycle read) degrades the
  // same way an unavailable read does: zero dots, never all of them.
  const unvisitedNavSurfaces = new Set<PersonalPlanNavSurface>(
    navVisitedState
      ? items
          .map((item) => item.key)
          .filter((key) => shouldShowNavUnvisitedDot(navVisitedState, key))
      : [],
  )

  return {
    kind: "personal_plan",
    items,
    hasPendingRoutineProposal:
      access.kind === "personal_plan" ? access.hasPendingRoutineProposal === true : false,
    unvisitedNavSurfaces,
    hasRoutineAccess: access.allowed.stage4,
    // A `personal_plan` / `personal_plan_start` journey access is only ever
    // resolved for a user with current paid app access (see
    // `resolvePersonalPlanJourneyAccess`) — always "premium", independent of
    // the freemium flag.
    tier: "premium",
  }
}

/**
 * The five-tab nav for an authenticated user with no paid app access, built
 * without a Personal Plan journey (freemium scanner-first restructure,
 * flag-gated — see `resolveAuthenticatedAppNavigationAccess`). Same fixed
 * item list and tab-stable behavior as a real Personal Plan owner; `tier:
 * "free"` is what tells `PersonalPlanNavigation` to draw lock markers, and
 * `hasRoutineAccess: false` / an empty `unvisitedNavSurfaces` reflect that
 * this user has no accepted routine and no visit history to track.
 */
function freeTierPersonalPlanNavigationAccess(): AuthenticatedAppNavigationAccess {
  return {
    kind: "personal_plan",
    items: PERSONAL_PLAN_NAVIGATION_ITEMS,
    hasPendingRoutineProposal: false,
    hasRoutineAccess: false,
    unvisitedNavSurfaces: EMPTY_UNVISITED_NAV_SURFACES,
    tier: "free",
  }
}

const EMPTY_UNVISITED_NAV_SURFACES: ReadonlySet<PersonalPlanNavSurface> = new Set()

/**
 * Whether `/routine` is a real destination for this user rather than the
 * deliberately hidden "Routine nicht verfügbar" page. The nav always lists
 * a Routine tab now (product ruling 2026-08-31: fixed five-tab composition
 * for every Personal Plan user), so this reads the underlying Stage 4
 * signal (`hasRoutineAccess`) instead of tab presence.
 *
 * The Profil tab's Haarprofil section links „Dein Plan“ at the plan view
 * (`/routine`) and presents it as done, so it stays absent for a mid-journey
 * buyer who has not reached Stage 4 yet (Task 2.5, review round 1).
 */
export function hasRoutineTabAccess(access: AuthenticatedAppNavigationAccess): boolean {
  return access.kind === "personal_plan" && access.hasRoutineAccess
}

export async function resolveAuthenticatedAppNavigationAccess(
  deps: AuthenticatedAppNavigationResolverDeps,
): Promise<AuthenticatedAppNavigationAccess> {
  try {
    const userId = await deps.getUserId()
    if (!userId) return { kind: "legacy" }
    const access = await deps.loadJourneyAccess(userId)
    if (access.kind !== "personal_plan" && access.kind !== "personal_plan_start") {
      // Freemium scanner-first restructure (flag-gated): an authenticated
      // user with no Personal Plan journey access still gets the five-tab
      // shell — as "free" tier, with lock markers — as long as they also
      // have no paid app access at all. `access.kind === "legacy"` alone
      // isn't enough to tell that apart from a pre-restructure paying
      // customer outside the new-buyer cohort ("premium legacy state", which
      // must keep today's legacy shell unchanged) — `loadHasAppAccess` (T1's
      // `hasAppAccess` signal) is what makes the distinction. `paid_pending`
      // is left untouched: its own recovery UI already handles that state.
      if (access.kind === "legacy" && deps.loadHasAppAccess && isFreemiumScannerFirstEnabled()) {
        const entitlements = await getEntitlements(userId, { hasAppAccess: deps.loadHasAppAccess })
        if (entitlements.tier === "free") return freeTierPersonalPlanNavigationAccess()
      }
      return { kind: "legacy" }
    }
    // Only fetched for a Personal Plan destination: skip the extra read for
    // legacy/paid-pending users, who never see nav dots anyway.
    const navVisitedState = await deps.loadNavVisitedState?.(userId)
    return toAuthenticatedAppNavigationAccess(access, navVisitedState)
  } catch {
    // This is a presentation fallback only. Pages and APIs retain their own
    // owner/frontier checks and continue to fail closed independently.
    return { kind: "legacy" }
  }
}

export const loadCachedPersonalPlanJourneyAccessForUser = cache(
  loadPersonalPlanJourneyAccessForUser,
)

/**
 * The request-scoped authenticated user, not just their id: the freemium paid-access
 * composite needs `email` (email-bound manual/moderator grants have no `user_id` row)
 * and `app_metadata.access_kind` (field-test guests skip the moderator lookup). `cache()`
 * keeps this to ONE `auth.getUser()` per request, shared with
 * `loadCachedAuthenticatedAppUserId` below, so nothing pays for the extra fields.
 */
const loadCachedAuthenticatedAppUser = cache(
  async (): Promise<{
    id: string
    email?: string | null
    app_metadata?: Record<string, unknown>
  } | null> => (await (await createClient()).auth.getUser()).data.user ?? null,
)

export const loadCachedAuthenticatedAppUserId = cache(
  async () => (await loadCachedAuthenticatedAppUser())?.id ?? null,
)

const loadCachedNavVisitedStateForUser = cache(
  async (userId: string): Promise<NavSurfaceVisitedState> =>
    loadVisitedNavSurfaces(createAdminClient() as unknown as PersonalPlanLifecycleClient, userId),
)

/**
 * T1's `hasAppAccess` signal.
 *
 * **T17 (deferral 2 — T3 note + PR2 review C1).** This used to be
 * `hasCurrentAppAccess(admin, { userId, email: null })`: user-id only, no email path,
 * justified at the time because the value gated nothing but a cosmetic nav lock marker.
 * That justification expired once `/scan`, the gated Routine/Anwendung/Chat pages and
 * `/profile` all started deriving their REAL behaviour from the email-aware composite
 * (`resolveAuthenticatedAppPageTier`). An email-bound manual/moderator grant
 * (friend/tester/admin/support — `findCurrentManualAccessGrant`'s nullable-`user_id`
 * email path) has no `user_id` row to match, so those holders saw UNLOCKED pages under
 * LOCKED nav badges — the nav lying about the app.
 *
 * It now runs the same composite those surfaces use (`resolvePaidAppAccess`: `active ||
 * oneTimeAccessState === "active" || moderatorAccess === "active"`, with the
 * `hasCurrentPaidAppAccess` re-check for an ended/unreadable moderator grant), fed the
 * email and `access_kind` from the shared request-scoped user read above. Every other
 * cohort resolves identically to before, with one deliberate exception: an ENDED or
 * unreadable moderator grant (where the old check reported `active`) now resolves via
 * the composite's re-check and can flip nav from unlocked to locked — matching what the
 * page-level gates already do for that cohort. For every other cohort the composite only
 * ever turns a *false* "free" into "premium", never the reverse.
 *
 * `"unavailable"` (an unreadable moderator lookup with no independent paid entitlement)
 * maps to `true`/premium, matching `resolveAuthenticatedAppPageTier`'s fail-closed rule:
 * this repo never picks "free" as the fail-closed answer.
 *
 * The flag-independent `resolvePaidAppAccess` is deliberate rather than
 * `hasFreemiumPaidAccess`: the only call site is already inside
 * `isFreemiumScannerFirstEnabled()` (see `resolveAuthenticatedAppNavigationAccess`), so
 * the flag gate is not repeated here, and flag-off never reaches this function at all.
 */
export async function resolveNavigationPaidAccess(
  userId: string,
  deps: {
    loadUser: () => Promise<{
      id: string
      email?: string | null
      app_metadata?: Record<string, unknown>
    } | null>
    resolveAccess: typeof resolvePaidAppAccess
  },
): Promise<boolean> {
  const user = await deps.loadUser()
  // Only trust the session user's email/metadata when it IS this user — the caller
  // always passes the session's own id today, but nothing in the type enforces it.
  const sessionUser = user?.id === userId ? user : null
  const access = await deps.resolveAccess(
    userId,
    sessionUser?.email,
    sessionUser ? isPersonalPlanFieldTestGuest(sessionUser) : false,
  )
  return access !== "denied"
}

const loadCachedHasAppAccessForUser = cache(
  (userId: string): Promise<boolean> =>
    resolveNavigationPaidAccess(userId, {
      loadUser: loadCachedAuthenticatedAppUser,
      resolveAccess: resolvePaidAppAccess,
    }),
)

export type SchedulePersonalPlanNavSurfaceVisitDeps = {
  loadUserId?: () => Promise<string | null>
  client?: () => PersonalPlanLifecycleClient
  scheduleAfter?: typeof after
  now?: () => string
}

/**
 * Marks `surface` visited for the current user the first time they land on
 * it (Task 2.9): a no-op unless `navigation` already says the dot should be
 * showing there, so re-visiting a surface after the first time never writes
 * again. Call from a nav-target layout (chat/routine/scan/anwendung/profile)
 * right after resolving that layout's `navigation`.
 *
 * Uses `after()` (mirrors the `scheduleAfter` dependency pattern in
 * src/app/api/quiz/personal-plan-lead/route.ts) so the write never delays
 * the response — this is a presentation nicety (a dot disappearing), not
 * something the page's own render should wait on. The write itself
 * tolerates failure exactly like the Task 2.3 dismiss route: a
 * pre-migration `undefined_table` just means the dot may still show on the
 * next visit, nothing more (see lifecycle/repository.ts's module doc
 * comment). All deps are overridable for tests — `after()` throws outside a
 * real request scope.
 */
export async function schedulePersonalPlanNavSurfaceVisit(
  navigation: AuthenticatedAppNavigationAccess,
  surface: PersonalPlanNavSurface,
  deps: SchedulePersonalPlanNavSurfaceVisitDeps = {},
): Promise<void> {
  if (navigation.kind !== "personal_plan") return
  if (!navigation.unvisitedNavSurfaces.has(surface)) return

  const loadUserId = deps.loadUserId ?? loadCachedAuthenticatedAppUserId
  const userId = await loadUserId()
  if (!userId) return

  const client =
    deps.client ?? (() => createAdminClient() as unknown as PersonalPlanLifecycleClient)
  const scheduleAfter = deps.scheduleAfter ?? after
  const now = deps.now ?? (() => new Date().toISOString())

  scheduleAfter(() =>
    recordNavSurfaceVisited(client(), { userId, surface, visitedAt: now() }).catch((error) => {
      console.warn("personal_plan_nav_surface_visit_write_failed", { surface, error })
    }),
  )
}

export const loadAuthenticatedAppNavigationAccess = cache(
  async (): Promise<AuthenticatedAppNavigationAccess> =>
    resolveAuthenticatedAppNavigationAccess({
      getUserId: loadCachedAuthenticatedAppUserId,
      loadJourneyAccess: loadCachedPersonalPlanJourneyAccessForUser,
      loadNavVisitedState: loadCachedNavVisitedStateForUser,
      loadHasAppAccess: loadCachedHasAppAccessForUser,
    }),
)
