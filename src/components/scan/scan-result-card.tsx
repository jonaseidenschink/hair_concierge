"use client"

import { ExternalLink } from "lucide-react"

import {
  scanAlternativeMetaLine,
  scanCriterionMarker,
  scanNotNeededSections,
  scanReasonsLabel,
} from "@/lib/scan/result-presentation"
import { SCAN_REVEAL_EMPTY_NOTICE } from "@/lib/scan/verdict-labels"
import type {
  ScanAlternativePresentation,
  ScanProductHeader,
  ScanStatusToken,
} from "@/lib/scan/types"
import {
  isMaskedScanVerdict,
  scanRevealCta,
  type ScanVerdictResult,
} from "@/lib/scan/verdict-access"
import type { Stage3CriterionResult } from "@/lib/personal-plan/products/contracts"
import { cn } from "@/lib/utils"

import { ScanDimensionBar } from "./scan-dimension-bar"
import { ScanMaskedAlternatives } from "./scan-masked-alternatives"
import { ScanProductThumb } from "./scan-product-thumb"
import { SCAN_MARKER_CLASS, SCAN_STATUS_CLASS } from "./scan-status-tokens"

/**
 * The scan verdict body (UI spec §2). Same anatomy in every verdict: product header,
 * state-coloured banner, bars, "Warum"-block, alternatives (or what already covers the
 * job), quiet re-scan link. Every sentence about the user comes from the payload —
 * this file only owns fixed section chrome.
 */

const STATUS_CLASS = SCAN_STATUS_CLASS
const MARKER_CLASS = SCAN_MARKER_CLASS

/**
 * Fixed reassurance for a verdict that can change with the profile behind it. Not
 * user-specific, so it is UI chrome rather than payload copy.
 */
const GOOD_TO_KNOW_TITLE = "Gut zu wissen"
const GOOD_TO_KNOW_BODY = "Ändert sich dein Haar oder deine Routine, prüfen wir das für dich neu."

export function ScanResultCard({
  result,
  revealedAlternatives = null,
  revealAnimates = true,
  revealPending = false,
  revealUnavailable = false,
  onRescan,
  onOpenAlternative,
  onBuyAlternative,
  onReveal = () => {},
  onPremiumAlternatives = () => {},
}: {
  result: ScanVerdictResult
  /**
   * Free tier only (T9): the full alternatives the one-lifetime reveal handed back for
   * THIS product. Always `null` for a premium or flag-off verdict, whose alternatives
   * were never masked in the first place.
   */
  revealedAlternatives?: ScanAlternativePresentation[] | null
  /**
   * Whether `revealedAlternatives` should play the 1.2s unblur (fix round 1, F2). `true`
   * for an explicit CTA tap; `false` for the background same-product re-serve (a rescan or
   * a reload replaying a credit already spent on this exact product) — nothing is being
   * "revealed" to the user there, so the card should simply already look sharp.
   */
  revealAnimates?: boolean
  revealPending?: boolean
  revealUnavailable?: boolean
  onRescan: () => void
  onOpenAlternative: (productId: string) => void
  /** An alternative's "Kaufen ↗" is a buy click too — same event as the footer's. */
  onBuyAlternative: (productId: string) => void
  onReveal?: () => void
  onPremiumAlternatives?: () => void
}) {
  const sections =
    result.kind === "not_needed"
      ? scanNotNeededSections(result)
      : { reasons: false, goodToKnow: false, coveredBy: false }

  /**
   * Three mutually exclusive shapes for the alternatives block. The LAST one is today's
   * path, reached by every premium and every flag-off verdict (their response carries no
   * masking marker at all), and it renders exactly as before this task.
   */
  let alternativesBlock: React.ReactNode = null
  if (result.kind === "in_catalog" && isMaskedScanVerdict(result)) {
    if (revealedAlternatives) {
      if (revealedAlternatives.length > 0) {
        // The reveal succeeded: the SAME card the premium tier gets. `revealAnimates`
        // decides whether it arrives out of the masked card's blur (globals.css, 1.2s,
        // inert under reduced motion) — an explicit tap — or already sharp — the
        // background same-product re-serve (fix round 1, F2).
        const alternativesList = (
          <Alternatives
            alternatives={revealedAlternatives}
            onOpen={onOpenAlternative}
            onBuy={onBuyAlternative}
          />
        )
        alternativesBlock = revealAnimates ? (
          <div className="scan-reveal-unblur" data-scan-revealed-alternatives="">
            {alternativesList}
          </div>
        ) : (
          <div data-scan-revealed-alternatives="">{alternativesList}</div>
        )
      } else {
        // Not reachable via today's `revealAlternatives()` (it never dispatches
        // `reveal_succeeded` with an empty list — see `reveal_failed reason:"empty"`), but
        // an empty list must not silently erase the whole block for whoever calls the
        // reducer next (fix round 1, F4).
        alternativesBlock = (
          <p data-scan-reveal-empty="" className="text-[13px] leading-6 text-muted-foreground">
            {SCAN_REVEAL_EMPTY_NOTICE}
          </p>
        )
      }
    } else if (result.alternatives.length > 0) {
      alternativesBlock = (
        <ScanMaskedAlternatives
          alternatives={result.alternatives}
          cta={scanRevealCta({
            freeRevealAvailable: result.freeRevealAvailable,
            revealUnavailable,
          })}
          revealPending={revealPending}
          onReveal={onReveal}
          onPremium={onPremiumAlternatives}
        />
      )
    }
  } else if (result.kind === "in_catalog" && result.alternatives.length > 0) {
    alternativesBlock = (
      <Alternatives
        alternatives={result.alternatives}
        onOpen={onOpenAlternative}
        onBuy={onBuyAlternative}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <ProductHeader product={result.product} />

      {result.kind === "in_catalog" ? (
        <Banner status={result.status} title={result.verdictTitle} subtitle={result.subtitle} />
      ) : (
        <Banner status={result.status} title={result.headline} subtitle={result.subtitle} />
      )}

      {result.dimensions.length > 0 ? (
        <section className="divide-y divide-border rounded-[14px] border border-border bg-card px-4 py-1">
          {result.dimensions.map((dimension) => (
            <ScanDimensionBar key={dimension.dimensionId} dimension={dimension} />
          ))}
        </section>
      ) : null}

      {result.kind === "in_catalog" &&
      result.dimensions.length === 0 &&
      result.criteria.length > 0 ? (
        <CriterionRows criteria={result.criteria} />
      ) : null}

      {result.kind === "in_catalog" && result.fitNarrative ? (
        <WhyCard label={scanReasonsLabel({ kind: "in_catalog", verdict: result.verdict })}>
          <p className="text-sm leading-6 text-foreground">{result.fitNarrative.fit}</p>
          <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
            {result.fitNarrative.productCriteria}
          </p>
        </WhyCard>
      ) : null}

      {result.kind === "not_needed" && sections.reasons ? (
        <WhyCard
          label={scanReasonsLabel({
            kind: "not_needed",
            mode: result.mode,
            category: result.product.category,
          })}
        >
          <ul className="flex flex-col gap-2">
            {result.reasons.map((reason) => (
              <li key={reason} className="text-sm leading-6 text-foreground">
                {reason}
              </li>
            ))}
          </ul>
        </WhyCard>
      ) : null}

      {result.kind === "not_needed" && sections.goodToKnow ? (
        <section className="rounded-[14px] bg-muted px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
            {GOOD_TO_KNOW_TITLE}
          </p>
          <p className="mt-1.5 text-[13px] leading-6 text-muted-foreground">{GOOD_TO_KNOW_BODY}</p>
        </section>
      ) : null}

      {result.kind === "not_needed" && sections.coveredBy ? (
        <CoveredBy entries={result.coveredBy} />
      ) : null}

      {alternativesBlock}

      <button
        type="button"
        onClick={onRescan}
        className="min-h-[44px] self-center text-sm font-semibold text-[var(--brand-plum)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-plum)] focus-visible:ring-offset-2"
      >
        Nochmal scannen
      </button>
    </div>
  )
}

function ProductHeader({ product }: { product: ScanProductHeader }) {
  return (
    // pr-9 keeps the title clear of the sheet's absolute close button (right-3, 40px).
    <div className="flex items-center gap-3 pr-9">
      <ScanProductThumb imageUrl={product.imageUrl} label={product.name} size={48} />
      <div className="min-w-0">
        <h2 className="break-words text-[15px] font-bold leading-snug text-foreground">
          {product.name}
        </h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          {product.brand ? `${product.brand} · ` : ""}
          <span className="font-semibold text-[var(--brand-plum)]">{product.categoryLabel}</span>
        </p>
      </div>
    </div>
  )
}

function Banner({
  status,
  title,
  subtitle,
}: {
  status: ScanStatusToken
  title: string
  subtitle: string
}) {
  return (
    <div className={cn("rounded-[14px] px-4 py-3.5", STATUS_CLASS[status])}>
      <p className="text-[17px] font-bold leading-snug">{title}</p>
      <p className="mt-1 text-[13px] leading-5 opacity-90">{subtitle}</p>
    </div>
  )
}

function WhyCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[14px] bg-[var(--brand-plum-ice)] px-4 py-3.5">
      <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--brand-plum)]">
        {label}
      </p>
      <div className="mt-2">{children}</div>
    </section>
  )
}

function CriterionRows({ criteria }: { criteria: Stage3CriterionResult[] }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-[14px] border border-border bg-card px-4 py-3.5">
      {criteria.map((criterion) => {
        const marker = scanCriterionMarker(criterion.result)
        return (
          <div key={criterion.criterionId} className="flex gap-2.5">
            <span
              aria-hidden="true"
              className={cn("mt-0.5 shrink-0 text-sm font-bold", MARKER_CLASS[marker.tone])}
            >
              {marker.marker}
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-foreground">{criterion.label}</p>
              <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">
                {criterion.explanation}
              </p>
            </div>
          </div>
        )
      })}
    </section>
  )
}

function CoveredBy({ entries }: { entries: Array<{ label: string; detail: string | null }> }) {
  return (
    <section>
      {/* Inline lead-in sentence, not a standalone header like "Passende Alternativen"
          above it (copy sign-off 2026-09-01, reverting the earlier header deviation) —
          the colon reads straight into the covering entries below. */}
      <p className="mb-2 text-[13px] leading-5 text-muted-foreground">Das übernimmt bei dir:</p>
      <ul className="flex flex-col gap-2">
        {entries.map((entry) => (
          <li
            key={`${entry.label}|${entry.detail}`}
            className="rounded-[12px] border border-border bg-card px-3 py-2.5"
          >
            <p className="text-[13px] font-semibold text-foreground">{entry.label}</p>
            {entry.detail ? (
              <p className="mt-0.5 text-[12px] text-muted-foreground">{entry.detail}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Alternatives({
  alternatives,
  onOpen,
  onBuy,
}: {
  alternatives: ScanAlternativePresentation[]
  onOpen: (productId: string) => void
  onBuy: (productId: string) => void
}) {
  return (
    <section>
      <p className="mb-2 text-[13px] font-bold text-foreground">Passende Alternativen</p>
      <ul className="flex flex-col gap-2">
        {alternatives.map((alternative) => {
          const meta = scanAlternativeMetaLine(alternative)
          return (
            <li
              key={alternative.productId}
              className="flex items-center gap-3 rounded-[12px] border border-border bg-card px-3 py-2.5"
            >
              <button
                type="button"
                onClick={() => onOpen(alternative.productId)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-plum)] focus-visible:ring-offset-2"
              >
                <ScanProductThumb
                  imageUrl={alternative.imageUrl}
                  label={alternative.displayName}
                  size={40}
                />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold text-foreground">
                    {alternative.displayName}
                  </span>
                  {meta ? (
                    <span className="mt-0.5 block text-[12px] text-muted-foreground">{meta}</span>
                  ) : null}
                </span>
              </button>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    STATUS_CLASS[alternative.verdict === "ideal" ? "ok" : "pending"],
                  )}
                >
                  {alternative.verdictLabel}
                </span>
                {alternative.purchaseUrl ? (
                  <a
                    href={alternative.purchaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => onBuy(alternative.productId)}
                    className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--brand-coral-dark)] underline-offset-4 hover:underline"
                  >
                    Kaufen
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
