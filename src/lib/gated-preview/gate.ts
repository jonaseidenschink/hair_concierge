import "server-only"

import { loadAuthenticatedAppPageTier } from "@/lib/auth/authenticated-app-route-access"
import type { EntitlementTier } from "@/lib/entitlements"

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
