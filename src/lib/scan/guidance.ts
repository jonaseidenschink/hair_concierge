/**
 * Pure scan-guidance logic: turns a rolling telemetry window fed by the scanner
 * component into a single hint pill string. No internal state — the caller (the
 * scanner component) owns `currentHint` / `msSinceLastHintChange` and re-invokes
 * this on every telemetry tick.
 */

export const SCAN_HINT_DEFAULT = "Suche Barcode …" as const
/**
 * The pill while a barcode is in frame but not yet stably read (viewfinder feedback B).
 * Not part of `ScanHint`: it is a detection state, not a telemetry-driven hint, and
 * `nextScanHint` must never be able to return it.
 */
export const SCAN_HINT_SPOTTED = "Barcode gefunden – kurz stillhalten" as const
/** Pill label during the decode-confirm moment (Variante A); ✓ is rendered by the pill. */
export const SCAN_CONFIRM_LABEL = "Gelesen – wird geprüft" as const
export const SCAN_HINT_MOVE_CLOSER = "Etwas näher ran" as const
export const SCAN_HINT_LESS_TILT = "Weniger kippen" as const
export const SCAN_HINT_MORE_LIGHT = "Mehr Licht hilft" as const

export type ScanHint =
  | typeof SCAN_HINT_DEFAULT
  | typeof SCAN_HINT_MOVE_CLOSER
  | typeof SCAN_HINT_LESS_TILT
  | typeof SCAN_HINT_MORE_LIGHT

/** Rolling telemetry window the scanner component maintains and feeds in on every tick. */
export type ScanTelemetry = {
  msSinceStart: number
  msSinceLastDetection: number
  /** Last detected barcode's bounding-box area as a fraction of the frame area, or null if none yet. */
  lastBoundingBoxRatio: number | null
  /** Mean luma (0-255) of a cheap downscaled frame sample, or null before the first sample. */
  meanLuma: number | null
  /** Raw (possibly-invalid or not-yet-stable) detections seen since the last stable read fired. */
  rawDetectionsWithoutStableRead: number
}

export type ScanHintState = {
  currentHint: ScanHint | null
  msSinceLastHintChange: number
}

/** Below this mean luma (0-255), lighting is treated as too poor for reliable detection. */
export const LOW_LIGHT_LUMA_THRESHOLD = 50
/** Below this box-area/frame-area ratio, the barcode is treated as too small/far away. */
export const SMALL_BOUNDING_BOX_RATIO_THRESHOLD = 0.04
/** At/above this many raw detections without a stable double-read, treat it as a tilt problem. */
export const TILT_RAW_DETECTION_THRESHOLD = 3
/** Minimum time a hint must stay on screen before it is allowed to change again. */
export const HINT_HYSTERESIS_MS = 1500

/**
 * Priority order (highest first): poor light blocks detection outright, so it's checked
 * before anything else; tilt (detections happening but never stabilizing) beats a small
 * box (a detection did land); the default applies when nothing else is a problem.
 */
function desiredHint(telemetry: ScanTelemetry): ScanHint {
  if (telemetry.meanLuma !== null && telemetry.meanLuma < LOW_LIGHT_LUMA_THRESHOLD) {
    return SCAN_HINT_MORE_LIGHT
  }
  if (telemetry.rawDetectionsWithoutStableRead >= TILT_RAW_DETECTION_THRESHOLD) {
    return SCAN_HINT_LESS_TILT
  }
  if (
    telemetry.lastBoundingBoxRatio !== null &&
    telemetry.lastBoundingBoxRatio < SMALL_BOUNDING_BOX_RATIO_THRESHOLD
  ) {
    return SCAN_HINT_MOVE_CLOSER
  }
  return SCAN_HINT_DEFAULT
}

/**
 * Returns the hint that should now be shown, or null if the current hint should hold
 * (either nothing changed, or a change is due but hysteresis hasn't elapsed yet).
 */
export function nextScanHint(telemetry: ScanTelemetry, state: ScanHintState): ScanHint | null {
  const desired = desiredHint(telemetry)

  if (state.currentHint === null) return desired
  if (desired === state.currentHint) return null
  if (state.msSinceLastHintChange < HINT_HYSTERESIS_MS) return null
  return desired
}
