import assert from "node:assert/strict"
import test from "node:test"

import {
  SCAN_CONFIRM_LABEL,
  SCAN_HINT_DEFAULT,
  SCAN_HINT_MORE_LIGHT,
  SCAN_HINT_SPOTTED,
} from "../src/lib/scan/guidance"

import {
  BOX_MOVE_TOLERANCE,
  INITIAL_VIEWFINDER_ANNOUNCEMENT,
  REARM_EMPTY_DETECTIONS,
  detectionEventForPauseChange,
  deriveViewfinderPresentation,
  isSameDetectionState,
  mapBoxToCover,
  nextDetectionState,
  nextViewfinderAnnouncement,
  normalizeDetectionBox,
  unrotateDetectionBox,
  type ScanDetectionState,
  type ViewfinderAnnouncementState,
} from "../src/lib/scan/scanner-session"

/**
 * The pure half of the viewfinder-feedback seam (plan 2026-09-05, Task 1): what the
 * detection loop reports to the UI, and where the reported box lands on screen. None of
 * it touches the detection lifecycle — these helpers only translate what the loop
 * already knows into something the viewfinder can draw.
 */

// --- normalizeDetectionBox --------------------------------------------------

test("normalizeDetectionBox: a quarter-frame box becomes 0..1 fractions of the frame", () => {
  const box = normalizeDetectionBox({ x: 160, y: 120, width: 320, height: 240 }, 640, 480)
  assert.deepEqual(box, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 })
})

test("normalizeDetectionBox: a box hanging over the frame edge is clamped into 0..1", () => {
  const box = normalizeDetectionBox({ x: -40, y: 400, width: 720, height: 200 }, 640, 480)
  assert.deepEqual(box, { x: 0, y: 400 / 480, width: 1, height: 1 - 400 / 480 })
})

test("normalizeDetectionBox: a frame with no intrinsic size yields a zero box", () => {
  assert.deepEqual(normalizeDetectionBox({ x: 10, y: 10, width: 10, height: 10 }, 0, 0), {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  })
})

// --- unrotateDetectionBox ---------------------------------------------------

test("unrotateDetectionBox: maps a box detected in the 90°-rotated retry frame back to the video", () => {
  // Video 640×480 -> rotated canvas 480×640. The video box {100,50,200,80} lands at
  // {350,100,80,200} in canvas coordinates (cx = videoHeight - y, cy = x).
  assert.deepEqual(unrotateDetectionBox({ x: 350, y: 100, width: 80, height: 200 }, 480), {
    x: 100,
    y: 50,
    width: 200,
    height: 80,
  })
})

test("unrotateDetectionBox: a full-frame rotated box maps back to the full frame", () => {
  assert.deepEqual(unrotateDetectionBox({ x: 0, y: 0, width: 480, height: 640 }, 480), {
    x: 0,
    y: 0,
    width: 640,
    height: 480,
  })
})

// --- mapBoxToCover ----------------------------------------------------------

test("mapBoxToCover: matching aspect ratios need no crop", () => {
  const rect = mapBoxToCover(
    { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    { width: 480, height: 640 },
    { width: 300, height: 400 },
  )
  assert.deepEqual(rect, { left: 75, top: 100, width: 150, height: 200 })
})

test("mapBoxToCover: a portrait video in a 3:4 element crops top and bottom", () => {
  // 480×800 scaled by max(300/480, 400/800) = 0.625 -> 300×500, so 50px is cropped
  // off each of the top and bottom.
  const rect = mapBoxToCover(
    { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    { width: 480, height: 800 },
    { width: 300, height: 400 },
  )
  assert.deepEqual(rect, { left: 75, top: 75, width: 150, height: 250 })
})

test("mapBoxToCover: a landscape video crops on the long axis", () => {
  // 1280×720 scaled by max(300/1280, 400/720) = 5/9 -> 711.1×400, cropped left/right.
  const rect = mapBoxToCover(
    { x: 0.5, y: 0, width: 0.25, height: 0.5 },
    { width: 1280, height: 720 },
    { width: 300, height: 400 },
  )
  const scale = 400 / 720
  const displayedWidth = 1280 * scale
  assert.equal(rect.left, (300 - displayedWidth) / 2 + 0.5 * displayedWidth)
  assert.equal(rect.top, 0)
  assert.equal(rect.width, 0.25 * displayedWidth)
  assert.equal(rect.height, 200)
  // The left edge really is inside the element: the crop is what puts it there.
  assert.equal(rect.left, 150)
})

test("mapBoxToCover: an unmeasured video or element yields a zero rect instead of NaN", () => {
  const box = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
  const zero = { left: 0, top: 0, width: 0, height: 0 }
  assert.deepEqual(mapBoxToCover(box, { width: 0, height: 0 }, { width: 300, height: 400 }), zero)
  assert.deepEqual(mapBoxToCover(box, { width: 480, height: 640 }, { width: 0, height: 0 }), zero)
})

// --- nextDetectionState -----------------------------------------------------

const searching: ScanDetectionState = { kind: "searching" }
const boxA = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }
const boxB = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }

test("nextDetectionState: a raw hit spots the barcode", () => {
  assert.deepEqual(nextDetectionState(searching, { kind: "raw", box: boxA }, 0), {
    kind: "spotted",
    box: boxA,
  })
})

test("nextDetectionState: a raw hit follows the barcode while already spotted", () => {
  const previous: ScanDetectionState = { kind: "spotted", box: boxA }
  assert.deepEqual(nextDetectionState(previous, { kind: "raw", box: boxB }, 0), {
    kind: "spotted",
    box: boxB,
  })
})

test("nextDetectionState: an accepted decode reads the barcode", () => {
  const previous: ScanDetectionState = { kind: "spotted", box: boxA }
  assert.deepEqual(nextDetectionState(previous, { kind: "read", box: boxB }, 0), {
    kind: "read",
    box: boxB,
  })
})

test("nextDetectionState: empty attempts below the re-arm threshold hold the outline", () => {
  const previous: ScanDetectionState = { kind: "spotted", box: boxA }
  for (let streak = 1; streak < REARM_EMPTY_DETECTIONS; streak += 1) {
    assert.deepEqual(nextDetectionState(previous, { kind: "empty" }, streak), previous)
  }
})

test("nextDetectionState: the re-arm threshold clears the outline back to searching", () => {
  const previous: ScanDetectionState = { kind: "spotted", box: boxA }
  assert.deepEqual(
    nextDetectionState(previous, { kind: "empty" }, REARM_EMPTY_DETECTIONS),
    searching,
  )
})

test("nextDetectionState: a read outline is cleared by the same re-arm streak", () => {
  const previous: ScanDetectionState = { kind: "read", box: boxA }
  assert.deepEqual(nextDetectionState(previous, { kind: "empty" }, 1), previous)
  assert.deepEqual(
    nextDetectionState(previous, { kind: "empty" }, REARM_EMPTY_DETECTIONS),
    searching,
  )
})

test("nextDetectionState: a custom re-arm threshold is honoured", () => {
  const previous: ScanDetectionState = { kind: "spotted", box: boxA }
  assert.deepEqual(nextDetectionState(previous, { kind: "empty" }, 1, 1), searching)
})

test("nextDetectionState: an attempt restart always returns to searching", () => {
  const previous: ScanDetectionState = { kind: "read", box: boxA }
  assert.deepEqual(nextDetectionState(previous, { kind: "restart" }, 0), searching)
})

// --- isSameDetectionState ---------------------------------------------------

test("isSameDetectionState: two searching states are the same", () => {
  assert.equal(isSameDetectionState(searching, { kind: "searching" }), true)
})

test("isSameDetectionState: a different kind is a change", () => {
  assert.equal(isSameDetectionState(searching, { kind: "spotted", box: boxA }), false)
  assert.equal(
    isSameDetectionState({ kind: "spotted", box: boxA }, { kind: "read", box: boxA }),
    false,
  )
})

test("isSameDetectionState: jitter below the half-percent tolerance is not a change", () => {
  const jittered = { x: 0.1015, y: 0.0988, width: 0.2, height: 0.2 }
  assert.equal(
    isSameDetectionState({ kind: "spotted", box: boxA }, { kind: "spotted", box: jittered }),
    true,
  )
})

test("isSameDetectionState: a move past the tolerance is a change", () => {
  const moved = { x: 0.109, y: 0.1, width: 0.2, height: 0.2 }
  assert.equal(
    isSameDetectionState({ kind: "spotted", box: boxA }, { kind: "spotted", box: moved }),
    false,
  )
})

test("isSameDetectionState: a hair's move never counts, wherever in the frame it lands", () => {
  // The old rounding-bucket comparison called this a move whenever the pair happened to
  // straddle a bucket edge — 0.00002 of the frame, roughly a hundredth of a millimetre
  // on screen, redrawing the outline for nothing.
  const before = { x: 0.00249, y: 0.00249, width: 0.2, height: 0.2 }
  const after = { x: 0.00251, y: 0.00251, width: 0.2, height: 0.2 }
  assert.equal(
    isSameDetectionState({ kind: "spotted", box: before }, { kind: "spotted", box: after }),
    true,
  )
})

test("isSameDetectionState: a slow drift is reported once it has really accumulated", () => {
  // Each step is far under the tolerance, but every comparison is against the box that
  // was LAST REPORTED — so the drift adds up instead of being ignored forever.
  const reported: ScanDetectionState = { kind: "spotted", box: boxA }
  let x = boxA.x
  let steps = 0
  while (isSameDetectionState(reported, { kind: "spotted", box: { ...boxA, x } })) {
    x += 0.002
    steps += 1
    assert.ok(steps <= 10, "a steady drift was never reported")
  }

  assert.ok(x - boxA.x > BOX_MOVE_TOLERANCE)
  assert.equal(steps, 3)
})

test("isSameDetectionState: a real move is a change", () => {
  assert.equal(
    isSameDetectionState({ kind: "spotted", box: boxA }, { kind: "spotted", box: boxB }),
    false,
  )
})

// --- deriveViewfinderPresentation -------------------------------------------

test("deriveViewfinderPresentation: a spotted barcode is drawn where the loop saw it", () => {
  const presentation = deriveViewfinderPresentation({
    detection: { kind: "spotted", box: boxA },
    confirmBox: null,
    confirmActive: false,
    detectionPaused: false,
  })

  assert.equal(presentation.visual, "spotted")
  assert.deepEqual(presentation.outlineBox, boxA)
  assert.equal(presentation.frozen, false)
})

test("deriveViewfinderPresentation: searching draws no outline at all", () => {
  const presentation = deriveViewfinderPresentation({
    detection: searching,
    confirmBox: null,
    confirmActive: false,
    detectionPaused: false,
  })

  assert.equal(presentation.visual, "searching")
  assert.equal(presentation.outlineBox, null)
})

test("deriveViewfinderPresentation: the confirm window holds the read look over a fresh spot", () => {
  // The bottle has not moved, so the loop keeps reporting raw hits behind the confirm.
  const presentation = deriveViewfinderPresentation({
    detection: { kind: "spotted", box: boxA },
    confirmBox: boxA,
    confirmActive: true,
    detectionPaused: false,
  })

  assert.equal(presentation.visual, "read")
})

test("deriveViewfinderPresentation: a sheet over a spotted barcode goes static searching", () => {
  const presentation = deriveViewfinderPresentation({
    detection: { kind: "spotted", box: boxA },
    confirmBox: null,
    confirmActive: false,
    detectionPaused: true,
  })

  // What the loop last saw is stale behind the sheet: no amber "hold still" over a
  // picture nobody can see, and no outline on a barcode that may already be gone.
  assert.equal(presentation.visual, "searching")
  assert.equal(presentation.outlineBox, null)
  assert.equal(presentation.frozen, true)
})

test("deriveViewfinderPresentation: the read confirm survives the sheet rising over it", () => {
  const presentation = deriveViewfinderPresentation({
    detection: { kind: "read", box: boxA },
    confirmBox: boxA,
    confirmActive: true,
    detectionPaused: true,
  })

  assert.equal(presentation.visual, "read")
  assert.deepEqual(presentation.outlineBox, boxA)
  assert.equal(presentation.frozen, false)
})

test("deriveViewfinderPresentation: the confirm window keeps the box the decode was read at", () => {
  // The bottle drifts while the result sheet rises: the loop reports a new, different
  // box behind the confirm — the green outline must not follow it.
  const presentation = deriveViewfinderPresentation({
    detection: { kind: "spotted", box: boxB },
    confirmBox: boxA,
    confirmActive: true,
    detectionPaused: false,
  })

  assert.equal(presentation.visual, "read")
  assert.deepEqual(presentation.outlineBox, boxA)
})

test("deriveViewfinderPresentation: the confirm outline survives the barcode leaving the frame", () => {
  // The user pulls the bottle away the instant it is read: the loop re-arms to
  // `searching`, but the confirm still owes the user the box it decoded.
  const presentation = deriveViewfinderPresentation({
    detection: searching,
    confirmBox: boxA,
    confirmActive: true,
    detectionPaused: false,
  })

  assert.equal(presentation.visual, "read")
  assert.deepEqual(presentation.outlineBox, boxA)
})

// --- nextViewfinderAnnouncement ---------------------------------------------

/** Play a sequence of viewfinder states through the policy and collect what it says. */
function announcements(
  steps: Array<{
    visual: "searching" | "spotted" | "read"
    hint?: typeof SCAN_HINT_DEFAULT | typeof SCAN_HINT_MORE_LIGHT
  }>,
  from: ViewfinderAnnouncementState = INITIAL_VIEWFINDER_ANNOUNCEMENT,
): { spoken: string[]; state: ViewfinderAnnouncementState } {
  let state = from
  const spoken: string[] = []
  for (const step of steps) {
    const next = nextViewfinderAnnouncement(state, {
      visual: step.visual,
      hint: step.hint ?? SCAN_HINT_DEFAULT,
    })
    if (next.announcement !== state.announcement) spoken.push(next.announcement)
    state = next
  }
  return { spoken, state }
}

test("nextViewfinderAnnouncement: the idle hint starts in the region rather than being announced", () => {
  assert.equal(INITIAL_VIEWFINDER_ANNOUNCEMENT.announcement, SCAN_HINT_DEFAULT)

  const { spoken } = announcements([{ visual: "searching" }, { visual: "searching" }])
  assert.deepEqual(spoken, [])
})

test("nextViewfinderAnnouncement: a barcode found and lost again announces once each way", () => {
  const { spoken } = announcements([
    { visual: "spotted" },
    { visual: "searching" },
    { visual: "spotted" },
    { visual: "searching" },
    { visual: "spotted" },
  ])

  // The flicker of a barcode at the edge of readability must not become a metronome.
  assert.deepEqual(spoken, [SCAN_HINT_SPOTTED, SCAN_HINT_DEFAULT])
})

test("nextViewfinderAnnouncement: an accepted decode always announces", () => {
  const { spoken } = announcements([{ visual: "spotted" }, { visual: "read" }])

  assert.deepEqual(spoken, [SCAN_HINT_SPOTTED, SCAN_CONFIRM_LABEL])
})

test("nextViewfinderAnnouncement: a situational hint announces even after the flip budget is spent", () => {
  const { spoken } = announcements([
    { visual: "spotted" },
    { visual: "searching" },
    { visual: "searching", hint: SCAN_HINT_MORE_LIGHT },
  ])

  // It asks the user to do something, so it is never rationed away.
  assert.deepEqual(spoken, [SCAN_HINT_SPOTTED, SCAN_HINT_DEFAULT, SCAN_HINT_MORE_LIGHT])
})

test("nextViewfinderAnnouncement: a fresh attempt re-arms both flips", () => {
  const { state } = announcements([{ visual: "spotted" }, { visual: "searching" }])
  assert.equal(state.spottedAnnounced, true)
  assert.equal(state.searchingAnnounced, true)

  const restarted = announcements([{ visual: "spotted" }], INITIAL_VIEWFINDER_ANNOUNCEMENT)
  assert.deepEqual(restarted.spoken, [SCAN_HINT_SPOTTED])
})

test("nextViewfinderAnnouncement: the mount publish does not spend the searching budget, so a later return-to-idle still announces", () => {
  // Step 1: the very first publish a mounted scanner ever runs — searching + the default
  // hint, which is exactly the text the live region already starts with. Nothing actually
  // changed, so this must not touch the state at all (same reference back).
  const afterMount = nextViewfinderAnnouncement(INITIAL_VIEWFINDER_ANNOUNCEMENT, {
    visual: "searching",
    hint: SCAN_HINT_DEFAULT,
  })
  assert.equal(afterMount, INITIAL_VIEWFINDER_ANNOUNCEMENT)
  assert.equal(afterMount.searchingAnnounced, false)
  assert.equal(afterMount.announcement, SCAN_HINT_DEFAULT)

  // Step 2: the barcode is spotted.
  const afterSpotted = nextViewfinderAnnouncement(afterMount, {
    visual: "spotted",
    hint: SCAN_HINT_DEFAULT,
  })
  assert.equal(afterSpotted.announcement, SCAN_HINT_SPOTTED)
  assert.equal(afterSpotted.spottedAnnounced, true)

  // Step 3: lost again. The searching budget was never spent by the mount publish, so
  // this is the flip that actually announces the return to idle.
  const afterSearchingAgain = nextViewfinderAnnouncement(afterSpotted, {
    visual: "searching",
    hint: SCAN_HINT_DEFAULT,
  })
  assert.equal(afterSearchingAgain.announcement, SCAN_HINT_DEFAULT)
  assert.equal(afterSearchingAgain.searchingAnnounced, true)

  // Step 4: still searching within the same attempt — the budget is spent now, so the
  // live region holds its text instead of being asked to say the same thing twice. This
  // is the state that used to stay stuck on "Barcode gefunden – kurz stillhalten" forever.
  const stillSearching = nextViewfinderAnnouncement(afterSearchingAgain, {
    visual: "searching",
    hint: SCAN_HINT_DEFAULT,
  })
  assert.equal(stillSearching, afterSearchingAgain)
  assert.equal(stillSearching.announcement, SCAN_HINT_DEFAULT)

  // Step 5: an epoch restart re-arms the budget from scratch.
  const restarted = nextViewfinderAnnouncement(INITIAL_VIEWFINDER_ANNOUNCEMENT, {
    visual: "spotted",
    hint: SCAN_HINT_DEFAULT,
  })
  assert.equal(restarted.announcement, SCAN_HINT_SPOTTED)
  assert.equal(restarted.spottedAnnounced, true)
})

// --- detectionEventForPauseChange -------------------------------------------

test("detectionEventForPauseChange: closing the sheet drops what the loop last saw", () => {
  const event = detectionEventForPauseChange(true, false)
  assert.deepEqual(event, { kind: "restart" })

  // ... and a restart is what actually clears the outline.
  assert.deepEqual(
    nextDetectionState({ kind: "spotted", box: boxA }, { kind: "restart" }, 0),
    searching,
  )
})

test("detectionEventForPauseChange: opening the sheet reports nothing", () => {
  // The component already draws the static searching look for as long as the sheet is
  // up; re-reporting would only cost a render.
  assert.equal(detectionEventForPauseChange(false, true), null)
})

test("detectionEventForPauseChange: an unchanged pause state reports nothing", () => {
  assert.equal(detectionEventForPauseChange(false, false), null)
  assert.equal(detectionEventForPauseChange(true, true), null)
})
