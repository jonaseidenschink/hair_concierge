import type { CareBalanceRow } from "@/lib/recommendation-engine/types"
import { computeObservedCadences, countObservedWeeks } from "@/lib/tracking/aggregation"
import { computeNudges } from "@/lib/tracking/nudges"
import { evaluateTrustGate } from "@/lib/tracking/trust-gate"
import { getTrustGateQualifyingLogDates, type TrackerLogDay } from "@/lib/tracking/types"

export interface TrackingInsightContext {
  mode: "tracking_insight_context"
  authority: {
    observed_not_saved: true
    may_update_profile: false
    may_update_routine: false
    may_affect_product_ranking: false
    explanation_only: true
  }
  coverage: {
    window_days: 28
    logged_day_count: number
    observed_week_count: number
    sufficient: boolean
    reason:
      | "sufficient"
      | "insufficient_elapsed_time"
      | "insufficient_logged_days"
      | "insufficient_observed_weeks"
  }
  insights: Array<{
    category: string
    direction: "below_target" | "above_target"
    observed_weekly: number
    target_min_weekly: number
    target_max_weekly: number
    evidence_basis: "wash_rhythm" | "wash_share" | "day_level"
  }>
  notes: string
}

const TRACKING_INSIGHT_AUTHORITY: TrackingInsightContext["authority"] = {
  observed_not_saved: true,
  may_update_profile: false,
  may_update_routine: false,
  may_affect_product_ranking: false,
  explanation_only: true,
}

export function buildTrackingInsightContext(params: {
  days: TrackerLogDay[]
  today: string
  careBalanceRows: CareBalanceRow[]
  activeDismissals: Array<{ category: string; direction: string }>
}): TrackingInsightContext {
  const qualifyingDates = getTrustGateQualifyingLogDates(params.days)
  const gate = evaluateTrustGate(qualifyingDates, params.today)
  const observedWeekCount = countObservedWeeks(params.days)
  const sufficient = gate.unlocked && observedWeekCount >= 2
  const reason: TrackingInsightContext["coverage"]["reason"] = sufficient
    ? "sufficient"
    : gate.daysSinceFirstLog < 14
      ? "insufficient_elapsed_time"
      : gate.loggedDayCount < 10
        ? "insufficient_logged_days"
        : "insufficient_observed_weeks"

  const policyRows = params.careBalanceRows.map((row) => ({
    category: row.category,
    cadencePolicy: row.cadencePolicy,
  }))
  const cadences = sufficient ? computeObservedCadences(params.days, null, policyRows) : []
  const cadenceByCategory = new Map(cadences.map((cadence) => [cadence.category, cadence]))
  const nudges = computeNudges({
    cadences,
    targets: params.careBalanceRows,
    dismissed: params.activeDismissals,
  })

  return {
    mode: "tracking_insight_context",
    authority: TRACKING_INSIGHT_AUTHORITY,
    coverage: {
      window_days: 28,
      logged_day_count: gate.loggedDayCount,
      observed_week_count: observedWeekCount,
      sufficient,
      reason,
    },
    insights: nudges.flatMap((nudge) => {
      const cadence = cadenceByCategory.get(nudge.category)
      if (!cadence) return []
      return [
        {
          category: nudge.category,
          direction: nudge.direction === "increase" ? "below_target" : "above_target",
          observed_weekly: nudge.observedWeekly,
          target_min_weekly: nudge.targetMinWeekly,
          target_max_weekly: nudge.targetMaxWeekly,
          evidence_basis: cadence.basis,
        },
      ]
    }),
    notes:
      "Konservative, deterministische Gegenüberstellung von jüngsten Tagebuchdaten und aktuellen CareBalance-Zielbereichen. Eigene Aktivitäten zählen nicht mit; fehlende Tage bleiben unbekannt.",
  }
}
