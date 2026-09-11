"use client"

import { ExternalLink } from "lucide-react"

import { scanFooterActions, type ScanFooterTone } from "@/lib/scan/result-presentation"
import type { ScanSavedStatePayload } from "@/lib/scan/saved-state"
import type { ScanProductHeader, ScanVerdict } from "@/lib/scan/types"
import { cn } from "@/lib/utils"

import { ScanLockBadge } from "./scan-lock-badge"

/**
 * Pinned two-slot footer (UI spec §3). Slot order and weight follow the verdict; the
 * buy affordance is never removed, only labelled honestly. An unbuyable product drops
 * to a single full-width "Speichern" instead of a dead button.
 */

const TONE_CLASS: Record<ScanFooterTone, string> = {
  "coral-solid":
    "bg-[var(--brand-coral)] text-white hover:bg-[var(--brand-coral-dark)] focus-visible:ring-[var(--brand-coral)]",
  "coral-outline":
    "border-[1.5px] border-[var(--brand-coral)] bg-transparent text-[var(--brand-coral-dark)] hover:bg-[var(--brand-coral-light)] focus-visible:ring-[var(--brand-coral)]",
  "plum-solid":
    "bg-[var(--brand-plum)] text-white hover:bg-[var(--brand-plum-dark)] focus-visible:ring-[var(--brand-plum)]",
  "plum-outline":
    "border-[1.5px] border-[var(--brand-plum-light)] bg-[var(--brand-plum-ice)] text-[var(--brand-plum-dark)] hover:border-[var(--brand-plum)] focus-visible:ring-[var(--brand-plum)]",
}

// `whitespace-nowrap` + `min-w-0`: on a 390px screen "Trotzdem kaufen" next to
// "✓ In deiner Routine" otherwise wraps and gets clipped by the fixed slot height.
const SLOT_CLASS =
  "flex min-h-[48px] min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[12px] px-3 text-[14px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"

export function ScanActionFooter({
  kind,
  verdict,
  product,
  savedState,
  saveLocked = false,
  onSave,
  onBuy,
}: {
  kind: "in_catalog" | "not_needed"
  verdict: ScanVerdict | null
  product: ScanProductHeader
  savedState: ScanSavedStatePayload
  /**
   * Free tier under the freemium restructure (T9): Merken is a premium feature and
   * `/api/scan/save` denies it server-side, so the slot carries a corner lock and opens
   * the Premium sheet instead of the save sheet. Default `false` — premium and flag-off
   * callers keep today's footer exactly.
   */
  saveLocked?: boolean
  onSave: () => void
  onBuy: (url: string) => void
}) {
  const actions = scanFooterActions({ kind, verdict, product, savedState })

  return (
    <div className="flex gap-2">
      {actions.map((action) =>
        action.kind === "buy" ? (
          <a
            key="buy"
            href={action.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => onBuy(action.url)}
            className={cn(SLOT_CLASS, TONE_CLASS[action.tone])}
          >
            {action.label}
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
          </a>
        ) : saveLocked ? (
          <button
            key="save"
            type="button"
            data-scan-save-locked="true"
            aria-label={`${action.label} — Premium`}
            onClick={onSave}
            className={cn(SLOT_CLASS, TONE_CLASS[action.tone], "relative")}
          >
            {action.label}
            <ScanLockBadge />
          </button>
        ) : (
          <button
            key="save"
            type="button"
            onClick={onSave}
            className={cn(SLOT_CLASS, TONE_CLASS[action.tone])}
          >
            {action.label}
          </button>
        ),
      )}
    </div>
  )
}
