import {
  deriveAlternativeComparison,
  type ScanAlternativeComparison,
} from "./alternative-comparison"
import type {
  ScanAlternative,
  ScanInCatalogVerdictPayload,
  ScanProductHeader,
  ScanVerdict,
} from "./types"
import type { ScanSavedStatePayload } from "./saved-state"
import type { ScanSnapshotSource } from "./profile-context"

/**
 * Free-tier alternative contract (T8, plan §PR2). Every identifying or resolvable field
 * from `ScanAlternative`/`ScanAlternativePresentation` — `productId`, `displayName`,
 * `imageUrl`, `priceLabel`, `netContentLabel` — is withheld. A distinct type (not
 * `ScanAlternative` with fields optionally omitted at runtime) so a stray identity field
 * added here later is a compile error at every call site, not a runtime leak.
 */
export type ScanMaskedAlternative = {
  verdict: Extract<ScanVerdict, "ideal" | "supportive">
  verdictLabel: string
  comparison: ScanAlternativeComparison
}

export function maskAlternative(alternative: ScanAlternative): ScanMaskedAlternative {
  return {
    verdict: alternative.verdict,
    verdictLabel: alternative.verdictLabel,
    comparison: deriveAlternativeComparison(alternative.criteria ?? []),
  }
}

/**
 * The masked shape of an `in_catalog` verdict payload: every other field (dimensions,
 * criteria, coverage, fit narrative, verdict copy for the SCANNED product) is untouched —
 * masking only ever applies to the `alternatives` list (binding constraint, plan §PR2/T8).
 * The scanned product's own identity is never masked; the caller already knows what it
 * scanned.
 */
export type ScanMaskedInCatalogVerdictPayload = Omit<
  ScanInCatalogVerdictPayload,
  "alternatives"
> & {
  alternatives: ScanMaskedAlternative[]
}

export function maskScanVerdictPayload(
  verdict: ScanInCatalogVerdictPayload,
): ScanMaskedInCatalogVerdictPayload {
  return {
    ...verdict,
    alternatives: verdict.alternatives.map(maskAlternative),
  }
}

/**
 * The full free-tier `/api/scan/resolve` response shape for an `in_catalog` verdict:
 * masked alternatives plus the reveal affordance (`freeRevealAvailable`, backed by T7's
 * `hasUsedFreeReveal` — the one-lifetime credit). `product`/`snapshotSource`/`savedState`
 * mirror `ScanResolvedVerdictResult` unchanged — only `alternatives` differs from the
 * premium shape.
 */
export type ScanMaskedVerdictResult = ScanMaskedInCatalogVerdictPayload & {
  product: ScanProductHeader
  snapshotSource: ScanSnapshotSource
  savedState: ScanSavedStatePayload
  freeRevealAvailable: boolean
}
