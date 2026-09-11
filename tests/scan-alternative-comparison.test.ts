import assert from "node:assert/strict"
import test from "node:test"

import {
  deriveAlternativeComparison,
  type ScanComparisonRow,
} from "../src/lib/scan/alternative-comparison"
import type { Stage3CriterionResult } from "../src/lib/personal-plan/products/contracts"

function criterion(overrides: Partial<Stage3CriterionResult> = {}): Stage3CriterionResult {
  return {
    criterionId: "conditioner.care_direction",
    label: "Pflegerichtung",
    result: "pass",
    explanation: "Passt zu deinem Feuchtigkeitsbedarf.",
    ...overrides,
  }
}

test("deriveAlternativeComparison: no criteria yields an empty comparison with a zero score", () => {
  const comparison = deriveAlternativeComparison([])
  assert.deepEqual(comparison, { rows: [], summaryScore: 0 })
})

test("deriveAlternativeComparison: a pass criterion becomes a match row", () => {
  const comparison = deriveAlternativeComparison([criterion({ result: "pass" })])
  assert.deepEqual(comparison.rows, [
    { rowId: "conditioner.care_direction", label: "Pflegerichtung", state: "match" },
  ])
  assert.equal(comparison.summaryScore, 1)
})

test("deriveAlternativeComparison: caution/fail/unknown map to partial/mismatch/unknown", () => {
  const comparison = deriveAlternativeComparison([
    criterion({ criterionId: "a", result: "caution" }),
    criterion({ criterionId: "b", result: "fail" }),
    criterion({ criterionId: "c", result: "unknown" }),
  ])
  assert.deepEqual(
    comparison.rows.map((row) => row.state),
    ["partial", "mismatch", "unknown"],
  )
})

test("deriveAlternativeComparison: summary score is the fraction of matching rows", () => {
  const comparison = deriveAlternativeComparison([
    criterion({ criterionId: "a", result: "pass" }),
    criterion({ criterionId: "b", result: "pass" }),
    criterion({ criterionId: "c", result: "fail" }),
    criterion({ criterionId: "d", result: "unknown" }),
  ])
  assert.equal(comparison.summaryScore, 0.5)
})

test("deriveAlternativeComparison: preserves criteria order and copies id/label verbatim", () => {
  const comparison = deriveAlternativeComparison([
    criterion({ criterionId: "shampoo.scalp_route", label: "Kopfhaut-Fokus" }),
    criterion({ criterionId: "shampoo.cleansing_intensity", label: "Reinigungsstärke" }),
  ])
  assert.deepEqual(
    comparison.rows.map((row) => [row.rowId, row.label]),
    [
      ["shampoo.scalp_route", "Kopfhaut-Fokus"],
      ["shampoo.cleansing_intensity", "Reinigungsstärke"],
    ],
  )
})

test("deriveAlternativeComparison: a row never carries anything beyond rowId/label/state", () => {
  const comparison = deriveAlternativeComparison([criterion()])
  const row = comparison.rows[0] as ScanComparisonRow
  assert.deepEqual(Object.keys(row).sort(), ["label", "rowId", "state"])
})

test("deriveAlternativeComparison: is a pure function — same input, same output, no mutation", () => {
  const input = [criterion({ criterionId: "x" })]
  const frozen = Object.freeze([...input])
  const first = deriveAlternativeComparison(frozen)
  const second = deriveAlternativeComparison(frozen)
  assert.deepEqual(first, second)
})
