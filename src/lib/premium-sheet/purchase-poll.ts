/**
 * The verification poll schedule (freemium-scanner-first, Codex fix wave Y3).
 *
 * A `pending` payment and a retryable `provisioning` failure both finish somewhere else —
 * in the webhook lane, minutes later. Before this, the sheet asked the server exactly once
 * and then sat there: a buyer whose asynchronous payment settled while the sheet was still
 * mounted stayed gated until they reloaded the page.
 *
 * Bounded on purpose. The schedule backs off to roughly a minute of waiting and then STOPS,
 * leaving the manual „Status prüfen" button as the only way on. An unbounded poll against a
 * rate-limited money endpoint (20/min per user) would spend the buyer's own budget and turn
 * a slow settlement into a 429.
 */

/** Delay before poll N, in milliseconds. Five polls, ~59s of waiting in total. */
export const PREMIUM_SHEET_POLL_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 15_000, 30_000]

/**
 * The delay before the poll with this zero-based index, or `null` once the schedule is
 * exhausted — at which point the sheet stops polling and offers the manual recheck.
 */
export function premiumSheetPollDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0) return null
  return PREMIUM_SHEET_POLL_DELAYS_MS[attempt] ?? null
}
