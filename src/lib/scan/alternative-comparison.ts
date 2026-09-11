import type { Stage3CriterionResult } from "@/lib/personal-plan/products/contracts"

/**
 * Free-tier masked-alternative comparison rows (T8). Pure, deterministic projection of a
 * candidate's already-computed `Stage3CriterionResult[]` (see `buildStage3FitComparison`'s
 * `Stage3SelectedComparisonCandidate.criteria`, resolve-verdict.ts's `alternativesFrom`) —
 * this never re-evaluates fit, ranks candidates, or reads anything else. `criterionId` and
 * `label` are copied verbatim: both are generic dimension/criterion identifiers ("Pflegegewicht",
 * "Reinigungsstärke", …), never product identity. `explanation` is deliberately dropped —
 * it is free text that was written to accompany a fully-identified product and is not
 * vetted as identity-safe on its own, so it never reaches a masked row.
 */

export type ScanComparisonRowState = "match" | "partial" | "mismatch" | "unknown"

export type ScanComparisonRow = {
  rowId: string
  label: string
  state: ScanComparisonRowState
}

export type ScanAlternativeComparison = {
  rows: ScanComparisonRow[]
  /**
   * Fraction of rows in `"match"` state, in [0, 1]. `0` when there are no rows.
   *
   * Contract-mandated (T8/plan), currently unconsumed by the UI: the "n von m
   * Prüfpunkten im Ziel" line counts `"match"` rows directly off `rows` instead, to avoid
   * float rounding on small row counts — a lossy projection of this same field, so the two
   * can never diverge (fix round 1 review, F5). Do not "fix" the UI to use this fraction;
   * it cannot recover the exact `n` without re-multiplying and rounding.
   */
  summaryScore: number
}

export function deriveAlternativeComparison(
  criteria: readonly Stage3CriterionResult[],
): ScanAlternativeComparison {
  const rows = criteria.map(
    (criterion): ScanComparisonRow => ({
      rowId: criterion.criterionId,
      label: criterion.label,
      state: comparisonRowState(criterion.result),
    }),
  )
  const matchCount = rows.filter((row) => row.state === "match").length
  return {
    rows,
    summaryScore: rows.length > 0 ? matchCount / rows.length : 0,
  }
}

function comparisonRowState(result: Stage3CriterionResult["result"]): ScanComparisonRowState {
  switch (result) {
    case "pass":
      return "match"
    case "caution":
      return "partial"
    case "fail":
      return "mismatch"
    case "unknown":
      return "unknown"
  }
}
