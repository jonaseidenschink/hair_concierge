export interface TrustGateStatus {
  unlocked: boolean
  firstLogDate: string | null
  daysSinceFirstLog: number
  loggedDayCount: number
  daysRemaining: number
}

export const TRUST_GATE_WINDOW_DAYS = 14
export const TRUST_GATE_MIN_LOGGED_DAYS = 10

const DAY_MS = 24 * 60 * 60 * 1000

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`)
  const to = Date.parse(`${toIso}T00:00:00Z`)
  return Math.round((to - from) / DAY_MS)
}

export function evaluateTrustGate(logDates: string[], today: string): TrustGateStatus {
  const uniqueDates = [...new Set(logDates)].sort()
  if (uniqueDates.length === 0) {
    return {
      unlocked: false,
      firstLogDate: null,
      daysSinceFirstLog: 0,
      loggedDayCount: 0,
      daysRemaining: TRUST_GATE_WINDOW_DAYS,
    }
  }

  const firstLogDate = uniqueDates[0]
  const daysSinceFirstLog = Math.max(0, daysBetween(firstLogDate, today))
  const loggedDayCount = uniqueDates.length
  const unlocked =
    daysSinceFirstLog >= TRUST_GATE_WINDOW_DAYS && loggedDayCount >= TRUST_GATE_MIN_LOGGED_DAYS

  return {
    unlocked,
    firstLogDate,
    daysSinceFirstLog,
    loggedDayCount,
    daysRemaining: Math.max(0, TRUST_GATE_WINDOW_DAYS - daysSinceFirstLog),
  }
}
