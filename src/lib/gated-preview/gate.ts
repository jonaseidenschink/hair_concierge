import "server-only"

import {
  loadAuthenticatedAppAccessState,
  loadAuthenticatedAppPageTier,
  type AuthenticatedAppAccessState,
} from "@/lib/auth/authenticated-app-route-access"
import type { EntitlementTier } from "@/lib/entitlements"

/**
 * T17 (freemium-scanner-first PR5): what THIS request renders on Routine / Anwendung /
 * Chat, now that "not premium" has two shapes.
 *
 * - `"premium"` — today's real page, verbatim. Every flag-off request lands here with
 *   zero lookups, so the byte-identity rule still holds by construction.
 * - `"keepsake"` — a LAPSED user (held paid access, holds none now): the real page again,
 *   fed their OWN content, with every mutation locked to the Premium sheet.
 * - `"example"` — a never-paid free user: T12's framed „Beispiel" composition.
 *
 * Fail-closed to `"premium"` on any lookup failure, exactly like
 * `shouldRenderGatedExample` below — the billing reads underneath throw rather than
 * returning `"unavailable"`, and a thrown lookup must never open a free surface.
 */
export type GatedPageMode = "premium" | "keepsake" | "example"

export async function resolveGatedPageMode(
  loadAccessState: () => Promise<AuthenticatedAppAccessState> = loadAuthenticatedAppAccessState,
): Promise<GatedPageMode> {
  let state: AuthenticatedAppAccessState
  try {
    state = await loadAccessState()
  } catch {
    return "premium"
  }
  if (state === "lapsed") return "keepsake"
  return state === "free" ? "example" : "premium"
}

/**
 * The one server-side decision behind T12 (freemium-scanner-first PR3): does THIS request
 * render the framed „Beispiel" composition instead of the real Routine / Anwendung / Chat
 * page?
 *
 * Only the free tier does. Premium — and every request while the flag is off, which
 * `loadAuthenticatedAppPageTier` resolves to `"premium"` without a single lookup — falls
 * through to today's page untouched, so the keepsake/byte-identity rule holds by
 * construction: this predicate is the only branch the three pages gained.
 *
 * The tier itself is NOT recomputed here. It comes from the same email-aware,
 * field-test-aware paid-access composite `/scan` uses (PR2 review fix C1), which fails
 * closed to `"premium"` on a RETURNED `"unavailable"` (an entitlement-source outage).
 *
 * T17 note: the three gated pages now branch on `resolveGatedPageMode` above, which adds the
 * lapsed/keepsake state this two-valued predicate cannot express. This predicate is retained
 * as the free-vs-premium primitive (and its fail-closed contract is still pinned by
 * `tests/gated-example-pages.test.tsx`); it is unchanged.
 *
 * PR3 Codex fix (X1): that fail-closed handling only covers a returned `"unavailable"` —
 * the billing reads underneath it (`findCurrentBillingSubscriptionForUser`,
 * `findOneTimePurchaseEntitlementForUser`, etc., see `src/lib/billing/subscriptions.ts` and
 * `purchases.ts`) THROW on a query error instead of returning it. Uncaught, that throw used
 * to turn into a hard server error on `/chat` and reject the whole `Promise.all` on
 * `/routine` and `/anwendung` even though those pages' own resolvers had already succeeded.
 * `loadTier()` is therefore wrapped here so ANY tier-lookup failure — thrown or returned —
 * fails closed the same way: to `"premium"`, never `"free"`. This is the one place all three
 * gated pages funnel through, so the catch protects them all without touching each page's
 * own (already self-contained) data resolver.
 */
export async function shouldRenderGatedExample(
  loadTier: () => Promise<EntitlementTier> = loadAuthenticatedAppPageTier,
): Promise<boolean> {
  let tier: EntitlementTier
  try {
    tier = await loadTier()
  } catch {
    tier = "premium"
  }
  return tier === "free"
}
