import { createAdminClient } from "@/lib/supabase/admin"

import type { TrackerDayType, TrackerLogDay } from "./types"

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_WINDOW_DAYS = 28

export type TrackerAgentLoadStatus = "available" | "empty" | "unavailable"

export interface TrackerAgentDismissal {
  category: string
  direction: string
}

export interface TrackerAgentLoadResult {
  status: TrackerAgentLoadStatus
  days: TrackerLogDay[]
  activeDismissals: TrackerAgentDismissal[]
  referenceDate: string
  reason: "loaded" | "no_entries" | "missing_user" | "query_failed" | "unexpected_error"
}

interface TrackerAgentLoaderClient {
  // Supabase's generated fluent query type is intentionally narrowed so the
  // loader can be exercised without a live database.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any
}

export interface TrackerAgentLoaderDeps {
  createClient?: () => TrackerAgentLoaderClient
  now?: () => Date
}

interface TrackerAgentLogRow {
  logged_on: string
  timezone: string
  day_type: TrackerDayType
  custom_activity_name: string | null
  routine_log_products: Array<{
    category: string
    product_name: string | null
    user_product_usage_id: string | null
  }> | null
}

interface TrackerAgentDismissalRow {
  category: string
  direction: string
  reappear_at: string
}

function shiftDate(dateIso: string, days: number): string {
  return new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

function dateInTimezone(date: Date, timezone: string | null | undefined): string {
  if (!timezone) return date.toISOString().slice(0, 10)

  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date)
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((candidate) => candidate.type === type)?.value
    const year = part("year")
    const month = part("month")
    const day = part("day")

    return year && month && day ? `${year}-${month}-${day}` : date.toISOString().slice(0, 10)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

export async function loadTrackerDaysForAgent(
  userId: string | null | undefined,
  windowDays = DEFAULT_WINDOW_DAYS,
  deps: TrackerAgentLoaderDeps = {},
): Promise<TrackerAgentLoadResult> {
  const now = deps.now?.() ?? new Date()
  const utcToday = now.toISOString().slice(0, 10)
  if (!userId) {
    return {
      status: "unavailable",
      days: [],
      activeDismissals: [],
      referenceDate: utcToday,
      reason: "missing_user",
    }
  }

  try {
    const client = (deps.createClient ?? createAdminClient)()
    // Stored dates are local calendar dates. Query one extra UTC day on both
    // boundaries, then apply the requested window after choosing the newest
    // stored timezone as the reference clock.
    const safeSince = shiftDate(utcToday, -windowDays)
    const safeUntil = shiftDate(utcToday, 1)
    const [logsResult, dismissalsResult] = await Promise.all([
      client
        .from("routine_logs")
        .select(
          "id, logged_on, timezone, day_type, custom_activity_name, routine_log_products ( category, product_name, user_product_usage_id )",
        )
        .eq("user_id", userId)
        .is("deleted_at", null)
        .gte("logged_on", safeSince)
        .lte("logged_on", safeUntil)
        .order("logged_on", { ascending: true }),
      client
        .from("tracker_nudge_dismissals")
        .select("category, direction, reappear_at")
        .eq("user_id", userId),
    ])

    if (logsResult.error || !logsResult.data || dismissalsResult.error) {
      return {
        status: "unavailable",
        days: [],
        activeDismissals: [],
        referenceDate: utcToday,
        reason: "query_failed",
      }
    }

    const logs = logsResult.data as TrackerAgentLogRow[]
    const newestLog = [...logs].sort((left, right) =>
      right.logged_on.localeCompare(left.logged_on),
    )[0]
    const referenceDate = dateInTimezone(now, newestLog?.timezone)
    const since = shiftDate(referenceDate, -(windowDays - 1))
    const days = logs
      .filter((log) => log.logged_on >= since && log.logged_on <= referenceDate)
      .map((log) => ({
        loggedOn: log.logged_on as string,
        dayType: log.day_type as TrackerDayType,
        customActivityName: log.custom_activity_name as string | null,
        products: (log.routine_log_products ?? []).map(
          (product: {
            category: string
            product_name: string | null
            user_product_usage_id: string | null
          }) => ({
            category: product.category,
            productName: product.product_name,
            userProductUsageId: product.user_product_usage_id,
          }),
        ),
      }))
    const nowIso = now.toISOString()
    const activeDismissals = ((dismissalsResult.data ?? []) as TrackerAgentDismissalRow[])
      .filter((row) => (row.reappear_at as string) > nowIso)
      .map((row) => ({
        category: row.category as string,
        direction: row.direction as string,
      }))

    return {
      status: days.length > 0 ? "available" : "empty",
      days,
      activeDismissals,
      referenceDate,
      reason: days.length > 0 ? "loaded" : "no_entries",
    }
  } catch {
    return {
      status: "unavailable",
      days: [],
      activeDismissals: [],
      referenceDate: utcToday,
      reason: "unexpected_error",
    }
  }
}
