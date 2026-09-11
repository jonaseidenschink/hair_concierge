import type {
  PersonalPlanCategory,
  Stage3CriterionResult,
} from "@/lib/personal-plan/products/contracts"
import type { PlanProductRole } from "@/lib/personal-plan/types"

import type { ScanOpenSubmissionStatus } from "./pending-submission"
import type { ScanSnapshotSource } from "./profile-context"
import type { ScanSavedStatePayload } from "./saved-state"

/**
 * Render-ready contract for the scan result sheet. Everything here is already
 * German and already bounded — the API route and the UI add no product logic.
 */

export type ScanVerdict = "ideal" | "supportive" | "mismatch" | "unknown"

/** Maps onto the `--status-*` design tokens the result banner is painted with. */
export type ScanStatusToken = "ok" | "pending" | "danger" | "neutral"

export type ScanDimensionState = "in_target" | "outside_target" | "no_target" | "unknown"

export type ScanDimensionStop = {
  stopId: string
  label: string
}

export type ScanDimension = {
  dimensionId: string
  label: string
  stops: ScanDimensionStop[]
  /** Empty when the profile has no target on this axis (always so for `not_needed`). */
  targetStopIds: string[]
  /**
   * Set-valued because catalog axes such as "Geeignete Haardicke" legitimately
   * cover several stops. Empty when the product value is not confirmed.
   */
  productStopIds: string[]
  state: ScanDimensionState
}

export type ScanAlternative = {
  productId: string
  displayName: string
  imageUrl: string | null
  priceLabel: string | null
  netContentLabel: string | null
  verdict: Extract<ScanVerdict, "ideal" | "supportive">
  verdictLabel: string
  /**
   * Server-internal only (T8): the candidate's already-computed fit criteria, carried
   * through so the free-tier masked serializer (`masked-alternative.ts`) can derive
   * comparison rows without re-evaluating fit. Never reaches the wire — both
   * `ScanAlternativePresentation` below and the masked shape explicitly leave it off their
   * own field lists, so a stray leak here is a compile error, not a runtime one.
   */
  criteria?: readonly Stage3CriterionResult[]
}

/**
 * Commerce/identity fields the verdict core cannot know: `buildScanVerdict` works on
 * authority facts, which deliberately carry no brand and no purchase link. The resolve
 * route joins them on from the catalog row (see `product-presentation.ts`). `criteria` is
 * explicitly omitted (see `ScanAlternative` above) — it never reached the wire before T8
 * and must not start now, so the full/premium shape stays byte-identical.
 */
export type ScanAlternativePresentation = Omit<ScanAlternative, "criteria"> & {
  brand: string | null
  purchaseUrl: string | null
}

/**
 * The scanned product itself, as the sheet header renders it (spec §2.1) and as the
 * "Kaufen · <Preis>" footer slot needs it (spec §3).
 */
export type ScanProductHeader = {
  productId: string
  name: string
  brand: string | null
  category: PersonalPlanCategory
  categoryLabel: string
  imageUrl: string | null
  priceLabel: string | null
  purchaseUrl: string | null
}

export type ScanCoveredByEntry = {
  /** What already covers the job, e.g. "Conditioner". */
  label: string
  /** The job it covers, e.g. "Repair-Pflege". */
  detail: string | null
}

export type ScanInCatalogVerdictPayload = {
  kind: "in_catalog"
  verdict: ScanVerdict
  verdictLabel: string
  verdictTitle: string
  status: ScanStatusToken
  subtitle: string
  evaluatedRole: PlanProductRole | null
  evaluatedRoleLabel: string | null
  dimensions: ScanDimension[]
  /** Criterion-row fallback for compact categories without dimensions. */
  criteria: Stage3CriterionResult[]
  coverage: { matches: number; total: number } | null
  fitNarrative: { productCriteria: string; fit: string } | null
  /**
   * At most three, on every verdict including `ideal` (ruling R12) — the section is only
   * hidden when the category has nothing to offer.
   */
  alternatives: ScanAlternative[]
}

/**
 * `not_needed` is a settled "you don't need this"; `deferred` is "we haven't decided
 * yet" — the same payload shape, but the headline must not claim a need verdict the
 * decision has not reached.
 */
export type ScanNeedMode = "not_needed" | "deferred"

export type ScanNotNeededVerdictPayload = {
  kind: "not_needed"
  mode: ScanNeedMode
  status: Extract<ScanStatusToken, "neutral">
  headline: string
  subtitle: string
  reasons: string[]
  /** Product-only bars: no target exists for a category the profile does not need. */
  dimensions: ScanDimension[]
  coveredBy: ScanCoveredByEntry[]
}

export type ScanVerdictPayload = ScanInCatalogVerdictPayload | ScanNotNeededVerdictPayload

/** The verdict payload after the route joined catalog presentation onto the alternatives. */
export type ScanPresentedVerdictPayload =
  | (Omit<ScanInCatalogVerdictPayload, "alternatives"> & {
      alternatives: ScanAlternativePresentation[]
    })
  | ScanNotNeededVerdictPayload

/**
 * The three FULL shapes `POST /api/scan/resolve` can return. Since T8 the route has a
 * fourth, free-tier-only branch — `ScanMaskedVerdictResult` (`masked-alternative.ts`) —
 * which is deliberately not a member here, so nothing that consumes this union can read
 * an identity field off a masked alternative. The client-side union covering both tiers
 * is `ScanClientResolveResult` in `verdict-access.ts`.
 *
 * The two verdict payloads above
 * gain `product` (the scanned catalog row as the header/footer render it),
 * `snapshotSource` (which profile snapshot the verdict was evaluated against — see
 * `ScanEvaluationContext`) and `savedState` (merkliste/routine/neither, plus whether the
 * scan surface may remove that row — see `saved-state.ts`); the other two branches
 * short-circuit before a verdict exists at all.
 */
export type ScanResolvedVerdictResult = ScanPresentedVerdictPayload & {
  product: ScanProductHeader
  snapshotSource: ScanSnapshotSource
  savedState: ScanSavedStatePayload
}

export type ScanPendingSubmissionResult = {
  kind: "pending_submission"
  submissionId: string
  headline: string
  status: ScanOpenSubmissionStatus
}

export type ScanUnknownProductResult = {
  kind: "unknown_product"
  /**
   * Ruling R9: the v1 API only ever emits an EAN. `identifier-lookup.ts` still matches
   * `ean|gtin|barcode` DB-side, but that 3-way type never reaches a client contract.
   */
  identifier: { type: "ean"; value: string }
  categories: Array<{ key: PersonalPlanCategory; label: string }>
}

export type ScanResolveResult =
  | ScanResolvedVerdictResult
  | ScanPendingSubmissionResult
  | ScanUnknownProductResult
