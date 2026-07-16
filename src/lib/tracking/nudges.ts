import type { CareBalanceFrequencyTarget } from "@/lib/recommendation-engine/types"
import { PRODUCT_FREQUENCY_METADATA } from "@/lib/vocabulary/frequencies"

import type { ObservedCadence } from "./aggregation"
import { TRACKER_CATEGORY_LABELS_DE } from "./types"

export const NUDGE_BAND_MARGIN_PER_WEEK = 0.5

export interface TrackerNudge {
  category: string
  direction: "increase" | "decrease"
  observedWeekly: number
  targetMinWeekly: number
  targetMaxWeekly: number
  message: string
}

export interface NudgeTargetRow {
  category: string
  frequencyTarget: CareBalanceFrequencyTarget | null
}

function formatPerWeek(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${String(rounded).replace(".", ",")}x pro Woche`
}

function bandLabel(min: number, max: number): string {
  if (min === max) return formatPerWeek(min)
  return `${String(Math.round(min * 10) / 10).replace(".", ",")}–${String(
    Math.round(max * 10) / 10,
  ).replace(".", ",")}x pro Woche`
}

export function computeNudges(input: {
  cadences: ObservedCadence[]
  targets: NudgeTargetRow[]
  dismissed: Array<{ category: string; direction: string }>
}): TrackerNudge[] {
  const targetsByCategory = new Map(
    input.targets
      .filter((target) => target.frequencyTarget !== null)
      .map((target) => [target.category, target.frequencyTarget!]),
  )
  const dismissedKeys = new Set(
    input.dismissed.map((dismissal) => `${dismissal.category}:${dismissal.direction}`),
  )

  const nudges: TrackerNudge[] = []
  for (const cadence of input.cadences) {
    const target = targetsByCategory.get(cadence.category)
    if (!target) continue

    const min = PRODUCT_FREQUENCY_METADATA[target.minFrequency].minPerWeek
    const max = PRODUCT_FREQUENCY_METADATA[target.maxFrequency].maxPerWeek
    const label = TRACKER_CATEGORY_LABELS_DE[cadence.category] ?? cadence.category

    let direction: TrackerNudge["direction"] | null = null
    if (cadence.weeklyCadence <= min - NUDGE_BAND_MARGIN_PER_WEEK) {
      direction = "increase"
    } else if (cadence.weeklyCadence >= max + NUDGE_BAND_MARGIN_PER_WEEK) {
      direction = "decrease"
    }
    if (!direction) continue
    if (dismissedKeys.has(`${cadence.category}:${direction}`)) continue

    const observedLabel = formatPerWeek(cadence.weeklyCadence)
    const bandText = bandLabel(min, max)
    const subject =
      cadence.basis === "wash_rhythm"
        ? `Du wäschst deine Haare aktuell ~${observedLabel}`
        : `Du nutzt ${label} aktuell ~${observedLabel}`
    const message =
      direction === "increase"
        ? `${subject} — empfohlen sind ${bandText}.`
        : `${subject} — empfohlen sind nur ${bandText}.`

    nudges.push({
      category: cadence.category,
      direction,
      observedWeekly: cadence.weeklyCadence,
      targetMinWeekly: min,
      targetMaxWeekly: max,
      message,
    })
  }
  return nudges
}
