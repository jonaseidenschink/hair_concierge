"use client"

import { useMemo } from "react"

import { ScanFlow } from "@/components/scan/scan-flow"
import type { ScanBarcodeDetector, ScannerRuntime } from "@/components/scan/use-scanner-loop"
import type { ScanAnalyticsPort } from "@/lib/scan/scan-analytics"
import { ToastProvider } from "@/providers/toast-provider"

/**
 * The `/labs/scan` harness itself: a fake camera, a fake barcode detector, and the
 * `window.__scanLab` control surface the Playwright spec (`tests/scan-flow.spec.ts`)
 * drives them with.
 *
 * The lab owns nothing about the flow's behaviour — `ScanFlow` is rendered exactly as
 * production renders it, only with its `scannerRuntime` seam filled in and its analytics
 * port pointed at an in-memory array. Everything the flow observes about the world (the
 * camera, the detector, the API) comes from outside it, so what this page exercises is
 * the real component.
 *
 * `ToastProvider` is mounted because `useToast` falls back to a no-op context — without
 * it the resolve-error toast would silently not exist and the F1 toast-loop scenario
 * could not be observed at all. Nothing else from `AppRouteProviders` is needed (and
 * `AuthProvider` would drag Supabase into a page that deliberately has no session).
 */

type ScanLabFrame = string | null

type ScanLabState = {
  step: string
  auxiliary: string
  camera: string
  cameraReason: string
  saveOpen: boolean
  epoch: number
  /**
   * What the VIEWFINDER is drawing — `searching` / `spotted` / `read`, or `""` while the
   * scanner is not mounted at all. It lives on the scanner root (inside the flow root),
   * not on the flow root, so it is read from its own element.
   */
  detection: string
}

type ScanLabEvent = { name: string; payload: unknown; t: number }
type ScanLabTransition = ScanLabState & { t: number }

export type ScanLab = {
  /**
   * A barcode enters the frame: `times` detection results carrying `value`, then it stays
   * in frame (see `restingFrame`). Two consecutive results are one stable read, so the
   * default fires exactly one decode.
   */
  emit(value: string, times?: number): void
  /** The frame goes empty for `times` detections, and stays empty (drives the D6 re-arm). */
  emitNone(times?: number): void
  /**
   * A barcode that is SEEN but never READ, held for as long as the test needs it: every
   * detection answers a raw hit, but the value alternates, so the two consecutive
   * matches a stable read needs never happen. `emit(value, 1)` cannot do this — its
   * resting frame keeps answering the same value, and the very next cycle decodes it.
   */
  spot(first: string, second: string): void
  /** Drop everything queued and leave the frame empty. */
  clear(): void
  /**
   * Freeze the NEXT `detect()` call mid-await: it answers only once `releaseDetection()`
   * runs. That is the one way to build the real F3 race — a detection cycle that started
   * while the viewfinder was live and comes back after a sheet went up over it.
   */
  holdDetection(): void
  /** Let a held `detect()` answer (a no-op when nothing is held). */
  releaseDetection(): void
  /** One-shot: the NEXT camera acquisition rejects with a `DOMException` of this name. */
  denyCamera(reason?: string): void
  /** Kill the live stream (`stop()` + an `ended` event) so the recovery path runs. */
  stall(): void
  /** Release a camera held by the `__SCAN_LAB_HOLD_CAMERA` boot flag. */
  startCamera(): void
  /** Analytics the flow tracked, in order. */
  readonly events: ScanLabEvent[]
  /**
   * Every distinct state the flow's (and the viewfinder's) data attributes went through,
   * in order — `detection` is one field of it, so a state that only lasts a frame or two
   * (`spotted` on the way to `read`) is still assertable after the fact.
   */
  readonly transitions: ScanLabTransition[]
  /** The flow's current state, read off its root's data attributes. */
  readonly state: ScanLabState | null
  /** Camera acquisitions that actually handed back a stream. */
  readonly streams: number
  /** Detection cycles the fake detector has answered. */
  readonly detections: number
}

declare global {
  interface Window {
    __scanLab?: ScanLab
    /** Boot flag (set via `page.addInitScript`): hold the camera until `startCamera()`. */
    __SCAN_LAB_HOLD_CAMERA?: boolean
    /** Boot flag: make the FIRST acquisition fail with this `DOMException` name. */
    __SCAN_LAB_DENY_CAMERA?: string
  }
}

const CANVAS_WIDTH = 640
const CANVAS_HEIGHT = 480
const CAPTURE_FPS = 30

/**
 * One fake camera. A fresh canvas per acquisition (rather than a second
 * `captureStream()` on a shared one) keeps the streams genuinely independent: `stall()`
 * stops one stream's track, and its draw loop stops with it, without touching the stream
 * the recovery just acquired.
 */
function createFakeCameraStream(): MediaStream {
  const canvas = document.createElement("canvas")
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  const context = canvas.getContext("2d")
  const stream = canvas.captureStream(CAPTURE_FPS)
  let frame = 0
  const draw = () => {
    const [track] = stream.getVideoTracks()
    // A stopped track ends this canvas's loop; nothing else references it.
    if (!track || track.readyState === "ended") return
    frame += 1
    if (context) {
      // A LIT frame on purpose: the loop samples mean luma twice a second and a dark
      // canvas is (correctly) read as low light, which flips the pill to "Mehr Licht
      // hilft" a beat after the camera starts — a hint the copy scenarios would then race.
      context.fillStyle = "#f4f1ea"
      context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
      // The moving bar is what makes the canvas "change": a static canvas produces no
      // new frames, the <video> never advances, and `requestVideoFrameCallback` (which
      // is what actually drives the detection loop) would never fire.
      context.fillStyle = "#101014"
      context.fillRect((frame * 9) % (CANVAS_WIDTH - 60), 180, 60, 120)
    }
    requestAnimationFrame(draw)
  }
  draw()
  return stream
}

function readFlowState(): ScanLabState | null {
  const root = document.querySelector("[data-scan-flow]")
  if (!root) return null
  const viewfinder = root.querySelector("[data-scan-detection]")
  return {
    step: root.getAttribute("data-scan-step") ?? "",
    auxiliary: root.getAttribute("data-scan-auxiliary") ?? "",
    camera: root.getAttribute("data-scan-camera") ?? "",
    cameraReason: root.getAttribute("data-scan-camera-reason") ?? "",
    saveOpen: root.getAttribute("data-scan-save-open") === "true",
    epoch: Number(root.getAttribute("data-scan-epoch") ?? "0"),
    detection: viewfinder?.getAttribute("data-scan-detection") ?? "",
  }
}

type ScanLabInternals = {
  lab: ScanLab
  runtime: ScannerRuntime
  analytics: ScanAnalyticsPort
}

let internals: ScanLabInternals | null = null

function createScanLab(): ScanLabInternals {
  /** Detection results still to be served, oldest first. */
  const queue: ScanLabFrame[] = []
  /**
   * What the camera sees once the queue runs dry. A real bottle does not vanish after two
   * frames — it stays in front of the lens until it is moved away, which is exactly what
   * the D6 re-arm (`emitNone`) and the F1 toast loop are about.
   */
  let restingFrame: ScanLabFrame = null
  /** Set by `spot()`: the resting frame cycles through these instead of repeating. */
  let restingCycle: readonly string[] | null = null
  let restingIndex = 0
  let pendingFailure: string | null = null
  /** Armed by `holdDetection()`, consumed by the first `detect()` that reaches it. */
  let detectionGate: Promise<void> | null = null
  let releaseDetectionGate: (() => void) | null = null
  let liveStream: MediaStream | null = null
  let streams = 0
  let detections = 0
  const events: ScanLabEvent[] = []
  const transitions: ScanLabTransition[] = []

  let releaseCameraGate: (() => void) | null = null
  const cameraGate =
    typeof window !== "undefined" && window.__SCAN_LAB_HOLD_CAMERA
      ? new Promise<void>((resolve) => {
          releaseCameraGate = resolve
        })
      : null
  if (typeof window !== "undefined" && window.__SCAN_LAB_DENY_CAMERA) {
    pendingFailure = window.__SCAN_LAB_DENY_CAMERA
  }

  const mediaSource = async (): Promise<MediaStream> => {
    if (cameraGate) await cameraGate
    if (pendingFailure) {
      const reason = pendingFailure
      pendingFailure = null
      throw new DOMException(`scan lab: camera unavailable (${reason})`, reason)
    }
    const stream = createFakeCameraStream()
    liveStream = stream
    streams += 1
    return stream
  }

  /** What the lens sees once the queue runs dry — see `restingFrame` / `spot()`. */
  const nextRestingFrame = (): ScanLabFrame => {
    if (!restingCycle) return restingFrame
    const value = restingCycle[restingIndex % restingCycle.length]
    restingIndex += 1
    return value
  }

  const detectorFactory = async (): Promise<ScanBarcodeDetector> => ({
    async detect() {
      if (detectionGate) {
        const gate = detectionGate
        // Consumed by this call only: `holdDetection()` freezes exactly one cycle.
        detectionGate = null
        await gate
      }
      detections += 1
      // Read AFTER the gate, so a barcode put in front of the lens while the cycle was
      // frozen is what the frozen cycle comes back with.
      const frame = queue.length > 0 ? (queue.shift() as ScanLabFrame) : nextRestingFrame()
      if (frame === null) return []
      return [
        {
          rawValue: frame,
          format: frame.length === 8 ? "ean_8" : "ean_13",
          // A quarter of the frame: comfortably inside every "closer / further away"
          // hint threshold, so the pill copy stays on the default hint.
          boundingBox: new DOMRectReadOnly(160, 120, 320, 240),
          cornerPoints: [
            { x: 160, y: 120 },
            { x: 480, y: 120 },
            { x: 480, y: 360 },
            { x: 160, y: 360 },
          ],
        },
      ]
    },
  })

  const lab: ScanLab = {
    emit(value, times = 2) {
      for (let index = 0; index < times; index += 1) queue.push(value)
      restingFrame = value
      restingCycle = null
    },
    emitNone(times = 1) {
      for (let index = 0; index < times; index += 1) queue.push(null)
      restingFrame = null
      restingCycle = null
    },
    spot(first, second) {
      queue.length = 0
      restingFrame = first
      restingCycle = [first, second]
      restingIndex = 0
    },
    clear() {
      queue.length = 0
      restingFrame = null
      restingCycle = null
    },
    holdDetection() {
      if (detectionGate) return
      detectionGate = new Promise<void>((resolve) => {
        releaseDetectionGate = resolve
      })
    },
    releaseDetection() {
      releaseDetectionGate?.()
      releaseDetectionGate = null
    },
    denyCamera(reason = "NotAllowedError") {
      pendingFailure = reason
    },
    stall() {
      const stream = liveStream
      if (!stream) return
      for (const track of stream.getVideoTracks()) {
        track.stop()
        // `stop()` never fires `ended` on its own — the loop listens for that event, and
        // a real camera unplug or an OS-level revoke is what would deliver it.
        track.dispatchEvent(new Event("ended"))
      }
    },
    startCamera() {
      releaseCameraGate?.()
      releaseCameraGate = null
    },
    events,
    transitions,
    get state() {
      return readFlowState()
    },
    get streams() {
      return streams
    },
    get detections() {
      return detections
    },
  }

  const analytics: ScanAnalyticsPort = {
    track(name, payload) {
      events.push({ name, payload, t: performance.now() })
    },
  }

  // Timestamped state history, so a spec can assert *when* a transition happened (the
  // 400ms decode-confirm window) instead of racing a 400ms-visible pill.
  const recordTransition = () => {
    const next = readFlowState()
    if (!next) return
    const previous = transitions[transitions.length - 1]
    if (
      previous &&
      previous.step === next.step &&
      previous.auxiliary === next.auxiliary &&
      previous.camera === next.camera &&
      previous.cameraReason === next.cameraReason &&
      previous.saveOpen === next.saveOpen &&
      previous.epoch === next.epoch &&
      previous.detection === next.detection
    ) {
      return
    }
    transitions.push({ ...next, t: performance.now() })
  }
  const observer = new MutationObserver(recordTransition)
  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: [
      "data-scan-step",
      "data-scan-auxiliary",
      "data-scan-camera",
      "data-scan-camera-reason",
      "data-scan-save-open",
      "data-scan-epoch",
      "data-scan-detection",
    ],
  })

  return { lab, runtime: { mediaSource, detectorFactory }, analytics }
}

function ensureScanLab(): ScanLabInternals {
  if (internals) return internals
  const created = createScanLab()
  internals = created
  window.__scanLab = created.lab
  // The first paint has already happened by the time this runs, so seed the history with
  // the initial state the observer itself will never see a mutation for.
  window.requestAnimationFrame(() => {
    const initial = created.lab.state
    if (initial && created.lab.transitions.length === 0) {
      created.lab.transitions.push({ ...initial, t: performance.now() })
    }
  })
  return created
}

export function ScanLabClient() {
  const harness = useMemo(() => (typeof window === "undefined" ? null : ensureScanLab()), [])

  return (
    <ToastProvider>
      <main className="min-h-dvh bg-background py-4">
        <ScanFlow analytics={harness?.analytics} scannerRuntime={harness?.runtime} />
      </main>
    </ToastProvider>
  )
}
