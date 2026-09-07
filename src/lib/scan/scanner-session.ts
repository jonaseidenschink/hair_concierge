import {
  SCAN_CONFIRM_LABEL,
  SCAN_HINT_DEFAULT,
  SCAN_HINT_SPOTTED,
  type ScanHint,
} from "@/lib/scan/guidance"

/**
 * All mutable, per-scan-session state the scan loop tracks between camera start and
 * stop: detection debounce/dedupe counters, telemetry inputs for `nextScanHint`, and
 * the timeout/decode guards. Why the loop is or is not running is NOT in here — that
 * belongs to the loop controller in `./scanner-loop`.
 *
 * Bundled into one object (held in a single ref) so a fresh scan session — the camera
 * reopened after being closed, or restarted after a background/visibility cycle —
 * always starts from a clean, fully-reset state in one place. `createScanSessionState()`
 * must be called once at the start of every session (never partially reset individual
 * fields), otherwise state from a prior session (e.g. a `lastFiredValue` that would
 * silently suppress re-firing `onDecoded` for the same barcode) leaks forward.
 */
export type ScanSessionState = {
  /** True while a `detector.detect()` call is in flight, to prevent overlapping calls. */
  detecting: boolean
  frameCounter: number
  detectionAttempts: number
  lastRawValue: string | null
  consecutiveMatch: number
  /** Last EAN successfully fired via `onDecoded`, so a still-in-frame code doesn't refire. */
  lastFiredValue: string | null
  hasDecoded: boolean
  timeoutFired: boolean
  startTime: number
  lastDetectionTime: number
  lastBoundingBoxRatio: number | null
  meanLuma: number | null
  lastLumaSampleTime: number
  rawDetectionsWithoutStableRead: number
  /**
   * D6 re-arm: the value that already fired in a previous attempt of this session and
   * must physically leave the frame before it may fire again. Set by
   * `restartScanSessionState` from the attempt that just ended, cleared by
   * `noteEmptyDetection` after `REARM_EMPTY_DETECTIONS` barcode-free detection attempts.
   *
   * Separate from `lastFiredValue` on purpose: `lastFiredValue` guards *within* one
   * attempt and is wiped on restart (otherwise nothing could ever be scanned twice),
   * while this guard survives the restart and is what stops a closed sheet from
   * re-opening ~0.5s later on a bottle the user never moved (finding F1).
   */
  blockedValue: string | null
  /** Consecutive detection attempts that saw zero barcodes since the last raw hit. */
  emptyDetections: number
  /**
   * Milliseconds the detection loop actually ran, i.e. excluding every stretch it was
   * paused for a sheet or a hidden tab. The 3s search fallback measures THIS, not wall
   * time since `startTime` — otherwise browsing the Merkliste for 30s pops the search
   * sheet on the first resumed tick (finding F2).
   */
  activeMs: number
  hint: ScanHint | null
  hintChangedAt: number
}

/** Consecutive identical raw reads required before a value is validated and fired. */
export const STABLE_READ_REQUIRED_MATCHES = 2

/**
 * Detection attempts with no barcode at all before `blockedValue` is released (D6).
 * Small on purpose: detection runs on ~every 3rd frame, so three empty attempts is a
 * fraction of a second of an empty viewfinder — long enough that a momentary decode
 * miss on a still-held bottle does not count as "the barcode left the frame".
 */
export const REARM_EMPTY_DETECTIONS = 3

/** Active-scanning budget before the one-shot search fallback fires. */
export const SCAN_TIMEOUT_MS = 3000

/**
 * Restart the scan attempt inside a session whose camera is still running — the flow
 * returns to scanning after a result/pending sheet is closed or a resolve error bounces
 * back. Every guard that would otherwise suppress a second read of the same product
 * (`lastFiredValue`, `hasDecoded`), the search fallback's one-shot `timeoutFired`, and
 * the hint/telemetry window all start over.
 *
 * Mutates in place on purpose: the detection loop closed over this exact object when the
 * camera started, so assigning a replacement object to the ref would never reach it.
 *
 * Deliberately NOT reset: `detecting` is loop lifecycle state rather than scan-attempt
 * state — clearing it could let a second `detect()` start while one is still in flight.
 */
export function restartScanSessionState(session: ScanSessionState, now: number): void {
  const { detecting } = session
  // D6: whatever fired in the attempt that just ended is presumed to still be in frame
  // (the sheet slid up over a live camera), so it becomes the blocked value instead of
  // being forgotten. An attempt that fired nothing keeps whatever block it inherited —
  // three empty detections, not a restart, are what release it.
  const blockedValue = session.lastFiredValue ?? session.blockedValue
  Object.assign(session, createScanSessionState(), {
    detecting,
    blockedValue,
    startTime: now,
    lastDetectionTime: now,
    hintChangedAt: now,
  })
}

export function createScanSessionState(): ScanSessionState {
  return {
    detecting: false,
    frameCounter: 0,
    detectionAttempts: 0,
    lastRawValue: null,
    consecutiveMatch: 0,
    lastFiredValue: null,
    hasDecoded: false,
    timeoutFired: false,
    startTime: 0,
    lastDetectionTime: 0,
    lastBoundingBoxRatio: null,
    meanLuma: null,
    lastLumaSampleTime: 0,
    rawDetectionsWithoutStableRead: 0,
    blockedValue: null,
    emptyDetections: 0,
    activeMs: 0,
    hint: null,
    hintChangedAt: 0,
  }
}

/**
 * One raw detection result folded into the session: the stable-read debounce, the
 * dedupe guards and the hint telemetry that used to live inline in `Scanner`'s
 * `handleRawDetections`, plus the D6 block check.
 *
 * `validate` is injected (rather than importing `validateEanInput`) so this module stays
 * a pure state machine with no identifier policy of its own, and so tests can drive the
 * valid/invalid branches without constructing real checksums.
 *
 * Mutates `session` in place, like `restartScanSessionState`: the detection loop closed
 * over this exact object. Returns the value the caller must hand to `onDecoded`, or
 * `null` when this read fires nothing.
 */
export function applyRawDetection(
  session: ScanSessionState,
  input: { rawValue: string; boundingBoxRatio: number | null; now: number },
  validate: (raw: string) => { ok: true; value: string } | { ok: false },
): { fire: string | null } {
  session.lastDetectionTime = input.now
  session.lastBoundingBoxRatio = input.boundingBoxRatio
  // A barcode is in frame, so the "it left the frame" streak restarts from zero.
  session.emptyDetections = 0

  if (input.rawValue === session.lastRawValue) {
    session.consecutiveMatch += 1
  } else {
    session.lastRawValue = input.rawValue
    session.consecutiveMatch = 1
  }

  session.rawDetectionsWithoutStableRead += 1

  if (session.consecutiveMatch < STABLE_READ_REQUIRED_MATCHES) return { fire: null }

  const validated = validate(input.rawValue)
  let fire: string | null = null
  if (validated.ok && session.blockedValue === validated.value) {
    // Controller ruling C1: a blocked read is a *clean* read we are deliberately
    // ignoring, not a failure to read. So it resets the two counters that measure
    // "we cannot read anything here" — the hint telemetry behind "Weniger kippen"
    // and the active clock behind the 3s search fallback — while deliberately NOT
    // setting `hasDecoded`: this attempt has still produced nothing, so the fallback
    // stays armed for the moment the user actually points at something else.
    session.activeMs = 0
    session.rawDetectionsWithoutStableRead = 0
  } else if (validated.ok && session.lastFiredValue !== validated.value) {
    session.lastFiredValue = validated.value
    session.hasDecoded = true
    session.rawDetectionsWithoutStableRead = 0
    session.lastRawValue = null
    fire = validated.value
  }
  // Reset the streak either way: an invalid-checksum read, a still-in-frame duplicate and
  // a blocked value all have to re-earn two fresh consecutive matches before we look
  // again (cheap, and it avoids revalidating a stationary bad read every single frame).
  session.consecutiveMatch = 0
  return { fire }
}

/**
 * Which barcode of one frame to fold into the session. A frame can carry more than one —
 * the bottle that was just scanned is still lying next to the one the user picked up —
 * and always reading `results[0]` meant the new code was never even looked at while the
 * old one held the D6 block.
 *
 * So: the first result that validates to something other than the blocked value, and
 * `results[0]` when there is none. The fallback is deliberate — a blocked read is a
 * *clean* read (ruling C1) that keeps resetting the active clock, which is what stops the
 * search fallback from popping over a bottle we are simply ignoring on purpose.
 *
 * `validate` is injected for the same reason as in `applyRawDetection`: no identifier
 * policy lives in this module.
 */
export function selectDetectionCandidate<T extends { rawValue: string }>(
  results: readonly T[],
  session: Pick<ScanSessionState, "blockedValue">,
  validate: (raw: string) => { ok: true; value: string } | { ok: false },
): T | null {
  if (results.length === 0) return null
  if (session.blockedValue === null) return results[0]
  const unblocked = results.find((result) => {
    const validated = validate(result.rawValue)
    return validated.ok && validated.value !== session.blockedValue
  })
  return unblocked ?? results[0]
}

/**
 * Give back a decode the flow refused (controller ruling C3): `onDecoded` answers whether
 * it actually started a resolve, and a `false` means the value was never consumed — a
 * decode that lands while a sheet still covers the viewfinder must be able to fire again
 * the moment the sheet closes, without the user having to move the bottle out of frame.
 *
 * Only the two guards `applyRawDetection` set for THIS value are reverted. The consumed
 * streak (`consecutiveMatch` / `lastRawValue`) stays consumed on purpose: the value
 * re-earns two fresh consecutive reads, which is one detection cycle, not a re-scan. The
 * D6 `blockedValue` is untouched — it belongs to a previous attempt, not to this fire.
 */
export function unfireDetection(session: ScanSessionState, value: string): void {
  if (session.lastFiredValue !== value) return
  session.lastFiredValue = null
  session.hasDecoded = false
}

/**
 * One detection attempt that found no barcode at all. Once `REARM_EMPTY_DETECTIONS` of
 * them have run back to back, the frame is considered empty and the D6 block is released
 * — including `lastFiredValue`, so the same product can be scanned again the moment the
 * user brings it back.
 */
export function noteEmptyDetection(session: ScanSessionState): void {
  session.emptyDetections += 1
  if (session.emptyDetections < REARM_EMPTY_DETECTIONS) return
  session.blockedValue = null
  session.lastFiredValue = null
}

/**
 * Add the elapsed time of one loop tick to the active clock. The caller only calls this
 * while the loop is actually running, which is exactly what makes the fallback measure
 * scanning time instead of wall time (F2). Non-positive and non-finite deltas are ignored
 * so a clock glitch can never rewind the budget.
 */
export function advanceActiveClock(session: ScanSessionState, deltaMs: number): void {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return
  session.activeMs += deltaMs
}

/**
 * Whether the one-shot search fallback should fire on this tick. Consumes the one-shot
 * (`timeoutFired`) when it returns `true`, so the caller can dispatch unconditionally.
 * A session that already decoded never fires it and never burns the one-shot.
 */
export function shouldFireTimeout(
  session: ScanSessionState,
  timeoutMs: number = SCAN_TIMEOUT_MS,
): boolean {
  if (session.timeoutFired || session.hasDecoded) return false
  if (session.activeMs < timeoutMs) return false
  session.timeoutFired = true
  return true
}

/* --------------------------------------------------------------------------
 * Viewfinder detection state (plan 2026-09-05, Task 1)
 *
 * A reporting seam, not a lifecycle: the detection loop already knows whether a barcode
 * is in frame and where, and these helpers turn that into the three states the
 * viewfinder draws — searching, spotted (amber outline), read (green outline). Pure on
 * purpose, so the transitions and the on-screen geometry are testable without a camera.
 * ------------------------------------------------------------------------ */

/** A box in 0..1 fractions of the video's *intrinsic* size (not the element's). */
export type NormalizedBox = { x: number; y: number; width: number; height: number }

export type ScanDetectionState =
  | { kind: "searching" }
  | { kind: "spotted"; box: NormalizedBox }
  | { kind: "read"; box: NormalizedBox }

/** What the detection loop just observed. `emptyStreak` decides what `empty` means. */
export type ScanDetectionEvent =
  | { kind: "raw"; box: NormalizedBox }
  | { kind: "read"; box: NormalizedBox }
  | { kind: "empty" }
  | { kind: "restart" }

const SEARCHING: ScanDetectionState = { kind: "searching" }

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * A detector bounding box (pixels of the video's intrinsic frame) as 0..1 fractions,
 * clamped into the frame — a barcode half out of shot must not draw an outline hanging
 * outside the viewfinder. A frame with no intrinsic size yet yields a zero box, which
 * the caller treats as "nothing to draw".
 */
export function normalizeDetectionBox(
  boundingBox: { x: number; y: number; width: number; height: number },
  videoWidth: number,
  videoHeight: number,
): NormalizedBox {
  if (!(videoWidth > 0) || !(videoHeight > 0)) return { x: 0, y: 0, width: 0, height: 0 }
  const x = clamp01(boundingBox.x / videoWidth)
  const y = clamp01(boundingBox.y / videoHeight)
  return {
    x,
    y,
    width: Math.min(clamp01(boundingBox.width / videoWidth), 1 - x),
    height: Math.min(clamp01(boundingBox.height / videoHeight), 1 - y),
  }
}

/**
 * The periodic rotated retry (`getRotatedFrame`) hands the detector a canvas turned 90°,
 * so its boxes are in the ROTATED frame's coordinates. The rotation maps a video point
 * (x, y) to (videoHeight - y, x); this is the inverse for a whole box, so a barcode found
 * on a vertically-held bottle still gets its outline drawn where the barcode actually is.
 */
export function unrotateDetectionBox(
  box: { x: number; y: number; width: number; height: number },
  videoHeight: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: box.y,
    y: videoHeight - box.x - box.width,
    width: box.height,
    height: box.width,
  }
}

/**
 * Where a normalized box lands inside an element rendering the video with
 * `object-fit: cover` (centred, cropped on whichever axis overflows). Returns CSS pixels
 * relative to the element's own box; a coordinate may be negative or past the element's
 * edge when that part of the frame is cropped away, which is correct — the overlay is
 * clipped by the viewfinder's `overflow-hidden`.
 */
export function mapBoxToCover(
  box: NormalizedBox,
  video: { width: number; height: number },
  element: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  if (!(video.width > 0) || !(video.height > 0)) return { left: 0, top: 0, width: 0, height: 0 }
  if (!(element.width > 0) || !(element.height > 0)) {
    return { left: 0, top: 0, width: 0, height: 0 }
  }
  const scale = Math.max(element.width / video.width, element.height / video.height)
  const displayedWidth = video.width * scale
  const displayedHeight = video.height * scale
  const offsetX = (element.width - displayedWidth) / 2
  const offsetY = (element.height - displayedHeight) / 2
  return {
    left: offsetX + box.x * displayedWidth,
    top: offsetY + box.y * displayedHeight,
    width: box.width * displayedWidth,
    height: box.height * displayedHeight,
  }
}

/** What the viewfinder is drawing right now — the three detection kinds, rendered. */
export type ScanVisualState = ScanDetectionState["kind"]

/** Everything the viewfinder needs to draw itself, derived from the reported state. */
export type ViewfinderPresentation = {
  visual: ScanVisualState
  /** The box to outline, still normalised; `null` draws no outline at all. */
  outlineBox: NormalizedBox | null
  /**
   * The loop is paused behind a sheet and the confirm window is over: everything the
   * viewfinder shows is stale, so it goes static.
   */
  frozen: boolean
}

function detectionBoxOf(state: ScanDetectionState): NormalizedBox | null {
  return state.kind === "searching" ? null : state.box
}

/**
 * What the viewfinder draws, from what the loop reported plus the two states the
 * component owns. Pure so the three-way derivation is testable without a camera:
 *
 * - the 400ms confirm window owns the `read` look, because the barcode is usually still
 *   in frame while the result sheet rises and the loop keeps reporting `spotted` — the
 *   user would otherwise see the green moment flicker back to amber;
 * - a sheet over a paused loop falls back to a STATIC searching look rather than
 *   freezing an amber "hold still" over a picture nobody can see. The confirm window is
 *   exempt: that is exactly the moment the sheet rises over.
 */
export function deriveViewfinderPresentation(input: {
  detection: ScanDetectionState
  /**
   * The box the loop reported with the accepted decode, captured when the `read` arrived.
   * The confirm window draws THIS box for its whole duration: the loop keeps running
   * behind it, so the live box may already describe a wobble the user made while the
   * sheet was rising — or be gone entirely.
   */
  confirmBox: NormalizedBox | null
  confirmActive: boolean
  detectionPaused: boolean
}): ViewfinderPresentation {
  const { detection, confirmBox, confirmActive, detectionPaused } = input
  const frozen = detectionPaused && !confirmActive
  if (confirmActive) {
    return { visual: "read", outlineBox: confirmBox ?? detectionBoxOf(detection), frozen }
  }
  if (frozen) return { visual: "searching", outlineBox: null, frozen }
  return { visual: detection.kind, outlineBox: detectionBoxOf(detection), frozen }
}

/**
 * The viewfinder's state machine. Deliberately mirrors the D6 re-arm the session already
 * runs on: the outline is only dropped once `REARM_EMPTY_DETECTIONS` attempts in a row
 * saw no barcode at all, so a single missed decode on a still-held bottle does not make
 * the outline flicker.
 */
export function nextDetectionState(
  previous: ScanDetectionState,
  event: ScanDetectionEvent,
  emptyStreak: number,
  rearmAfter: number = REARM_EMPTY_DETECTIONS,
): ScanDetectionState {
  switch (event.kind) {
    case "raw":
      return { kind: "spotted", box: event.box }
    case "read":
      return { kind: "read", box: event.box }
    case "restart":
      return SEARCHING
    case "empty":
      return emptyStreak >= rearmAfter ? SEARCHING : previous
  }
}

/**
 * Which viewfinder event a change to the sheet pause produces. Leaving the pause is the
 * only transition that carries one: the loop stopped looking while the sheet was up, so
 * whatever it last reported describes a frame from before — the bottle may have been put
 * down, turned round or swapped since. The viewfinder goes back to `searching` BEFORE
 * the loop resumes, so the first thing the user sees on a reopened viewfinder is never a
 * stale amber outline. Entering the pause reports nothing: the component already draws
 * the static searching look for the duration (see `deriveViewfinderPresentation`).
 */
export function detectionEventForPauseChange(
  wasPaused: boolean,
  paused: boolean,
): ScanDetectionEvent | null {
  return wasPaused && !paused ? { kind: "restart" } : null
}

/**
 * How far a box edge has to move before the UI is told about it, as a fraction of the
 * frame. Detector boxes jitter every frame on a bottle that is being held still; half a
 * percent of the frame is well under what the eye reads as a moving outline, and well
 * over the jitter — the outline follows real movement through its CSS transition instead
 * of re-rendering on noise.
 */
export const BOX_MOVE_TOLERANCE = 0.005

/**
 * Whether two states are the same as far as the UI is concerned. This is what keeps the
 * reporting seam off React's render path: the loop runs at frame rate, and a static
 * barcode must not cause a `setState` per frame.
 *
 * Boxes are compared by ABSOLUTE delta, not by rounding each component into a bucket:
 * a bucketed comparison calls a 0.00002 wobble a move whenever it happens to straddle a
 * bucket edge, and calls a 0.0049 jump nothing whenever it does not. The caller always
 * compares against the box it LAST REPORTED (the hook holds that reference), so the
 * pairwise comparison is not asked to be transitive — a slow drift accumulates against
 * the reported box and is reported the moment it has really moved half a percent.
 */
export function isSameDetectionState(a: ScanDetectionState, b: ScanDetectionState): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "searching" || b.kind === "searching") return true
  return (
    withinBoxTolerance(a.box.x, b.box.x) &&
    withinBoxTolerance(a.box.y, b.box.y) &&
    withinBoxTolerance(a.box.width, b.box.width) &&
    withinBoxTolerance(a.box.height, b.box.height)
  )
}

function withinBoxTolerance(a: number, b: number): boolean {
  return Math.abs(a - b) <= BOX_MOVE_TOLERANCE
}

/**
 * What the viewfinder's polite live region should say, and what it has already said this
 * scan attempt. The visual pill and the announced text are deliberately NOT the same
 * thing: the pill flips as fast as the detector does, and a screen reader that reads
 * every flip out loud makes the scanner unusable.
 */
export type ViewfinderAnnouncementState = {
  /** The text the live region holds. */
  announcement: string
  /** "Barcode gefunden" is worth saying once per attempt, not once per flicker. */
  spottedAnnounced: boolean
  /** Neither is the fall back to "Suche Barcode …". */
  searchingAnnounced: boolean
}

/**
 * The state every scan attempt starts from. The idle hint is already in the region
 * rather than announced into it: a polite live region does not read its initial
 * content, so the first thing a user hears is a real change.
 */
export const INITIAL_VIEWFINDER_ANNOUNCEMENT: ViewfinderAnnouncementState = {
  announcement: SCAN_HINT_DEFAULT,
  spottedAnnounced: false,
  searchingAnnounced: false,
}

/**
 * The announcement policy. Pure, and separate from the rate limit that drives it (the
 * component decides WHEN this runs; this decides WHAT is worth saying):
 *
 * - an accepted decode always announces — it is the one moment the user must not miss;
 * - a situational hint ("Mehr Licht hilft") always announces — it asks for an action;
 * - the `spotted` / `searching` flip announces once each per attempt, so a barcode at
 *   the edge of readability cannot turn the live region into a metronome.
 */
export function nextViewfinderAnnouncement(
  previous: ViewfinderAnnouncementState,
  input: { visual: ScanVisualState; hint: ScanHint },
): ViewfinderAnnouncementState {
  const { visual, hint } = input
  if (visual === "read") {
    return previous.announcement === SCAN_CONFIRM_LABEL
      ? previous
      : { ...previous, announcement: SCAN_CONFIRM_LABEL }
  }
  if (visual === "spotted") {
    if (previous.spottedAnnounced) return previous
    return { ...previous, announcement: SCAN_HINT_SPOTTED, spottedAnnounced: true }
  }
  if (hint !== SCAN_HINT_DEFAULT) {
    return previous.announcement === hint ? previous : { ...previous, announcement: hint }
  }
  if (previous.searchingAnnounced) return previous
  // The candidate text is identical to what the region already holds — most often the
  // very first publish, which fires with the initial "searching" + default hint state it
  // already started from. Spending the once-per-attempt budget here would mean nothing
  // was ever actually said, and the real flip back to idle (after a spotted/read
  // announcement) would then find the budget gone and get stuck on stale text.
  if (previous.announcement === hint) return previous
  return { ...previous, announcement: hint, searchingAnnounced: true }
}
