import "server-only"

import { resolveOneTimeAccessStateForUser } from "@/lib/billing/purchases"
import { hasCurrentAppAccess, hasCurrentPaidAppAccess } from "@/lib/billing/subscriptions"
import type { SupabaseBillingClient } from "@/lib/billing/types"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import {
  resolveModeratorAccess,
  type ModeratorAccessResolution,
} from "@/lib/personal-plan-field-test/moderator"
import { createAdminClient } from "@/lib/supabase/admin"

/**
 * The same paid-access composite the subscription paywall in
 * `src/lib/supabase/middleware.ts` uses — `active || oneTimeAccessState ===
 * "active" || moderatorAccess === "active"`, including the T2 review fix
 * (finding I1/I3) that recomputes `active` via `hasCurrentPaidAppAccess`
 * (which excludes manual grants) once a moderator grant has ended or its
 * lookup is unavailable, so a revoked field-test's manual access grant can't
 * keep counting as paid.
 *
 * Freemium-admitted API routes (e.g. `/api/scan/save`, `/api/scan/wishlist`
 * — see plans/freemium-scanner-first/enforcement-matrix.md) are reachable by
 * free-tier users once the middleware carve-out lets them through, but
 * middleware doesn't forward its own per-request computation to the route
 * handler — this recomputes the same signal directly against the
 * billing/moderator tables. `userId` is assumed already verified by the
 * caller's own auth check.
 *
 * T4 review fix (C1): `email` is threaded through to `hasAppAccess` because
 * `findCurrentManualAccessGrant` (src/lib/billing/subscriptions.ts) looks up
 * `manual_access_grants` by email as a first-class path (nullable `user_id`,
 * `CHECK user_id OR email`) — an email-bound grant (friend/tester/admin/
 * support) has no `user_id` row to match on, so omitting `email` here falsely
 * denies those holders even though the middleware paywall (which does pass
 * `email`) let them through.
 *
 * T4 review fix (I2): the `"unavailable"` moderator-lookup state is now
 * surfaced as its own result kind (mirroring the middleware's retriable 503,
 * `moderator_access_unavailable`) instead of being collapsed into a plain
 * deny — callers must map it to a 503, not a 403.
 *
 * PR1 review fix (F1): two more seams had to line up with middleware:
 *
 * 1. Middleware only applies the freemium admission carve-out — and thus
 *    only reaches this guard's routes at all for a free user — when
 *    `FREEMIUM_SCANNER_FIRST_ENABLED` is `"true"` (see
 *    `shouldRedirectToReactivation`). Before this fix the guard had no flag
 *    check of its own, so it ran its full composite (including the
 *    moderator lookup) unconditionally. That is not "redundant but
 *    harmless" when the flag is off: a field-test guest with a valid manual
 *    grant already reaches `/api/scan/save`/`/api/scan/wishlist` today
 *    (independent of this flag — see next point), and if their moderator
 *    lookup happened to be unavailable, the guard would 503 them where
 *    nothing on `main` does. The guard is now literally inert with the flag
 *    off — it returns `"allowed"` before touching `deps` at all, so it never
 *    performs a billing or moderator lookup in that state.
 * 2. With the flag on, middleware skips the moderator lookup entirely for a
 *    field-test guest (`user.app_metadata.access_kind === "field_test"`,
 *    `isPersonalPlanFieldTestGuest` in middleware.ts): `!fieldTestGuest &&
 *    dependencies.resolveModeratorAccess ? ... : Promise.resolve("none")`.
 *    Only `active` (manual-grant-inclusive `hasAppAccess`) and
 *    `oneTimeAccessState` decide a field-test guest's access; an unrelated
 *    moderator-lookup outage can never surface for them. This guard now
 *    takes the same `fieldTestGuest` signal and mirrors that skip, so an
 *    unavailable moderator lookup for a field-test guest can no longer
 *    diverge from middleware's outcome.
 */
export type HasFreemiumPaidAccessDeps = {
  client?: SupabaseBillingClient
  hasAppAccess?: typeof hasCurrentAppAccess
  hasPaidAppAccess?: typeof hasCurrentPaidAppAccess
  resolveOneTimeAccessState?: typeof resolveOneTimeAccessStateForUser
  resolveModeratorAccess?: typeof resolveModeratorAccess
}

/**
 * `"allowed"` / `"denied"` mirror the middleware paywall's binary outcome.
 * `"unavailable"` mirrors the middleware's `moderator_access_unavailable`
 * 503 — the moderator lookup couldn't be read and there is no independently
 * verified paid entitlement to fall back on, so the caller should ask the
 * client to retry rather than treat this as a hard subscription denial.
 */
export type FreemiumAccessResult = "allowed" | "denied" | "unavailable"

export async function hasFreemiumPaidAccess(
  userId: string,
  email: string | null | undefined,
  fieldTestGuest: boolean,
  deps: HasFreemiumPaidAccessDeps = {},
): Promise<FreemiumAccessResult> {
  // PR1 review fix (F1a): inert with the flag off. Every route this guard
  // covers stays fully middleware-gated when the flag is off (a free user
  // never reaches the route at all — see enforcement-matrix.md), so the
  // guard must not perform any billing/moderator lookup in that state; doing
  // so risks diverging from middleware for edge cases middleware itself
  // doesn't even evaluate while the flag is off (see the field-test note
  // above the deps type).
  if (!isFreemiumScannerFirstEnabled()) {
    return "allowed"
  }

  const client = deps.client ?? createAdminClient()
  const hasAppAccess = deps.hasAppAccess ?? hasCurrentAppAccess
  const hasPaidAppAccess = deps.hasPaidAppAccess ?? hasCurrentPaidAppAccess
  const resolveOneTimeAccessState =
    deps.resolveOneTimeAccessState ?? resolveOneTimeAccessStateForUser
  const resolveModerator = deps.resolveModeratorAccess ?? resolveModeratorAccess

  const [activeInitial, oneTimeAccessState, moderatorAccess] = await Promise.all([
    hasAppAccess(client, { userId, email }),
    resolveOneTimeAccessState(client, userId),
    // PR1 review fix (F1b): mirrors middleware.ts's `!fieldTestGuest &&
    // dependencies.resolveModeratorAccess ? ... : Promise.resolve("none")` —
    // a field-test guest's moderator lookup is never attempted, by
    // middleware or here, so it can never surface as "unavailable" for them.
    fieldTestGuest
      ? Promise.resolve<ModeratorAccessResolution>({ kind: "none" })
      : resolveModerator({ client, userId }),
  ])

  let active = activeInitial
  // Mirrors middleware.ts's `hasIndependentPaidEntitlement`: seeded from the
  // one-time state, then recomputed once the moderator grant has ended or is
  // unreadable so a stale manual grant folded into `active` can't keep
  // counting as paid.
  let hasIndependentPaidEntitlement = oneTimeAccessState === "active"
  if (moderatorAccess.kind === "ended" || moderatorAccess.kind === "unavailable") {
    hasIndependentPaidEntitlement = await hasPaidAppAccess(client, { userId })
    active = hasIndependentPaidEntitlement
  }

  if (moderatorAccess.kind === "unavailable" && !hasIndependentPaidEntitlement) {
    return "unavailable"
  }

  const allowed = active || oneTimeAccessState === "active" || moderatorAccess.kind === "active"
  return allowed ? "allowed" : "denied"
}
