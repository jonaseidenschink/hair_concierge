import { redirect } from "next/navigation"

import { loadScanPageTier, loadScanRouteAccess } from "@/lib/auth/authenticated-app-route-access"
import {
  FREE_REGISTRATION_BIND_SKIPPED_PARAM,
  FREE_REGISTRATION_BIND_SKIPPED_VALUE,
} from "@/lib/auth/free-registration"
import { recoverMissingFreeSnapshot } from "@/lib/auth/free-registration-recovery"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import { createClient } from "@/lib/supabase/server"

import { ScanPageClient } from "./scan-page-client"

export default async function ScanPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
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

  // T18 fix round 1 (review finding W2): a free account whose confirm-time
  // snapshot provisioning failed used to be permanently stuck on
  // `profile_missing` with zero telemetry. This is the retry the confirm route's
  // comment always claimed existed — narrow by construction (flag on, tier
  // already resolved to `"free"` by the email-aware paid-access composite, and
  // only when no need version exists) and idempotent. Never allowed to break the
  // page: the scanner's own missing-profile state is still the fallback.
  if (merklisteEnabled && tier === "free") {
    try {
      const { data } = await (await createClient()).auth.getUser()
      if (data.user) {
        await recoverMissingFreeSnapshot({ userId: data.user.id, email: data.user.email })
      }
    } catch (error) {
      console.error("[free-registration] scan-visit provisioning retry failed:", error)
    }
  }

  const params = searchParams ? await searchParams : {}
  const bindSkippedNotice =
    merklisteEnabled &&
    params[FREE_REGISTRATION_BIND_SKIPPED_PARAM] === FREE_REGISTRATION_BIND_SKIPPED_VALUE

  return (
    <ScanPageClient
      tier={tier}
      merklisteEnabled={merklisteEnabled}
      bindSkippedNotice={bindSkippedNotice}
    />
  )
}
