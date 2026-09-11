import type { ScanMaskedVerdictResult } from "./masked-alternative"
import type {
  ScanPendingSubmissionResult,
  ScanResolvedVerdictResult,
  ScanUnknownProductResult,
} from "./types"

/**
 * Client-side reading of what `/api/scan/resolve` just answered (T9, plan §PR2).
 *
 * The whole free-tier verdict UI is gated on the RESPONSE SHAPE, never on a client-side
 * entitlement guess: T8 emits `ScanMaskedVerdictResult` — and with it the
 * `freeRevealAvailable` field — exactly when the flag is on, the verdict is `in_catalog`
 * and the caller cannot see alternatives. A premium caller, and every caller with the
 * flag off, gets today's `ScanResolvedVerdictResult` with no such field, so every
 * predicate here answers `false`/`"premium"` for them and the UI renders unchanged.
 */

/** Either tier's verdict result. Only the `alternatives` list differs between them. */
export type ScanVerdictResult = ScanResolvedVerdictResult | ScanMaskedVerdictResult

/** Every shape the resolve endpoint can hand the client, both tiers included. */
export type ScanClientResolveResult =
  | ScanVerdictResult
  | ScanPendingSubmissionResult
  | ScanUnknownProductResult

export function isMaskedScanVerdict(result: ScanVerdictResult): result is ScanMaskedVerdictResult {
  return result.kind === "in_catalog" && "freeRevealAvailable" in result
}

/**
 * What this response proves about the caller's tier. `"unknown"` is the honest answer for
 * every branch that carries no masking marker either way: `not_needed` reaches no
 * alternatives, so it is served identically to both tiers, and an unknown/pending product
 * never reaches a verdict at all. Only an `in_catalog` verdict is evidence.
 */
export type ScanTierSignal = "unknown" | "free" | "premium"

export function scanTierSignal(result: ScanClientResolveResult): ScanTierSignal {
  if (result.kind !== "in_catalog") return "unknown"
  return isMaskedScanVerdict(result) ? "free" : "premium"
}

/**
 * Once a response has proven the caller is free, a later `not_needed` (or an unknown
 * product) must not wash that back out — the surfaces that stay locked between scans, the
 * Merken bookmark above all, would flicker unlocked on the next scan of a category the
 * profile does not need.
 */
export function nextScanTierSignal(current: ScanTierSignal, next: ScanTierSignal): ScanTierSignal {
  return next === "unknown" ? current : next
}

/** Which of the two free-tier alternative CTAs a masked verdict offers. */
export type ScanRevealCta = "reveal" | "premium"

export function scanRevealCta(input: {
  freeRevealAvailable: boolean
  /** The reveal endpoint has since reported the credit as spent (409 `already_used`). */
  revealUnavailable: boolean
}): ScanRevealCta {
  return input.freeRevealAvailable && !input.revealUnavailable ? "reveal" : "premium"
}
