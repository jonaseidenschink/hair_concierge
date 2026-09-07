"use client"

import { useState } from "react"

import { ChevronDown } from "lucide-react"

import type { PersonalPlanCategory } from "@/lib/personal-plan/products/contracts"
import type { ScanUnknownProductResult } from "@/lib/scan/types"
import {
  SCAN_UNKNOWN_BRIDGE,
  SCAN_UNKNOWN_HEADLINE,
  SCAN_UNKNOWN_QUESTION,
  SCAN_UNKNOWN_SUBLINE,
} from "@/lib/scan/verdict-labels"
import { cn } from "@/lib/utils"

/**
 * Unknown-product intake (success-first, one tap — copy sign-off 2026-09-01): a single
 * step whose only question is the shelf category. Tapping a card submits immediately —
 * there is no brand/product-name step. The barcode plus category is everything the
 * research queue needs; asking for more would only cost taps (product ruling,
 * plans/scan-public-launch.md Task 9).
 */

/** The five most-scanned shelf categories stay visible; the rest sit behind the expander. */
const PRIMARY_CATEGORIES: PersonalPlanCategory[] = [
  "shampoo",
  "conditioner",
  "leave_in",
  "mask",
  "oil",
]

export type ScanSubmissionInput = {
  category: PersonalPlanCategory
}

export function ScanUnknownFlow({
  unknown,
  submitting,
  error,
  onSubmit,
}: {
  unknown: ScanUnknownProductResult
  submitting: boolean
  error: string | null
  onSubmit: (input: ScanSubmissionInput) => void
}) {
  const [showAll, setShowAll] = useState(false)
  // Tracks which card was tapped so only that one swaps its label to the submitting
  // state; `submitting` (parent-owned) still gates every card against a second tap.
  const [tappedCategory, setTappedCategory] = useState<PersonalPlanCategory | null>(null)

  const primary = unknown.categories.filter((entry) => PRIMARY_CATEGORIES.includes(entry.key))
  const rest = unknown.categories.filter((entry) => !PRIMARY_CATEGORIES.includes(entry.key))
  const visible = showAll ? [...primary, ...rest] : primary

  const handleTap = (category: PersonalPlanCategory) => {
    if (submitting) return
    setTappedCategory(category)
    onSubmit({ category })
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-header text-2xl leading-tight text-foreground">
          {SCAN_UNKNOWN_HEADLINE}
        </h2>
        <p className="mt-2 text-sm leading-6 text-foreground">{SCAN_UNKNOWN_BRIDGE}</p>
        <p className="mt-1 text-sm leading-6 text-[var(--text-sub)]">{SCAN_UNKNOWN_SUBLINE}</p>
      </div>

      <p className="text-[15px] font-semibold leading-6 text-foreground">{SCAN_UNKNOWN_QUESTION}</p>

      <div className="grid gap-2">
        {visible.map((entry) => {
          // Derived, not remembered: once the request has settled no card is "the one
          // being submitted" any more. Keeping the raw `tappedCategory` here left a
          // failed attempt highlighted and labelled as in flight next to its error (F17).
          const isTapped = tappedCategory === entry.key && submitting
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => handleTap(entry.key)}
              disabled={submitting}
              aria-pressed={isTapped}
              className={cn(
                "flex min-h-[56px] items-center rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed",
                isTapped
                  ? "border-[var(--brand-plum)] bg-[var(--brand-plum-ice)]"
                  : "border-border bg-card hover:border-[var(--brand-plum)]/40",
                submitting && !isTapped ? "opacity-60" : null,
              )}
            >
              <span className="block text-[17px] font-bold text-foreground">
                {isTapped ? "Wird eingereicht" : entry.label}
              </span>
            </button>
          )
        })}
        {!showAll && rest.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            disabled={submitting}
            className="flex min-h-[56px] items-center justify-between rounded-xl border border-dashed border-[var(--brand-plum-light)] p-3 text-left text-[15px] font-semibold text-[var(--brand-plum)] transition-colors hover:border-[var(--brand-plum)] disabled:cursor-not-allowed"
          >
            <span>Weitere Produktarten</span>
            <ChevronDown className="h-5 w-5" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <p className="text-center text-xs tabular-nums text-muted-foreground">
        Barcode {unknown.identifier.value}
      </p>

      {error ? (
        <p role="alert" className="text-sm text-[var(--brand-coral-dark)]">
          {error}
        </p>
      ) : null}
    </div>
  )
}
