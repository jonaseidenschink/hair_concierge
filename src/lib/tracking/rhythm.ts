import type { ProductFrequency } from "@/lib/vocabulary/frequencies"
import { PRODUCT_FREQUENCY_METADATA } from "@/lib/vocabulary/frequencies"

import type { TrackerLogDay } from "./types"
import { WASH_DAY_TYPES } from "./types"

const DAY_MS = 24 * 60 * 60 * 1000
const ISO_EPOCH_MONDAY = "1970-01-05"

export interface RhythmTarget {
  minFrequency: ProductFrequency
  maxFrequency: ProductFrequency
  preferredFrequency: ProductFrequency
}

export type RhythmStatus = "below" | "in_range" | "above"

export interface RhythmSummary {
  kind: "no_target" | "less_than_monthly" | "progress"
  targetLabel: string | null
  periodStart: string | null
  periodEnd: string | null
  periodWeeks: number | null
  washes: number
  minWashes: number | null
  maxWashes: number | null
  preferredWashes: number | null
  progress: number | null
  status: RhythmStatus | null
  encouragement: string
  completedWeeklyStreak: number | null
}

function mondayOf(dateIso: string): string {
  const date = new Date(`${dateIso}T00:00:00Z`)
  const weekday = (date.getUTCDay() + 6) % 7
  return new Date(date.getTime() - weekday * DAY_MS).toISOString().slice(0, 10)
}

function addDays(dateIso: string, days: number): string {
  return new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

function periodFor(today: string, periodWeeks: number): { start: string; end: string } {
  const currentMonday = mondayOf(today)
  const weeksSinceEpoch = Math.floor(
    (Date.parse(`${currentMonday}T00:00:00Z`) - Date.parse(`${ISO_EPOCH_MONDAY}T00:00:00Z`)) /
      (7 * DAY_MS),
  )
  const start = addDays(currentMonday, -(weeksSinceEpoch % periodWeeks) * 7)
  return { start, end: addDays(start, periodWeeks * 7 - 1) }
}

function isConfirmedWash(day: TrackerLogDay): boolean {
  return (
    day.confirmed !== false &&
    day.dayType !== "custom" &&
    (WASH_DAY_TYPES as readonly string[]).includes(day.dayType)
  )
}

function countWashes(days: readonly TrackerLogDay[], start: string, end: string): number {
  return days.filter((day) => isConfirmedWash(day) && day.loggedOn >= start && day.loggedOn <= end)
    .length
}

function weeklyStreak(
  days: readonly TrackerLogDay[],
  today: string,
  min: number,
  max: number,
): number | null {
  const currentMonday = mondayOf(today)
  let cursor = addDays(currentMonday, -7)
  let streak = 0
  while (true) {
    const washes = countWashes(days, cursor, addDays(cursor, 6))
    if (washes < min || washes > max) break
    streak += 1
    cursor = addDays(cursor, -7)
  }
  return streak >= 2 ? streak : null
}

export function buildRhythmSummary(
  days: readonly TrackerLogDay[],
  target: RhythmTarget | null,
  today: string,
): RhythmSummary {
  if (!target) {
    return {
      kind: "no_target",
      targetLabel: null,
      periodStart: null,
      periodEnd: null,
      periodWeeks: null,
      washes: 0,
      minWashes: null,
      maxWashes: null,
      preferredWashes: null,
      progress: null,
      status: null,
      encouragement: "Mit weiteren Einträgen wird dein Waschrhythmus hier sichtbar.",
      completedWeeklyStreak: null,
    }
  }

  const min = PRODUCT_FREQUENCY_METADATA[target.minFrequency]
  const max = PRODUCT_FREQUENCY_METADATA[target.maxFrequency]
  const preferred = PRODUCT_FREQUENCY_METADATA[target.preferredFrequency]
  if (target.minFrequency === "less_than_monthly") {
    return {
      kind: "less_than_monthly",
      targetLabel: preferred.label,
      periodStart: null,
      periodEnd: null,
      periodWeeks: null,
      washes: 0,
      minWashes: null,
      maxWashes: null,
      preferredWashes: null,
      progress: null,
      status: null,
      encouragement: "Dein empfohlener Rhythmus ist seltener als monatlich.",
      completedWeeklyStreak: null,
    }
  }

  const periodWeeks = min.minPerWeek >= 1 ? 1 : min.minPerWeek >= 0.5 ? 2 : 4
  const period = periodFor(today, periodWeeks)
  const washes = countWashes(days, period.start, period.end)
  const minWashes = Math.ceil(min.minPerWeek * periodWeeks)
  const maxWashes = Math.ceil(max.maxPerWeek * periodWeeks)
  const preferredWashes = preferred.midpointPerWeek * periodWeeks
  const status: RhythmStatus =
    washes < minWashes ? "below" : washes > maxWashes ? "above" : "in_range"
  const remaining = Math.max(0, minWashes - washes)
  const encouragement =
    status === "below"
      ? remaining === 1
        ? "Noch eine Wäsche bis zu deinem empfohlenen Rhythmus."
        : `Noch ${remaining} Wäschen bis zu deinem empfohlenen Rhythmus.`
      : status === "in_range"
        ? "Du liegst in deinem empfohlenen Rhythmus."
        : periodWeeks === 1
          ? "Du hast diese Woche häufiger gewaschen als empfohlen."
          : "Du hast in diesem Zeitraum häufiger gewaschen als empfohlen."

  return {
    kind: "progress",
    targetLabel: preferred.label,
    periodStart: period.start,
    periodEnd: period.end,
    periodWeeks,
    washes,
    minWashes,
    maxWashes,
    preferredWashes,
    progress: Math.min(1, washes / preferredWashes),
    status,
    encouragement,
    completedWeeklyStreak:
      periodWeeks === 1 ? weeklyStreak(days, today, minWashes, maxWashes) : null,
  }
}
