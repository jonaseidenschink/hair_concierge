import type { ScanProactiveTriggerId } from "./trigger-rules"
import { SCAN_PROACTIVE_TRIGGER_IDS } from "./trigger-rules"

/**
 * Client-side storage for the trigger layer's two session concepts (T10, PR2; reworked in
 * fix round 1 — see F1/F4/F5 in `.superpowers/sdd/plan/task-10-review.md`). No new DB table
 * (per the brief) — both are approximations, injectable the same way as
 * `category-capture-queue.ts` so production and tests share one contract:
 *
 * 1. **The session RECORD** (`recordScanSession`) — a permanent, cross-visit count backed
 *    by `localStorage`, used ONLY to answer "is this exactly the user's second session"
 *    for the Wiederkehrer trigger (F4). A visit more than 30 minutes after the previous one
 *    counts as a new session; anything sooner (an ordinary remount, a quick tab-away-and-
 *    back) is the same session continuing.
 * 2. **The fatigue BUDGET** (`readScanFatigueBudget`/`writeScanFatigueBudget`) — which
 *    proactive trigger (if any) has already fired THIS browsing session, backed by
 *    `sessionStorage` (F1): survives an ordinary remount (App Router navigating away from
 *    and back to `/scan` does not create a new tab), but resets on a new tab or a browser
 *    restart, unlike the permanent record above.
 *
 * Both storages are read/written ONLY for a confirmed free-tier session (`scan-flow.tsx`
 * gates every access on the server-verified `tier` prop) — F5: premium and flag-off users
 * must cause zero storage activity, not merely zero rendered surfaces.
 */

export type ScanTriggerStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Safe adapter for `window.localStorage`; SSR or a throwing accessor yields `null`. */
export function createBrowserScanLocalStorage(): ScanTriggerStorage | null {
  try {
    const candidate = typeof globalThis === "undefined" ? undefined : globalThis.localStorage
    return candidate ?? null
  } catch {
    return null
  }
}

/** Safe adapter for `window.sessionStorage`; SSR or a throwing accessor yields `null`. */
export function createBrowserScanSessionStorage(): ScanTriggerStorage | null {
  try {
    const candidate = typeof globalThis === "undefined" ? undefined : globalThis.sessionStorage
    return candidate ?? null
  } catch {
    return null
  }
}

/** Test-only convenience; production callers inject the two browser adapters above. */
export function createMemoryScanTriggerStorage(): ScanTriggerStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

// --- 1. the session record (localStorage, permanent) ------------------------------

export const SCAN_SESSION_RECORD_KEY = "chaarlie:scan:session-record:v1"

/** A gap longer than this after the last visit starts a new session (F1/F4 ruling). */
const NEW_SESSION_GAP_MS = 30 * 60 * 1000

type ScanSessionRecord = { count: number; lastSeenAt: number }

function parseScanSessionRecord(raw: string | null): ScanSessionRecord | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ScanSessionRecord> | null
    if (!parsed || typeof parsed.count !== "number" || typeof parsed.lastSeenAt !== "number") {
      return null
    }
    return { count: parsed.count, lastSeenAt: parsed.lastSeenAt }
  } catch {
    return null
  }
}

/**
 * Records that a `/scan` visit happened just now and returns the resulting SESSION NUMBER
 * (1 = first visit ever seen on this device). A visit more than `NEW_SESSION_GAP_MS` after
 * the previous one increments the count — anything sooner (a remount, a quick tab switch)
 * keeps today's session number, so ordinary navigation can never inflate the count. `null`
 * storage (SSR) or a storage that throws (private mode) always answers `1`: never crash,
 * never claim a returning session when the device cannot prove one.
 */
export function recordScanSession(
  storage: ScanTriggerStorage | null,
  now: number = Date.now(),
): number {
  if (!storage) return 1
  try {
    const previous = parseScanSessionRecord(storage.getItem(SCAN_SESSION_RECORD_KEY))
    const isNewSession = previous === null || now - previous.lastSeenAt > NEW_SESSION_GAP_MS
    const count = previous === null ? 1 : isNewSession ? previous.count + 1 : previous.count
    storage.setItem(SCAN_SESSION_RECORD_KEY, JSON.stringify({ count, lastSeenAt: now }))
    return count
  } catch {
    return 1
  }
}

// --- 2. the fatigue budget (sessionStorage, per browsing session) -----------------

export const SCAN_FATIGUE_BUDGET_KEY = "chaarlie:scan:fatigue-budget:v1"

function isScanProactiveTriggerId(value: string | null): value is ScanProactiveTriggerId {
  return value !== null && (SCAN_PROACTIVE_TRIGGER_IDS as readonly string[]).includes(value)
}

/**
 * The proactive trigger already shown this browsing session, or `null` if none has fired
 * (or the read failed) — read once, on mount, to re-seed the reducer's in-memory fatigue
 * flag so a remount cannot forget it (F1).
 */
export function readScanFatigueBudget(
  storage: ScanTriggerStorage | null,
): ScanProactiveTriggerId | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(SCAN_FATIGUE_BUDGET_KEY)
    return isScanProactiveTriggerId(raw) ? raw : null
  } catch {
    return null
  }
}

/**
 * Persists the session's one spent pitch. Best-effort: a storage that throws still leaves
 * the reducer's own in-memory flag correct for the rest of THIS mount, it just cannot
 * survive a future remount.
 */
export function writeScanFatigueBudget(
  storage: ScanTriggerStorage | null,
  id: ScanProactiveTriggerId,
): void {
  if (!storage) return
  try {
    storage.setItem(SCAN_FATIGUE_BUDGET_KEY, id)
  } catch {
    // Best-effort persistence only — see doc comment above.
  }
}
