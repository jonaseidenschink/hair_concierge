"use client"

import { useRouter } from "next/navigation"

import { ScanFlow } from "@/components/scan/scan-flow"
import type { EntitlementTier } from "@/lib/entitlements"
import { scanAnalytics } from "@/lib/scan/scan-analytics"

/**
 * Thin client boundary between the Server Component `page.tsx` and `ScanFlow`. `ScanFlow`
 * itself defaults its `analytics` prop to `noOpScanAnalytics` (so a bare `<ScanFlow />`
 * anywhere — Storybook, a future test harness — stays silent by default, matching how
 * `Stage3ProductsFlow` defaults to `noOpStage3Analytics`). `page.tsx` can't hand the real
 * consent-aware port down itself: it's a Server Component, and a port object with methods
 * can't cross the RSC boundary as a prop. This file exists solely to supply the real one
 * from inside client-side JS, the same way `plan-start-flow.tsx` passes
 * `stage3BaselineAnalytics` to `Stage3ProductsFlow`.
 *
 * `tier`/`merklisteEnabled` (fix round 1, F1; T16) are plain serializable values, so
 * `page.tsx` — the Server Component — hands them straight through; only the analytics PORT
 * and the router (T16's `navigate` DI seam, so `ScanFlow` never calls `useRouter()` itself
 * — see that prop's doc comment) needed this client boundary.
 */
/**
 * Honest notice for the one case where a free magic link deliberately did NOT
 * adopt the quiz it carried: the account that clicked it already had its own
 * hair profile, so `/auth/confirm` skipped the binding rather than overwrite it
 * (T18 fix round 1, review finding W1b). Without a line here the user would just
 * find themselves logged in with none of the answers they had expected.
 */
const BIND_SKIPPED_NOTICE =
  "Du bist mit deinem bestehenden Konto angemeldet. Deine gespeicherte Haaranalyse bleibt unverändert – die neue wurde nicht übernommen."

export function ScanPageClient({
  tier,
  merklisteEnabled,
  bindSkippedNotice = false,
}: {
  tier: EntitlementTier
  merklisteEnabled: boolean
  bindSkippedNotice?: boolean
}) {
  const router = useRouter()
  return (
    <>
      {bindSkippedNotice ? (
        <p
          className="mx-auto max-w-[36rem] px-5 pt-4 text-sm leading-6 text-[var(--text-sub)]"
          data-scan-bind-skipped-notice
          role="status"
        >
          {BIND_SKIPPED_NOTICE}
        </p>
      ) : null}
      <ScanFlow
        analytics={scanAnalytics}
        tier={tier}
        merklisteEnabled={merklisteEnabled}
        navigate={router.push}
      />
    </>
  )
}
