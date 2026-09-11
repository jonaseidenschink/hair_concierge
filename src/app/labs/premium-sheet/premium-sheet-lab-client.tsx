"use client"

import { useState } from "react"

import { PremiumSheet } from "@/components/premium-sheet/premium-sheet"
import { PREMIUM_FEATURES, type PremiumFeatureId } from "@/lib/premium-sheet/context"
import { ToastProvider } from "@/providers/toast-provider"

/**
 * Client half of the `/labs/premium-sheet` harness (T13). Every state the sheet can be
 * in is one tap away: which feature was tapped (that benefit leads, accented) and which
 * kind of surface opened it (that decides the escape label).
 */
const FEATURE_IDS = Object.keys(PREMIUM_FEATURES) as PremiumFeatureId[]

const SOURCES = [
  { id: "scan:verdict", label: "Scan-Verdict" },
  { id: "trigger:zwei-scans-gleiche-kategorie", label: "Trigger-Karte" },
  { id: "gated:routine", label: "Gated-Seite" },
] as const

export function PremiumSheetLabClient({ initialFeature }: { initialFeature: PremiumFeatureId }) {
  const [feature, setFeature] = useState<PremiumFeatureId>(initialFeature)
  const [source, setSource] = useState<string>(SOURCES[0].id)
  const [open, setOpen] = useState(false)

  // The unlock toast goes through the app-wide provider (T14 fix round 1, F3), which
  // `/labs` does not mount — same reason `/labs/scan` mounts its own.
  return (
    <ToastProvider>
      <div className="mx-auto flex max-w-md flex-col gap-5 p-5" data-premium-sheet-lab={feature}>
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Getipptes Feature
          </p>
          <div className="flex flex-wrap gap-2">
            {FEATURE_IDS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setFeature(id)}
                data-lab-feature={id}
                aria-pressed={id === feature}
                className={`rounded-full border px-3 py-2 text-[13px] ${
                  id === feature
                    ? "border-[var(--brand-plum)] bg-[var(--brand-plum-ice)] font-bold"
                    : "border-border"
                }`}
              >
                {PREMIUM_FEATURES[id].name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Quelle
          </p>
          <div className="flex flex-wrap gap-2">
            {SOURCES.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => setSource(candidate.id)}
                data-lab-source={candidate.id}
                aria-pressed={candidate.id === source}
                className={`rounded-full border px-3 py-2 text-[13px] ${
                  candidate.id === source
                    ? "border-[var(--brand-plum)] bg-[var(--brand-plum-ice)] font-bold"
                    : "border-border"
                }`}
              >
                {candidate.label}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setOpen(true)}
          data-lab-open-sheet="true"
          className="min-h-[54px] w-full rounded-[12px] bg-[var(--brand-coral)] px-5 py-3 text-[14px] font-bold text-white"
        >
          Sheet öffnen
        </button>

        <PremiumSheet
          open={open}
          context={{ feature, source }}
          onClose={() => setOpen(false)}
          onRequestOpen={() => setOpen(true)}
        />
      </div>
    </ToastProvider>
  )
}
