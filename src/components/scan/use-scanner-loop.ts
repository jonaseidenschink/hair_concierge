"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react"

import { nextScanHint, type ScanHint, type ScanTelemetry } from "@/lib/scan/guidance"
import { validateEanInput } from "@/lib/scan/identifier-lookup"
import {
  MUTE_GRACE_MS,
  advanceLoopClock,
  bumpLoopGeneration,
  createScanLoopController,
  isDetectionCurrent,
  isLoopPaused,
  isVideoStreamDead,
  nextLoopAction,
  recoveryFailureAction,
  setPauseReason,
  streamReleasePlan,
  type PauseReason,
  type RecoverTrigger,
} from "@/lib/scan/scanner-loop"
import {
  applyRawDetection,
  createScanSessionState,
  detectionEventForPauseChange,
  isSameDetectionState,
  nextDetectionState,
  normalizeDetectionBox,
  noteEmptyDetection,
  restartScanSessionState,
  selectDetectionCandidate,
  unfireDetection,
  unrotateDetectionBox,
  type ScanDetectionEvent,
  type ScanDetectionState,
  type ScanSessionState,
} from "@/lib/scan/scanner-session"

// Type-only import: erased at build time, so this does NOT pull the zxing-wasm ponyfill
// into the initial bundle. The runtime module is loaded via a dynamic `import()` in
// `defaultDetectorFactory`, only after camera permission has been granted.
import type { DetectedBarcode } from "barcode-detector/ponyfill"

export type { PauseReason }
export { MUTE_GRACE_MS }

export type ScanUnavailableReason = "no_camera" | "denied" | "insecure"

/** The slice of `BarcodeDetector` the loop uses — narrow so tests can stand in for it. */
export type ScanBarcodeDetector = {
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>
}

/**
 * Seams for driving the loop without a real camera (Playwright, harnesses). Both default
 * to the production implementations, so `<Scanner />` with no `runtime` behaves exactly
 * as it always has.
 */
export type ScannerRuntime = {
  /** Defaults to `getUserMedia({ video: { facingMode: "environment" }, audio: false })`. */
  mediaSource?: () => Promise<MediaStream>
  /** Defaults to the lazy `barcode-detector/ponyfill` import + same-origin wasm override. */
  detectorFactory?: () => Promise<ScanBarcodeDetector>
}

export type UseScannerLoopArgs = {
  /** Parent controls the camera lifecycle: nothing is acquired or decoded while false. */
  active: boolean
  /** Bump to start a fresh scan attempt on the same, still-running camera. */
  sessionEpoch: number
  /** Pause the detection loop (not the camera) while a sheet covers the viewfinder. */
  detectionPaused: boolean
  runtime?: ScannerRuntime
  videoRef: RefObject<HTMLVideoElement | null>
  /**
   * A stable, validated read. The consumer answers whether it actually TOOK the decode:
   * `false` (a sheet still covers the viewfinder, a resolve is already in flight) means
   * the value was never consumed, so the loop rewinds its dedupe guards and the same
   * barcode fires again as soon as the flow can take it — without the user having to move
   * the bottle out of frame first (controller ruling C3).
   */
  onDecoded: (value: string) => boolean
  onUnavailable: (reason: ScanUnavailableReason) => void
  /** Fires once per attempt after 3s of *active* scanning without a stable read. */
  onTimeout: () => void
  /** The stream died and could not be re-acquired — the viewfinder is dead (F8). */
  onStalled: () => void
  onHint: (hint: ScanHint) => void
  /**
   * What the viewfinder should be drawing right now: nothing yet (`searching`), an amber
   * outline on a barcode that is in frame but not read (`spotted`), or a green one on the
   * barcode that just decoded (`read`). Called ONLY when the state actually changed
   * (`isSameDetectionState`), so a bottle held still does not cost a `setState` per frame.
   * Purely a reporting seam — nothing in the detection lifecycle depends on it.
   */
  onDetectionState: (state: ScanDetectionState) => void
  /** A stable decode was accepted; the component shows the green confirm state. */
  onConfirm: () => void
  /**
   * A fresh scan attempt started (mount, or an `sessionEpoch` bump). The component
   * resets its pill back to the default hint and drops any confirm state. Owned by the
   * hook because the hook is what actually restarts the session.
   */
  onAttemptStart: () => void
}

// EAN-only per the resolve API's identifier scope (Task 5).
const DETECTOR_FORMATS = ["ean_13", "ean_8"] as const

const DETECTION_FRAME_INTERVAL = 3 // run detection on ~every 3rd frame callback
const ROTATION_RETRY_INTERVAL = 5 // every ~5th detection attempt with no raw hit, try rotated
const LUMA_SAMPLE_INTERVAL_MS = 500 // ~2x/second
const LUMA_SAMPLE_SIZE = 16

// Self-hosted zxing-wasm reader binary. `barcode-detector`'s default `locateFile`
// fetches this from https://fastly.jsdelivr.net/npm/zxing-wasm@<version>/... at runtime —
// we override it so no request ever leaves our origin. MUST stay pinned to the exact
// zxing-wasm version `barcode-detector` depends on (currently zxing-wasm@3.1.3, via
// barcode-detector@3.2.2 — see package.json). The file was copied verbatim from
// `node_modules/zxing-wasm/dist/reader/zxing_reader.wasm` (sha256
// 2ebda08a93eea3efcd8399cda6b276e6a0b1de4fec60b4d8988a047de4c6d1ba, matching the
// package's own exported `ZXING_WASM_SHA256`) into `public/wasm/`. When either package
// bumps its zxing-wasm version: re-copy the file, keep the version in the filename (so a
// stale cached copy can never be served from a URL that also serves the new one), and
// update this constant.
const ZXING_READER_WASM_PATH = "/wasm/zxing_reader-3.1.3.wasm"

// Module-scope, not per-session: the override only needs to be registered once for the
// page's lifetime (zxing-wasm caches it internally), so repeated scan sessions on the
// same page load don't need to redo this.
let zxingWasmOverrideConfigured = false

function defaultMediaSource(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false,
  })
}

async function defaultDetectorFactory(): Promise<ScanBarcodeDetector> {
  // Lazy-loaded only after permission is granted (bundle-size boundary — see report).
  const ponyfill = await import("barcode-detector/ponyfill")
  if (!zxingWasmOverrideConfigured) {
    ponyfill.setZXingModuleOverrides({ locateFile: () => ZXING_READER_WASM_PATH })
    zxingWasmOverrideConfigured = true
  }
  return new ponyfill.BarcodeDetector({ formats: [...DETECTOR_FORMATS] })
}

function ensureCanvas(ref: { current: HTMLCanvasElement | null }): HTMLCanvasElement {
  if (!ref.current) ref.current = document.createElement("canvas")
  return ref.current
}

/** The current frame turned 90°, for the periodic retry on vertically-held barcodes. */
function getRotatedFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): HTMLCanvasElement | null {
  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) return null
  canvas.width = h
  canvas.height = w
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  ctx.save()
  ctx.translate(h / 2, w / 2)
  ctx.rotate(Math.PI / 2)
  ctx.drawImage(video, -w / 2, -h / 2, w, h)
  ctx.restore()
  return canvas
}

/** Mean luma of a 16×16 downscale of the current frame, or null if it can't be read. */
function sampleMeanLuma(video: HTMLVideoElement, canvas: HTMLCanvasElement): number | null {
  canvas.width = LUMA_SAMPLE_SIZE
  canvas.height = LUMA_SAMPLE_SIZE
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, LUMA_SAMPLE_SIZE, LUMA_SAMPLE_SIZE)
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, LUMA_SAMPLE_SIZE, LUMA_SAMPLE_SIZE).data
  } catch {
    // Tainted canvas: keep the previous reading rather than claiming darkness.
    return null
  }
  let sum = 0
  const pixelCount = data.length / 4
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }
  return pixelCount > 0 ? sum / pixelCount : null
}

function updateLumaIfDue(
  session: ScanSessionState,
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  now: number,
): void {
  if (video.readyState < 2) return
  if (now - session.lastLumaSampleTime < LUMA_SAMPLE_INTERVAL_MS) return
  session.lastLumaSampleTime = now
  const luma = sampleMeanLuma(video, canvas)
  if (luma !== null) session.meanLuma = luma
}

function updateHint(
  session: ScanSessionState,
  now: number,
  onHint: (hint: ScanHint) => void,
): void {
  const telemetry: ScanTelemetry = {
    msSinceStart: now - session.startTime,
    msSinceLastDetection: now - session.lastDetectionTime,
    lastBoundingBoxRatio: session.lastBoundingBoxRatio,
    meanLuma: session.meanLuma,
    rawDetectionsWithoutStableRead: session.rawDetectionsWithoutStableRead,
  }
  const next = nextScanHint(telemetry, {
    currentHint: session.hint,
    msSinceLastHintChange: now - session.hintChangedAt,
  })
  if (next === null) return
  session.hint = next
  session.hintChangedAt = now
  onHint(next)
}

/** The listeners one acquired stream carries, kept with the exact handler references. */
type WatchedStream = {
  tracks: MediaStreamTrack[]
  onEnded: () => void
  onMute: () => void
  onUnmute: () => void
}

/**
 * The camera + detection lifecycle behind `<Scanner />`, with exactly one owner for the
 * frame loop.
 *
 * Everything that used to schedule frames from four different places now goes through
 * `syncLoop()`, which is the only function in the app allowed to call
 * `requestVideoFrameCallback` / `requestAnimationFrame`. Whether a frame may be
 * outstanding at all is decided by the pure controller in `@/lib/scan/scanner-loop`
 * (tested in `tests/scan-scanner-loop.test.ts`), and whether a decode counts is decided
 * by the pure state machine in `@/lib/scan/scanner-session`. What is left here is the
 * browser wiring: the stream, the listeners, and the recovery paths.
 */
export function useScannerLoop({
  active,
  sessionEpoch,
  detectionPaused,
  runtime,
  videoRef,
  onDecoded,
  onUnavailable,
  onTimeout,
  onStalled,
  onHint,
  onDetectionState,
  onConfirm,
  onAttemptStart,
}: UseScannerLoopArgs): void {
  const sessionRef = useRef(createScanSessionState())
  const controllerRef = useRef(createScanLoopController())
  const streamRef = useRef<MediaStream | null>(null)
  const detectorRef = useRef<ScanBarcodeDetector | null>(null)
  const frameHandleRef = useRef<number | null>(null)
  const frameKindRef = useRef<"rvfc" | "raf" | null>(null)
  const lumaCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const rotationCanvasRef = useRef<HTMLCanvasElement | null>(null)
  // `syncLoop` schedules the tick, and the tick re-syncs the loop. The indirection keeps
  // that from becoming a `useCallback` cycle.
  const tickRef = useRef<() => void>(() => {})
  /** The last state handed to `onDetectionState`; the source for the change check. */
  const detectionStateRef = useRef<ScanDetectionState>({ kind: "searching" })

  // Latest props, so the long-lived camera effect never closes over a stale callback.
  const latestRef = useRef({
    runtime,
    onDecoded,
    onUnavailable,
    onTimeout,
    onStalled,
    onHint,
    onDetectionState,
    onConfirm,
    onAttemptStart,
  })
  useEffect(() => {
    latestRef.current = {
      runtime,
      onDecoded,
      onUnavailable,
      onTimeout,
      onStalled,
      onHint,
      onDetectionState,
      onConfirm,
      onAttemptStart,
    }
  }, [
    runtime,
    onDecoded,
    onUnavailable,
    onTimeout,
    onStalled,
    onHint,
    onDetectionState,
    onConfirm,
    onAttemptStart,
  ])

  /**
   * Fold one detection event into the viewfinder state and report it — but only when it
   * really changed. This is the whole cost of the seam on the frame loop: one pure
   * transition plus a rounded box comparison, and a React update only on a real change.
   */
  const reportDetection = useCallback((event: ScanDetectionEvent, emptyStreak: number) => {
    const previous = detectionStateRef.current
    const next = nextDetectionState(previous, event, emptyStreak)
    if (isSameDetectionState(previous, next)) return
    detectionStateRef.current = next
    latestRef.current.onDetectionState(next)
  }, [])

  /**
   * The one place frames are scheduled or cancelled. Idempotent by construction: it acts
   * on `nextLoopAction`, so calling it twice never leaves two frames outstanding and
   * calling it while paused never resurrects the loop (F10).
   */
  const syncLoop = useCallback(() => {
    const controller = controllerRef.current
    const action = nextLoopAction(controller)
    if (action === "noop") return

    const video = videoRef.current
    if (action === "cancel") {
      const handle = frameHandleRef.current
      if (handle !== null) {
        if (frameKindRef.current === "rvfc" && video?.cancelVideoFrameCallback) {
          video.cancelVideoFrameCallback(handle)
        } else if (frameKindRef.current === "raf") {
          cancelAnimationFrame(handle)
        }
      }
      frameHandleRef.current = null
      frameKindRef.current = null
      controller.frameScheduled = false
      return
    }

    if (!video) return
    const runFrame = () => {
      // The handle is consumed the moment the callback fires, so the tick's own
      // `syncLoop()` continuation schedules the next one instead of being a no-op.
      frameHandleRef.current = null
      frameKindRef.current = null
      controllerRef.current.frameScheduled = false
      tickRef.current()
    }
    if (typeof video.requestVideoFrameCallback === "function") {
      frameKindRef.current = "rvfc"
      frameHandleRef.current = video.requestVideoFrameCallback(() => runFrame())
    } else {
      frameKindRef.current = "raf"
      frameHandleRef.current = requestAnimationFrame(() => runFrame())
    }
    controller.frameScheduled = true
  }, [videoRef])

  /**
   * One `detect()` pass. `generation` is captured before the await; if the loop paused,
   * restarted or tore down while the detector was working, the results are dropped whole
   * — no session mutation, no callbacks — because they describe a frame from a scanning
   * moment the user has already left (F3).
   */
  const runDetectionCycle = useCallback(
    async (generation: number) => {
      const video = videoRef.current
      const detector = detectorRef.current
      const session = sessionRef.current
      if (!video || !detector || session.detecting) return
      session.detecting = true
      try {
        let results: DetectedBarcode[] = []
        try {
          results = await detector.detect(video)
        } catch {
          results = []
        }
        if (!isDetectionCurrent(controllerRef.current, generation)) return

        session.detectionAttempts += 1
        // Whether `results` describe the 90°-rotated retry frame rather than the video:
        // their boxes then need mapping back before the overlay can be drawn from them.
        let fromRotatedFrame = false
        if (results.length === 0 && session.detectionAttempts % ROTATION_RETRY_INTERVAL === 0) {
          const rotated = getRotatedFrame(video, ensureCanvas(rotationCanvasRef))
          if (rotated) {
            try {
              const rotatedResults = await detector.detect(rotated)
              if (rotatedResults.length > 0) {
                results = rotatedResults
                fromRotatedFrame = true
              }
            } catch {
              // Rotation retry is best-effort; ignore failures.
            }
          }
        }
        if (!isDetectionCurrent(controllerRef.current, generation)) return

        if (results.length === 0) {
          // Counts towards the D6 re-arm: three empty attempts mean the barcode really
          // left the frame, which is what releases a blocked value.
          noteEmptyDetection(session)
          // Same threshold for the outline: it is dropped once the barcode has really
          // left the frame, not on the first attempt that happened to miss it.
          reportDetection({ kind: "empty" }, session.emptyDetections)
          return
        }

        // Not `results[0]`: a frame holding the blocked bottle AND a new one must look at
        // the new one, or it would never be read while the old block stands.
        const primary = selectDetectionCandidate(results, session, validateEanInput)
        if (!primary) return
        const frameArea = video.videoWidth * video.videoHeight
        // The candidate the session is about to fold in is also the one the viewfinder
        // outlines — anything else would draw a box around a barcode we are ignoring.
        const detectionBox =
          video.videoWidth > 0 && video.videoHeight > 0
            ? normalizeDetectionBox(
                fromRotatedFrame
                  ? unrotateDetectionBox(primary.boundingBox, video.videoHeight)
                  : primary.boundingBox,
                video.videoWidth,
                video.videoHeight,
              )
            : null
        if (detectionBox) reportDetection({ kind: "raw", box: detectionBox }, 0)
        const { fire } = applyRawDetection(
          session,
          {
            rawValue: primary.rawValue,
            boundingBoxRatio:
              frameArea > 0
                ? (primary.boundingBox.width * primary.boundingBox.height) / frameArea
                : null,
            now: performance.now(),
          },
          validateEanInput,
        )
        if (fire !== null) {
          // The confirm state is the *accepted* decode's green moment: a refused value
          // never reached the flow, so it gets neither the pill nor the consumed guards.
          if (latestRef.current.onDecoded(fire)) {
            if (detectionBox) reportDetection({ kind: "read", box: detectionBox }, 0)
            latestRef.current.onConfirm()
          } else {
            unfireDetection(session, fire)
          }
        }
      } finally {
        session.detecting = false
      }
    },
    [reportDetection, videoRef],
  )

  const tick = useCallback(() => {
    const controller = controllerRef.current
    if (isLoopPaused(controller)) return
    const session = sessionRef.current
    const generation = controller.generation
    session.frameCounter += 1

    const finish = () => {
      const video = videoRef.current
      // A continuation that lost its generation (pause, epoch restart, teardown) stops
      // here: whoever bumped the generation owns re-syncing the loop.
      if (!video || !isDetectionCurrent(controllerRef.current, generation)) return
      // Read `now` AFTER the awaited detection — the old loop reused a pre-await
      // timestamp, so a slow decode under-reported both the hint window and the clock.
      const now = performance.now()
      updateLumaIfDue(session, video, ensureCanvas(lumaCanvasRef), now)
      updateHint(session, now, latestRef.current.onHint)
      if (advanceLoopClock(controllerRef.current, session, now).timedOut) {
        latestRef.current.onTimeout()
      }
      syncLoop()
    }

    if (session.frameCounter % DETECTION_FRAME_INTERVAL === 0) {
      void runDetectionCycle(generation).then(finish)
    } else {
      finish()
    }
  }, [runDetectionCycle, syncLoop, videoRef])

  useEffect(() => {
    tickRef.current = tick
  }, [tick])

  useEffect(() => {
    if (!active) return
    const controller = controllerRef.current

    let cancelled = false
    let recovering = false
    let stalled = false
    let trackMuted = false
    let pageListenersAttached = false
    let muteGraceTimer: number | null = null
    /**
     * The streams this effect instance attached listeners to, keyed by the stream itself.
     * Ownership is explicit and per stream — never "whatever sits in `streamRef`" — so a
     * stale instance that wakes up from an await cannot stop the stream a *newer*
     * instance acquired (Task 10 re-activates the Scanner on `camera_retry`; the old
     * aliasing bug killed that new camera silently: no `ended` event, no recovery).
     */
    const watched = new Map<MediaStream, WatchedStream>()

    // Session start: one reset point for every mutable field a prior session could have
    // left in a non-default state (dedupe/debounce counters, hint, telemetry).
    sessionRef.current = createScanSessionState()
    controller.running = false
    controller.lastTickAt = null
    bumpLoopGeneration(controller)
    setPauseReason(controller, "hidden", document.visibilityState === "hidden")

    function stopLoop() {
      controller.running = false
      bumpLoopGeneration(controller)
      syncLoop()
    }

    function clearMuteGrace() {
      if (muteGraceTimer === null) return
      window.clearTimeout(muteGraceTimer)
      muteGraceTimer = null
    }

    /**
     * A foreground `mute` only arms this timer (see `MUTE_GRACE_MS`): `unmute` disarms it
     * and the camera heals itself; only an expiry means the frames really are gone.
     */
    function startMuteGrace() {
      if (muteGraceTimer !== null) return
      muteGraceTimer = window.setTimeout(() => {
        muteGraceTimer = null
        if (cancelled || !trackMuted) return
        void recover("mute")
      }, MUTE_GRACE_MS)
    }

    function watchTracks(stream: MediaStream) {
      if (watched.has(stream)) return
      // Every handler is bound to its own stream and ignores events from a stream that is
      // no longer the live one, so a dying old stream cannot drive the new one's state.
      const isCurrent = () => streamRef.current === stream
      const onEnded = () => {
        if (isCurrent()) void recover("ended")
      }
      const onMute = () => {
        if (!isCurrent()) return
        trackMuted = true
        // A mute while hidden is ordinary backgrounding; it is re-checked on the way back
        // in `handleVisibilityChange` instead of burning a grace window in the background.
        if (document.visibilityState === "visible") startMuteGrace()
      }
      const onUnmute = () => {
        if (!isCurrent()) return
        trackMuted = false
        clearMuteGrace()
        // The other half of "leave it to the next resume/unmute": a recovery that kept
        // this stream may have left the loop stopped because the element would not play.
        resumeAndSync()
      }
      const tracks = stream.getVideoTracks()
      for (const track of tracks) {
        track.addEventListener("ended", onEnded)
        track.addEventListener("mute", onMute)
        track.addEventListener("unmute", onUnmute)
      }
      watched.set(stream, { tracks, onEnded, onMute, onUnmute })
    }

    /**
     * Release exactly the stream the caller owns. The shared slots (`streamRef`,
     * `video.srcObject`) are cleared only while they still point at *this* stream —
     * `streamReleasePlan` owns that invariant and is tested in
     * `tests/scan-scanner-loop.test.ts`.
     */
    function releaseStream(stream: MediaStream | null) {
      if (!stream) return
      const entry = watched.get(stream)
      if (entry) {
        for (const track of entry.tracks) {
          track.removeEventListener("ended", entry.onEnded)
          track.removeEventListener("mute", entry.onMute)
          track.removeEventListener("unmute", entry.onUnmute)
        }
        watched.delete(stream)
      }
      const plan = streamReleasePlan(
        { current: streamRef.current, videoSource: videoRef.current?.srcObject ?? null },
        stream,
      )
      if (plan.clearCurrent) {
        streamRef.current = null
        trackMuted = false
        clearMuteGrace()
      }
      stream.getTracks().forEach((track) => track.stop())
      if (plan.clearVideoSource) {
        const video = videoRef.current
        if (video) video.srcObject = null
      }
    }

    /**
     * F8(a): a `play()` rejected at start (autoplay blocked before any user gesture, or
     * the tab was never in front) gets its retry here. `play()` on an already playing
     * element resolves immediately, so this is safe on every resume (F8c).
     *
     * Reports whether the element is actually playing afterwards: a frame callback on a
     * PAUSED video never fires, so `recover()`'s keep branch must not start a loop that
     * would then pend forever.
     */
    async function resumePlayback(): Promise<boolean> {
      const video = videoRef.current
      if (!video) return false
      try {
        await video.play()
        return true
      } catch {
        return false
      }
    }

    /**
     * Restart a loop that a failed `play()` left stopped (see `recover()`'s keep branch).
     * The stream and the detector are the ones we already own, so this is a loop restart,
     * never a re-acquire — and it deliberately does nothing while a start or a recovery
     * is still in flight, or after a stall latched.
     */
    function resumeLoopIfSuspended() {
      if (cancelled || stalled || recovering) return
      if (controller.running) return
      if (!streamRef.current || !detectorRef.current) return
      beginLoop()
    }

    /** The ordinary resume: replay the element, and pick a suspended loop back up. */
    function resumeAndSync() {
      void resumePlayback().then((playing) => {
        if (playing) resumeLoopIfSuspended()
      })
      syncLoop()
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        setPauseReason(controller, "hidden", true)
        // The grace window is a foreground policy: disarm it rather than re-acquiring
        // into a background tab.
        clearMuteGrace()
        syncLoop()
        return
      }
      setPauseReason(controller, "hidden", false)
      if (trackMuted) {
        // Backgrounding muted the track and it never came back: try for a new stream,
        // but keep this one if the re-acquire fails — it may still unmute.
        void recover("visibility")
        return
      }
      resumeAndSync()
    }

    function handlePageShow(event: PageTransitionEvent) {
      // A bfcache restore hands back a page whose MediaStream tracks are already dead.
      if (event.persisted) {
        void recover("pageshow")
        return
      }
      resumeAndSync()
    }

    function attachPageListeners() {
      if (pageListenersAttached) return
      pageListenersAttached = true
      document.addEventListener("visibilitychange", handleVisibilityChange)
      window.addEventListener("pageshow", handlePageShow)
    }

    /**
     * Acquire a stream and attach it. Returns the stream this call owns (the caller is
     * then responsible for it) or null. Every bail-out after attachment releases *that*
     * stream, never `streamRef`'s.
     */
    async function acquire(reportUnavailable: boolean): Promise<MediaStream | null> {
      if (typeof window === "undefined") return null
      const { runtime: currentRuntime } = latestRef.current
      if (!window.isSecureContext) {
        if (reportUnavailable) latestRef.current.onUnavailable("insecure")
        return null
      }
      const mediaSource = currentRuntime?.mediaSource
      if (!mediaSource && !navigator.mediaDevices?.getUserMedia) {
        if (reportUnavailable) latestRef.current.onUnavailable("no_camera")
        return null
      }

      let stream: MediaStream
      try {
        stream = await (mediaSource ?? defaultMediaSource)()
      } catch (err) {
        if (cancelled) return null
        if (reportUnavailable) {
          const name = err instanceof DOMException ? err.name : ""
          const denied = name === "NotAllowedError" || name === "SecurityError"
          latestRef.current.onUnavailable(denied ? "denied" : "no_camera")
        }
        return null
      }
      // Not attached to anything yet, so this stream is still purely local.
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop())
        return null
      }
      const video = videoRef.current
      if (!video) {
        stream.getTracks().forEach((track) => track.stop())
        return null
      }

      watchTracks(stream)
      streamRef.current = stream
      // The new stream is unmuted by construction: mute bookkeeping is per current stream,
      // and the old stream (if any) is stopped without ever firing `unmute` — so without
      // this reset a stale `trackMuted` from before the swap would survive it and force
      // every later `visibilitychange` to `recover("visibility")` again (see report, Fix
      // round 2).
      trackMuted = false
      clearMuteGrace()
      video.srcObject = stream
      try {
        await video.play()
      } catch {
        // Autoplay can be blocked without a user gesture; playsInline+muted covers the
        // common iOS case, and `resumePlayback` retries on the next resume (F8a).
      }
      // From here on a teardown may already have run while an await was pending, and its
      // release loop saw a stream this closure had not registered yet — so every bail-out
      // hands back the stream it acquired itself.
      if (cancelled) {
        releaseStream(stream)
        return null
      }

      // Kept across a re-acquire: the detector is stateless and re-creating it would
      // re-enter the wasm module for nothing.
      if (!detectorRef.current) {
        let detector: ScanBarcodeDetector
        try {
          detector = await (currentRuntime?.detectorFactory ?? defaultDetectorFactory)()
        } catch {
          releaseStream(stream)
          if (cancelled) return null
          // The camera works but nothing can decode: same dead end for the user as no
          // camera at all, so the flow falls back to the search sheet.
          if (reportUnavailable) latestRef.current.onUnavailable("no_camera")
          return null
        }
        if (cancelled) {
          releaseStream(stream)
          return null
        }
        detectorRef.current = detector
      }
      return stream
    }

    function beginLoop() {
      const session = sessionRef.current
      const now = performance.now()
      session.startTime = now
      session.lastDetectionTime = now
      session.hintChangedAt = now
      controller.lastTickAt = null
      controller.running = true
      bumpLoopGeneration(controller)
      attachPageListeners()
      syncLoop()
    }

    /**
     * F8: the live stream may be gone (track ended, a foreground mute that outlived its
     * grace, a mute that survived backgrounding, a bfcache restore).
     *
     * The NEW stream is acquired first and the old one is only released once that
     * succeeded: a `getUserMedia` issued during a transient mute fails with
     * `NotReadableError`, and tearing down first would trade a self-healing blip for a
     * dead viewfinder. On failure the old stream, its listeners and the loop stay in
     * place; only a provably dead old stream latches `stalled` + `onStalled()`. The
     * session is deliberately NOT reset — the same scan attempt continues, keeping the D6
     * block that stops a re-scan of the last product.
     */
    async function recover(trigger: RecoverTrigger) {
      if (cancelled || recovering || stalled) return
      recovering = true
      const previous = streamRef.current
      try {
        stopLoop()
        const next = await acquire(false)
        if (cancelled) {
          releaseStream(next)
          return
        }
        if (!next) {
          const action = recoveryFailureAction({
            trigger,
            previousStreamDead: isVideoStreamDead(previous),
          })
          if (action === "stall") {
            stalled = true
            latestRef.current.onStalled()
            return
          }
          // The old stream is still alive and may still unmute: keep scanning on it and
          // let the next `ended`/`mute` decide. But a bfcache restore or a foreground
          // mute can leave the ELEMENT paused, and a frame callback on a paused video
          // never fires — so the loop only restarts once playback really resumed.
          const playing = await resumePlayback()
          if (cancelled) return
          if (playing) {
            beginLoop()
            return
          }
          if (isVideoStreamDead(previous)) {
            // It will not play and the tracks are gone after all: the dead viewfinder
            // `onStalled` exists for.
            stalled = true
            latestRef.current.onStalled()
            return
          }
          // Neither dead nor playable right now (autoplay blocked, still backgrounded):
          // leave the loop stopped rather than pending a frame that can never arrive.
          // `resumeAndSync` picks it back up on the next visibility resume, `pageshow`
          // or `unmute`.
          return
        }
        if (previous && previous !== next) releaseStream(previous)
        beginLoop()
      } finally {
        recovering = false
      }
    }

    async function start() {
      const stream = await acquire(true)
      if (!stream) return
      if (cancelled) {
        releaseStream(stream)
        return
      }
      beginLoop()
    }

    void start()

    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("pageshow", handlePageShow)
      pageListenersAttached = false
      clearMuteGrace()
      stopLoop()
      // Only the streams this instance actually owns: a stream acquired by a newer effect
      // instance is not in `watched` and is left running.
      for (const stream of [...watched.keys()]) releaseStream(stream)
      detectorRef.current = null
      controller.pauseReasons.clear()
      controller.lastTickAt = null
    }
  }, [active, syncLoop, videoRef])

  /**
   * Sheet open/close. Only the detection loop is affected — the stream and the video
   * element are untouched, so nothing has to be re-acquired on resume.
   *
   * A LAYOUT effect on purpose: the frame loop and a pending `detect()` continuation run
   * outside React's commit cycle, so a passive effect would leave a window after the
   * commit that opened the sheet in which a decode could still be accepted. The pause is
   * in place before the browser can hand us another frame.
   *
   * On the unpause edge this also reaches a `setState`, indirectly: `reportDetection`
   * forwards the `restart` event to `onDetectionState`, which is the parent's `setDetection`.
   * That is still fine inside a layout effect — it is a synchronous, pre-paint re-render,
   * not one deferred to a passive effect — and it is the whole point of firing here rather
   * than after commit: "searching before the loop resumes" only holds if the viewfinder
   * has already dropped the stale outline by the time the browser paints the reopened
   * frame, not one tick later.
   */
  useLayoutEffect(() => {
    if (!active) return
    const controller = controllerRef.current
    const wasPaused = controller.pauseReasons.has("sheet")
    setPauseReason(controller, "sheet", detectionPaused)
    // Before the loop picks frames back up, not after: the barcode may have moved while
    // the sheet was up, so the last thing reported is not evidence any more.
    const resumeEvent = detectionEventForPauseChange(wasPaused, detectionPaused)
    if (resumeEvent) reportDetection(resumeEvent, 0)
    syncLoop()
  }, [active, detectionPaused, reportDetection, syncLoop])

  /**
   * Session restart without a camera restart. The camera effect keys only on `active`,
   * which stays true for the whole `/scan` visit (the sheet slides up *over* a running
   * camera so "Nochmal scannen" is instant), so the scan-attempt guards are reset in
   * place here on every epoch bump.
   */
  useEffect(() => {
    if (!active) return
    const controller = controllerRef.current
    restartScanSessionState(sessionRef.current, performance.now())
    bumpLoopGeneration(controller)
    controller.lastTickAt = null
    // The viewfinder starts every attempt clean: whatever outline the last attempt ended
    // on describes a frame the user has already left.
    reportDetection({ kind: "restart" }, 0)
    latestRef.current.onAttemptStart()
    syncLoop()
  }, [active, reportDetection, sessionEpoch, syncLoop])
}
