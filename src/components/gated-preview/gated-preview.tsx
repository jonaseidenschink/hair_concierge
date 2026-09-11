"use client"

import { useState, type ReactNode } from "react"

import { PremiumSheet } from "@/components/premium-sheet/premium-sheet"
import { Button } from "@/components/ui/button"
import type { PremiumFeatureId } from "@/lib/premium-sheet/context"

/**
 * Gated content surface (T11, freemium-scanner-first PR3).
 *
 * A free user opening Routine / Anwendung / Chat sees a framed **example** of the real
 * app instead of their own degraded content. The frame is the honesty mechanism — blur
 * was explicitly rejected: nothing here pretends to be the user's data, the „Beispiel"
 * band says what it is.
 *
 * Layout contract (Nick: "adjust to the actual mobile screen size", all gated pages the
 * same size): the component owns exactly one screen inside the authenticated shell. The
 * example scrolls INSIDE the frame; the page body never grows, so the benefit line and
 * the single CTA stay pinned at the bottom of the viewport without any sticky machinery —
 * they are simply the last row of a fixed-height flex column.
 *
 * Purely presentational: no fetching, no entitlement logic, no analytics. The caller
 * (T12) decides whether a user sees this at all and supplies every German string.
 */

/**
 * One screen inside the authenticated shell: viewport minus the sticky header and the
 * fixed mobile bottom nav. Both come from `AuthenticatedAppShell`'s custom properties;
 * the fallbacks keep the component honest anywhere else (e.g. the `/labs` harness) and
 * `md:` drops the bottom-nav reserve, which the shell also drops from `md` upwards.
 */
const SCREEN_HEIGHT_CLASS =
  "h-[calc(100dvh-var(--personal-plan-shell-header-offset,3.5rem)-var(--personal-plan-shell-bottom-padding,0px))] md:h-[calc(100dvh-var(--personal-plan-shell-header-offset,3.5rem))]"

export interface GatedPreviewProps {
  /** Which premium feature this page is — handed to the sheet as-is. */
  feature: PremiumFeatureId
  /** Surface identifier for the sheet context, e.g. "routine:gate". */
  source: string
  /** „Beispiel · …" band text, e.g. „Beispiel · eine Chaarlie-Routine". */
  exampleLabel: string
  /** Benefit-framed line above the CTA — never a generic "Premium freischalten". */
  benefit: string
  /** The one CTA's label. */
  cta: string
  /** The example content (T12). Taller than the frame — it is meant to scroll. */
  children: ReactNode
}

export function GatedPreview({
  feature,
  source,
  exampleLabel,
  benefit,
  cta,
  children,
}: GatedPreviewProps) {
  const [sheetOpen, setSheetOpen] = useState(false)

  return (
    <section
      data-gated-preview={feature}
      className={`flex ${SCREEN_HEIGHT_CLASS} flex-col gap-3 px-4 pb-4 pt-3`}
    >
      {/* Frame — device-screenshot feel: inset from the page edge, rounded, elevated. */}
      <div
        data-gated-preview-frame="true"
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-[var(--brand-plum-light)] bg-card shadow-[0_16px_36px_-32px_rgba(var(--brand-plum-rgb),0.65)]"
      >
        <p
          data-gated-preview-label="true"
          className="shrink-0 border-b border-[var(--brand-plum-light)] bg-[var(--brand-plum-ice)] px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-[var(--brand-plum-dark)]"
        >
          {exampleLabel}
        </p>

        {/* The one scroll container. `role="region"` + `tabIndex` so a keyboard user can
            reach and scroll it; `overscroll-contain` keeps the page behind it still. */}
        <div
          data-gated-preview-scroll="true"
          role="region"
          aria-label={exampleLabel}
          tabIndex={0}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand-plum)]"
        >
          {children}
        </div>
      </div>

      {/* Benefit + the single CTA. Last row of the fixed-height column = always visible. */}
      <div data-gated-preview-cta-block="true" className="shrink-0">
        <p className="mb-2 text-center text-[13px] leading-5 text-muted-foreground">{benefit}</p>
        <Button variant="cta" className="w-full" onClick={() => setSheetOpen(true)}>
          {cta}
        </Button>
      </div>

      <PremiumSheet
        open={sheetOpen}
        context={{ feature, source }}
        onClose={() => setSheetOpen(false)}
      />
    </section>
  )
}
