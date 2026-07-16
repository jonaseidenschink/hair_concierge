import type { CareBalanceCadencePolicy } from "@/lib/recommendation-engine/types"

import { WASH_DAY_TYPES, type TrackerLogDay } from "./types"

export interface ObservedCadence {
  category: string
  weeklyCadence: number
  basis: "wash_rhythm" | "wash_share" | "day_level"
  anchorSource: "observed" | "self_reported" | null
  usageDays: number
  washEventsObserved: number | null
}

export interface CadencePolicyRow {
  category: string
  cadencePolicy: CareBalanceCadencePolicy
}

const DAY_MS = 24 * 60 * 60 * 1000

function isWashLike(day: TrackerLogDay): boolean {
  return day.confirmed !== false && (WASH_DAY_TYPES as readonly string[]).includes(day.dayType)
}

function isCadenceEligible(day: TrackerLogDay): boolean {
  return day.confirmed !== false && day.dayType !== "custom"
}

function mondayOf(dateIso: string): string {
  const date = new Date(`${dateIso}T00:00:00Z`)
  const weekday = (date.getUTCDay() + 6) % 7
  const monday = new Date(date.getTime() - weekday * DAY_MS)
  return monday.toISOString().slice(0, 10)
}

function distinctUsageDaysByCategory(days: TrackerLogDay[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const day of days) {
    if (!isCadenceEligible(day)) continue
    const seen = new Set(day.products.map((product) => product.category))
    for (const category of seen) {
      if (!map.has(category)) map.set(category, new Set())
      map.get(category)!.add(day.loggedOn)
    }
  }
  return map
}

function observedWeekKeys(days: TrackerLogDay[]): Set<string> {
  const daysPerWeek = new Map<string, number>()
  for (const day of days) {
    if (!isCadenceEligible(day)) continue
    const week = mondayOf(day.loggedOn)
    daysPerWeek.set(week, (daysPerWeek.get(week) ?? 0) + 1)
  }
  return new Set([...daysPerWeek.entries()].filter(([, count]) => count >= 4).map(([week]) => week))
}

export function countObservedWeeks(days: TrackerLogDay[]): number {
  return observedWeekKeys(days).size
}

export function estimateObservedWashCadencePerWeek(days: TrackerLogDay[]): number | null {
  const weeks = observedWeekKeys(days)
  if (weeks.size < 2) return null
  const washes = days.filter((day) => isWashLike(day) && weeks.has(mondayOf(day.loggedOn))).length
  return washes / weeks.size
}

export function computeObservedCadences(
  days: TrackerLogDay[],
  selfReportedWashCadencePerWeek: number | null,
  policyRows: readonly CadencePolicyRow[],
): ObservedCadence[] {
  const usageDays = distinctUsageDaysByCategory(days)
  const allWashEvents = days.filter(isWashLike).length
  const weeks = observedWeekKeys(days)
  const observedWeeks = weeks.size
  const observedWash = estimateObservedWashCadencePerWeek(days)
  const observedWashEvents = days.filter(
    (day) => isWashLike(day) && weeks.has(mondayOf(day.loggedOn)),
  ).length
  const anchor = observedWash ?? selfReportedWashCadencePerWeek
  const anchorSource: ObservedCadence["anchorSource"] =
    observedWash !== null
      ? "observed"
      : selfReportedWashCadencePerWeek !== null
        ? "self_reported"
        : null
  const policiesByCategory = new Map(
    policyRows.map((row) => [row.category, row.cadencePolicy] as const),
  )

  const results: ObservedCadence[] = []

  if (observedWash !== null && policiesByCategory.get("shampoo")?.kind === "baseline_cleansing") {
    results.push({
      category: "shampoo",
      weeklyCadence: observedWash,
      basis: "wash_rhythm",
      anchorSource: "observed",
      usageDays: usageDays.get("shampoo")?.size ?? 0,
      washEventsObserved: observedWashEvents,
    })
  }

  for (const [category, dates] of usageDays) {
    if (category === "shampoo") continue
    const cadencePolicy = policiesByCategory.get(category)
    if (!cadencePolicy || cadencePolicy.kind === "not_applicable") continue

    if (cadencePolicy.kind === "match_shampoo_frequency") {
      const usageDates =
        observedWash !== null ? [...dates].filter((date) => weeks.has(mondayOf(date))) : [...dates]
      const washEvents = observedWash !== null ? observedWashEvents : allWashEvents
      if (anchor === null || washEvents === 0 || usageDates.length === 0) continue
      results.push({
        category,
        weeklyCadence: (usageDates.length / washEvents) * anchor,
        basis: "wash_share",
        anchorSource,
        usageDays: usageDates.length,
        washEventsObserved: washEvents,
      })
      continue
    }

    if (cadencePolicy.kind === "baseline_cleansing") continue

    if (observedWeeks === 0) continue
    const usageInObservedWeeks = [...dates].filter((date) => weeks.has(mondayOf(date))).length
    if (usageInObservedWeeks === 0) continue
    results.push({
      category,
      weeklyCadence: usageInObservedWeeks / observedWeeks,
      basis: "day_level",
      anchorSource: null,
      usageDays: dates.size,
      washEventsObserved: null,
    })
  }

  return results
}

export function countWashesInWeek(days: TrackerLogDay[], weekDates: string[]): number {
  const weekDateSet = new Set(weekDates)
  return days.filter((day) => weekDateSet.has(day.loggedOn) && isWashLike(day)).length
}

export function daysSinceLastWash(days: TrackerLogDay[], today: string): number | null {
  const washDates = days
    .filter(isWashLike)
    .map((day) => day.loggedOn)
    .sort()
  if (washDates.length === 0) return null
  const last = washDates[washDates.length - 1]
  const diff = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / DAY_MS,
  )
  return Math.max(0, diff)
}
