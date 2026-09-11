"use client"

import { Check, CircleHelp, Minus, X } from "lucide-react"

import type {
  ScanAlternativeComparison,
  ScanComparisonRowState,
} from "@/lib/scan/alternative-comparison"
import type { ScanMaskedAlternative } from "@/lib/scan/masked-alternative"
import type { ScanRevealCta } from "@/lib/scan/verdict-access"
import { cn } from "@/lib/utils"

import { SCAN_STATUS_CLASS } from "./scan-status-tokens"

/**
 * The free tier's alternatives block (T9, plan §PR2). Everything the server was willing
 * to tell a free user about a better-fitting product — its fit verdict and its
 * criterion-by-criterion comparison — is fully readable here; only the identity is
 * missing, and it is missing because the response never carried it (`ScanMaskedAlternative`
 * has no id, name, image or price field at all). Nothing on this surface can leak what
 * the server withheld.
 *
 * Visual language deliberately mirrors the refinement comparison table
 * (`personal-plan-products/product-fit-comparison.tsx` → "Eigenschaft für Eigenschaft"):
 * a bordered card, a fixed two-column table, a row tint per state and the same four
 * relation marks — so a user who has seen one recognises the other.
 *
 * Exactly one CTA, decided by `cta`: the one-lifetime reveal while the credit is unspent,
 * the Premium sheet afterwards.
 */

const SECTION_TITLE = "Passende Alternativen"
const MASKED_IDENTITY_LABEL = "Produkt verdeckt"
const CRITERION_COLUMN_LABEL = "Prüfpunkt"
const STATE_COLUMN_LABEL = "Passt zu dir"

export const SCAN_REVEAL_CTA_LABEL = "Produkt aufdecken — einmalig gratis"
export const SCAN_PREMIUM_ALTERNATIVES_CTA_LABEL = "Was passt stattdessen?"

const ROW_TINT: Record<ScanComparisonRowState, string> = {
  match: "bg-[var(--status-ok-bg)]/35",
  partial: "bg-[var(--status-pending-bg)]/35",
  mismatch: "bg-[var(--status-danger-bg)]/35",
  unknown: "",
}

const ROW_RULE: Record<ScanComparisonRowState, string> = {
  match: "border-l-[var(--status-ok-text)]",
  partial: "border-l-[var(--status-pending-text)]",
  mismatch: "border-l-[var(--status-danger-text)]",
  unknown: "border-l-transparent",
}

function markPresentation(state: ScanComparisonRowState) {
  switch (state) {
    case "match":
      return {
        ariaLabel: "Im Ziel",
        Icon: Check,
        className: "border-[var(--status-ok-text)] text-[var(--status-ok-text)]",
      }
    case "partial":
      return {
        ariaLabel: "Passt mit Einschränkung",
        Icon: Minus,
        className: "border-[var(--status-pending-text)] text-[var(--status-pending-text)]",
      }
    case "mismatch":
      return {
        ariaLabel: "Außerhalb des Ziels",
        Icon: X,
        className: "border-[var(--status-danger-text)] text-[var(--status-danger-text)]",
      }
    case "unknown":
      return {
        ariaLabel: "Nicht bestätigt",
        Icon: CircleHelp,
        className: "border-muted-foreground text-muted-foreground",
      }
  }
}

export function scanComparisonMatchCount(comparison: ScanAlternativeComparison): number {
  return comparison.rows.filter((row) => row.state === "match").length
}

export function ScanMaskedAlternatives({
  alternatives,
  cta,
  revealPending,
  onReveal,
  onPremium,
}: {
  alternatives: readonly ScanMaskedAlternative[]
  cta: ScanRevealCta
  revealPending: boolean
  onReveal: () => void
  onPremium: () => void
}) {
  return (
    <section data-scan-masked-alternatives="">
      <p className="mb-2 text-[13px] font-bold text-foreground">{SECTION_TITLE}</p>
      <ul className="flex flex-col gap-2">
        {alternatives.map((alternative, index) => (
          <li
            // Masked alternatives carry no id by contract; their position in the
            // server-ranked list is the only identity the client has.
            key={`${alternative.verdict}-${index}`}
            className="overflow-hidden rounded-[12px] border border-border bg-card"
          >
            <MaskedIdentityRow alternative={alternative} />
            <ComparisonTable comparison={alternative.comparison} />
          </li>
        ))}
      </ul>

      {cta === "reveal" ? (
        <button
          type="button"
          data-scan-reveal-cta=""
          onClick={onReveal}
          disabled={revealPending}
          aria-busy={revealPending}
          className="mt-3 flex min-h-[48px] w-full items-center justify-center rounded-[12px] bg-[var(--brand-coral)] px-4 text-[15px] font-semibold text-white transition-colors hover:bg-[var(--brand-coral-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-coral)] focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {SCAN_REVEAL_CTA_LABEL}
        </button>
      ) : (
        <button
          type="button"
          data-scan-premium-cta=""
          onClick={onPremium}
          className="mt-3 flex min-h-[48px] w-full items-center justify-center rounded-[12px] bg-[var(--brand-coral)] px-4 text-[15px] font-semibold text-white transition-colors hover:bg-[var(--brand-coral-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-coral)] focus-visible:ring-offset-2"
        >
          {SCAN_PREMIUM_ALTERNATIVES_CTA_LABEL}
        </button>
      )}
    </section>
  )
}

function MaskedIdentityRow({ alternative }: { alternative: ScanMaskedAlternative }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      {/* The placeholder stands in for a product image the response never carried; the
          blur is what the successful reveal animates away from (`scan-reveal-unblur`). */}
      <span aria-hidden="true" className="h-10 w-10 shrink-0 rounded-[10px] bg-muted blur-[2px]" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-muted-foreground">
        {MASKED_IDENTITY_LABEL}
      </span>
      <span
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
          SCAN_STATUS_CLASS[alternative.verdict === "ideal" ? "ok" : "pending"],
        )}
      >
        {alternative.verdictLabel}
      </span>
    </div>
  )
}

function ComparisonTable({ comparison }: { comparison: ScanAlternativeComparison }) {
  if (comparison.rows.length === 0) return null
  const matches = scanComparisonMatchCount(comparison)
  return (
    <>
      <table lang="de" className="w-full table-fixed border-collapse text-[11px]">
        <thead>
          <tr className="text-muted-foreground">
            <th className="w-[70%] border-t border-border py-1.5 pl-3 pr-2 text-left font-medium">
              {CRITERION_COLUMN_LABEL}
            </th>
            <th className="border-t border-border py-1.5 pr-3 text-right font-medium">
              {STATE_COLUMN_LABEL}
            </th>
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((row) => (
            <tr key={row.rowId} className={cn("border-t border-border", ROW_TINT[row.state])}>
              <th
                scope="row"
                className={cn(
                  "break-words border-l-2 py-2 pl-3 pr-2 text-left text-[11px] font-semibold leading-tight text-foreground [hyphens:auto]",
                  ROW_RULE[row.state],
                )}
              >
                {row.label}
              </th>
              <td className="py-2 pr-3 text-right align-middle">
                <ComparisonMark state={row.state} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        {matches} von {comparison.rows.length} Prüfpunkten im Ziel
      </p>
    </>
  )
}

function ComparisonMark({ state }: { state: ScanComparisonRowState }) {
  const presentation = markPresentation(state)
  const Icon = presentation.Icon
  return (
    <span
      aria-label={presentation.ariaLabel}
      role="img"
      className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
        presentation.className,
      )}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden="true" />
    </span>
  )
}
