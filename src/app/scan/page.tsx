import { redirect } from "next/navigation"

import { loadScanPageTier, loadScanRouteAccess } from "@/lib/auth/authenticated-app-route-access"

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

  return <ScanPageClient tier={tier} />
}
