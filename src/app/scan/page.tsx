import { redirect } from "next/navigation"

import { loadScanPageTier, loadScanRouteAccess } from "@/lib/auth/authenticated-app-route-access"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"

import { ScanPageClient } from "./scan-page-client"

export default async function ScanPage() {
  const access = await loadScanRouteAccess()
  if (access.kind === "redirect") redirect(access.href)

  // PR2 review fix (C1): the free tier's Merken bookmark, premium pitches and trigger-layer
  // storage must lock/gate from the very first paint, before any verdict has proven the
  // tier from a response shape — but the tier prop can no longer come from
  // `loadAuthenticatedAppNavigationAccess` (nav classification): that loader's free-tier
  // signal is intentionally looked up by user id only (no email), which is fine for a
  // cosmetic nav lock marker but wrongly free-tiers an email-keyed manual/moderator access
  // grant now that this same value gates real behavior. `loadScanPageTier` uses the same
  // email-aware, field-test-aware paid-access composite the scan APIs enforce with, and
  // fails closed to "premium" (never "free") if that composite is unavailable.
  const tier = await loadScanPageTier()
  // T16: the bookmark's count badge/deep-link and the „Gemerkt" section it points at are
  // both gated on the flag itself, independent of tier — `tier` alone cannot tell a
  // flag-off session apart from a flag-on premium one (`loadScanPageTier` returns
  // "premium" for both), and flag-off must stay byte-identical to today. A plain server
  // read: `isFreemiumScannerFirstEnabled()` is not Edge/browser-safe, so it cannot be read
  // from `ScanFlow` itself.
  const merklisteEnabled = isFreemiumScannerFirstEnabled()

  return <ScanPageClient tier={tier} merklisteEnabled={merklisteEnabled} />
}
