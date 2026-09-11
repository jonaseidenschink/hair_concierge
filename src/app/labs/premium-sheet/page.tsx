import { notFound } from "next/navigation"

import { PremiumSheetLabClient } from "./premium-sheet-lab-client"
import { PREMIUM_FEATURES, type PremiumFeatureId } from "@/lib/premium-sheet/context"

/**
 * Dev-only harness for the Premium sheet (T13).
 *
 * The real sheet only opens from a signed-in FREE account behind the freemium flag, so
 * this is the cheapest honest way to review every state at a real mobile viewport: pick
 * the tapped feature (that benefit leads, accented) and the opening surface (that decides
 * the escape label), then open the sheet. It renders the SAME component the app renders —
 * no harness copy of the markup, prices or copy.
 *
 * `?feature=<id>` preselects a feature. Same guard as every other `/labs` page: a
 * production build 404s.
 */
export default async function PremiumSheetLabPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if (process.env.NODE_ENV !== "development") notFound()

  const raw = (await searchParams).feature
  const requested = Array.isArray(raw) ? raw[0] : raw
  const initialFeature: PremiumFeatureId =
    requested && Object.hasOwn(PREMIUM_FEATURES, requested)
      ? (requested as PremiumFeatureId)
      : "empfehlungen"

  return (
    <div className="min-h-dvh bg-background">
      <header className="flex h-14 items-center border-b border-border px-4">
        <span className="font-header text-2xl tracking-wide text-[var(--text-heading)]">
          chaarlie
        </span>
      </header>
      <PremiumSheetLabClient initialFeature={initialFeature} />
    </div>
  )
}
