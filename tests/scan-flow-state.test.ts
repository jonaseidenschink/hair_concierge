import assert from "node:assert/strict"
import test from "node:test"

import {
  initialScanFlowState,
  isDetectionPaused,
  isSheetOpen,
  scanFlowReducer,
  type ScanFlowAction,
  type ScanFlowState,
} from "../src/lib/scan/scan-flow-state"
import type {
  ScanPendingSubmissionResult,
  ScanResolvedVerdictResult,
  ScanUnknownProductResult,
} from "../src/lib/scan/types"

// --- fixtures ---------------------------------------------------------------

function verdictResult(productId = "p1"): ScanResolvedVerdictResult {
  return {
    kind: "not_needed",
    mode: "not_needed",
    status: "neutral",
    headline: "Brauchst du nicht",
    subtitle: "Dein Plan deckt das schon ab.",
    reasons: [],
    dimensions: [],
    coveredBy: [],
    product: {
      productId,
      name: "Repair Shampoo",
      brand: "Olaplex",
      category: "shampoo",
      categoryLabel: "Shampoo",
      imageUrl: null,
      priceLabel: "24,90 €",
      purchaseUrl: null,
    },
    snapshotSource: "refined",
    savedState: { state: null, managedByScan: false },
  }
}

const unknownResult: ScanUnknownProductResult = {
  kind: "unknown_product",
  identifier: { type: "ean", value: "4006381333931" },
  categories: [{ key: "shampoo", label: "Shampoo" }],
}

const pendingResult: ScanPendingSubmissionResult = {
  kind: "pending_submission",
  submissionId: "s1",
  headline: "Wir prüfen das gerade",
  status: "pending_review",
}

/** Apply a sequence of actions from the initial state. */
function run(...actions: ScanFlowAction[]): ScanFlowState {
  return actions.reduce(scanFlowReducer, initialScanFlowState)
}

/** The state with one resolve in flight under `token`, still inside the confirm window. */
function resolving(token = 1): ScanFlowState {
  return run({ type: "resolve_started", token, showResolvingImmediately: true })
}

// --- initial state ----------------------------------------------------------

test("initialScanFlowState: starts scanning, live camera, nothing in flight", () => {
  assert.deepEqual(initialScanFlowState, {
    step: { kind: "scanning" },
    auxiliary: "none",
    searchReason: "manual",
    saveOpen: false,
    camera: { status: "live" },
    submitting: false,
    submitError: null,
    epoch: 0,
    activeRequest: null,
  })
})

test("scanFlowReducer: returns the same state object for an action it ignores", () => {
  const state = initialScanFlowState
  // Stale token against no active request at all.
  assert.equal(
    scanFlowReducer(state, { type: "resolved", token: 7, result: verdictResult() }),
    state,
  )
})

// --- resolve lifecycle ------------------------------------------------------

test("resolve_started: with showResolvingImmediately shows the skeleton at once", () => {
  const state = run({ type: "resolve_started", token: 1, showResolvingImmediately: true })

  assert.deepEqual(state.step, { kind: "resolving" })
  assert.deepEqual(state.activeRequest, { kind: "resolve", token: 1 })
})

test("resolve_started: taking over from a submit clears the busy flag it superseded", () => {
  // The `already_in_catalog` chain: a submit is in flight, its response says the EAN was
  // catalogued meanwhile, and the component chains straight into a resolve. The submit's
  // terminal action is dropped by the token guard, so `resolve_started` is the only place
  // left that can unstick `submitting` — without it the unknown sheet would stay frozen
  // if the chained resolve came back `unknown_product` again.
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: unknownResult },
    { type: "submit_started", token: 2 },
    { type: "resolve_started", token: 3, showResolvingImmediately: true },
  )

  assert.equal(state.submitting, false)
  assert.equal(state.submitError, null)
  assert.deepEqual(state.activeRequest, { kind: "resolve", token: 3 })
})

test("resolve_started: without showResolvingImmediately keeps scanning for the confirm window", () => {
  const state = run({ type: "resolve_started", token: 1, showResolvingImmediately: false })

  // The green "✓ Gelesen – wird geprüft" moment stays visible; the fetch is already running.
  assert.deepEqual(state.step, { kind: "scanning" })
  assert.deepEqual(state.activeRequest, { kind: "resolve", token: 1 })
})

test("resolving_sheet_due: the 400ms timer raises the skeleton for the current request", () => {
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: false },
    { type: "resolving_sheet_due", token: 1 },
  )

  assert.deepEqual(state.step, { kind: "resolving" })
})

test("resolving_sheet_due: a stale timer never raises the skeleton", () => {
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: false },
    { type: "return_to_scanning" },
    { type: "resolving_sheet_due", token: 1 },
  )

  assert.deepEqual(state.step, { kind: "scanning" })
})

test("resolving_sheet_due: cannot replace an already-shown result with the skeleton", () => {
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: false },
    { type: "resolved", token: 1, result: verdictResult() },
    { type: "resolving_sheet_due", token: 1 },
  )

  assert.equal(state.step.kind, "result")
})

test("resolved: an in-catalog/not-needed verdict opens the result sheet", () => {
  const result = verdictResult()
  const state = scanFlowReducer(resolving(), { type: "resolved", token: 1, result })

  assert.deepEqual(state.step, { kind: "result", result })
  assert.equal(state.activeRequest, null)
})

test("resolved: an unknown product opens the unknown sheet", () => {
  const state = scanFlowReducer(resolving(), { type: "resolved", token: 1, result: unknownResult })

  assert.deepEqual(state.step, { kind: "unknown", unknown: unknownResult })
})

test("resolved: an open submission opens the pending sheet", () => {
  const state = scanFlowReducer(resolving(), { type: "resolved", token: 1, result: pendingResult })

  assert.deepEqual(state.step, { kind: "pending", pending: pendingResult })
})

test("resolved: a stale response never repaints a step the user already left (F4)", () => {
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "return_to_scanning" },
    { type: "resolved", token: 1, result: verdictResult() },
  )

  assert.deepEqual(state.step, { kind: "scanning" })
  assert.equal(state.activeRequest, null)
})

test("resolved: a superseded response loses to the newer request", () => {
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolve_started", token: 2, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: verdictResult("old") },
  )

  assert.deepEqual(state.step, { kind: "resolving" })
  assert.deepEqual(state.activeRequest, { kind: "resolve", token: 2 })
})

test("resolve_failed: settles the request but leaves the step to the component's toast", () => {
  const state = scanFlowReducer(resolving(), { type: "resolve_failed", token: 1 })

  // Mirrors today's order: toast first, then an explicit return_to_scanning.
  assert.deepEqual(state.step, { kind: "resolving" })
  assert.equal(state.activeRequest, null)
})

test("resolve_failed: a stale failure is dropped, so no toast storm on a left step (F1)", () => {
  const before = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "return_to_scanning" },
  )

  assert.equal(scanFlowReducer(before, { type: "resolve_failed", token: 1 }), before)
})

// --- submit lifecycle -------------------------------------------------------

/** Unknown sheet open, one submission in flight under `token`. */
function submitting(token = 2): ScanFlowState {
  return run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: unknownResult },
    { type: "submit_started", token },
  )
}

test("submit_started: marks the flow busy and clears a previous error", () => {
  const state = scanFlowReducer(
    { ...submitting(), submitError: "Hat nicht geklappt" },
    { type: "submit_started", token: 3 },
  )

  assert.equal(state.submitting, true)
  assert.equal(state.submitError, null)
  assert.deepEqual(state.activeRequest, { kind: "submit", token: 3 })
})

test("submitted: opens the pending sheet and clears the busy flag", () => {
  const state = scanFlowReducer(submitting(), {
    type: "submitted",
    token: 2,
    pending: pendingResult,
  })

  assert.deepEqual(state.step, { kind: "pending", pending: pendingResult })
  assert.equal(state.submitting, false)
  assert.equal(state.activeRequest, null)
})

test("submitted: a stale submission never re-opens a sheet over the live viewfinder (F4)", () => {
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: unknownResult },
    { type: "submit_started", token: 2 },
    { type: "return_to_scanning" },
    { type: "submitted", token: 2, pending: pendingResult },
  )

  assert.deepEqual(state.step, { kind: "scanning" })
  assert.equal(state.submitting, false)
})

test("submit_failed: keeps the unknown sheet open and shows the error line (F17)", () => {
  const state = scanFlowReducer(submitting(), {
    type: "submit_failed",
    token: 2,
    error: "Hat nicht geklappt – versuch's nochmal.",
  })

  assert.deepEqual(state.step, { kind: "unknown", unknown: unknownResult })
  assert.equal(state.submitting, false)
  assert.equal(state.submitError, "Hat nicht geklappt – versuch's nochmal.")
  assert.equal(state.activeRequest, null)
})

test("submit_failed: a stale failure never paints an error on a step the user left", () => {
  const before = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: unknownResult },
    { type: "submit_started", token: 2 },
    { type: "return_to_scanning" },
  )

  assert.equal(scanFlowReducer(before, { type: "submit_failed", token: 2, error: "x" }), before)
})

test("a resolve action cannot settle a submit request that happens to share its token", () => {
  const state = submitting(2)

  assert.equal(
    scanFlowReducer(state, { type: "resolved", token: 2, result: verdictResult() }),
    state,
  )
  assert.equal(scanFlowReducer(state, { type: "resolve_failed", token: 2 }), state)
})

test("a submit action cannot settle a resolve request that happens to share its token", () => {
  const state = resolving(1)

  assert.equal(
    scanFlowReducer(state, { type: "submitted", token: 1, pending: pendingResult }),
    state,
  )
})

// --- return to scanning -----------------------------------------------------

test("return_to_scanning: resets the sheet stack, the error and the in-flight request", () => {
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: unknownResult },
    { type: "submit_started", token: 2 },
    { type: "submit_failed", token: 2, error: "Hat nicht geklappt" },
    { type: "return_to_scanning" },
  )

  assert.deepEqual(state.step, { kind: "scanning" })
  assert.equal(state.activeRequest, null)
  assert.equal(state.submitError, null)
  assert.equal(state.saveOpen, false)
  assert.equal(state.submitting, false)
})

test("return_to_scanning: bumps the epoch so the Scanner restarts its session", () => {
  const once = run({ type: "return_to_scanning" })
  const twice = scanFlowReducer(once, { type: "return_to_scanning" })

  assert.equal(initialScanFlowState.epoch, 0)
  assert.equal(once.epoch, 1)
  assert.equal(twice.epoch, 2)
})

test("return_to_scanning: leaves the camera state alone", () => {
  const state = run(
    { type: "camera_unavailable", reason: "denied" },
    { type: "return_to_scanning" },
  )

  assert.deepEqual(state.camera, { status: "unavailable", reason: "denied" })
})

// --- auxiliary sheets -------------------------------------------------------

test("auxiliary_opened: opens the search and the wishlist sheet over a live scanner", () => {
  assert.equal(run({ type: "auxiliary_opened", sheet: "search" }).auxiliary, "search")
  assert.equal(run({ type: "auxiliary_opened", sheet: "wishlist" }).auxiliary, "wishlist")
})

test("auxiliary_opened: ignored while a step sheet is already open", () => {
  const before = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: verdictResult() },
  )

  assert.equal(scanFlowReducer(before, { type: "auxiliary_opened", sheet: "search" }), before)
})

/**
 * Only the header of the search sheet depends on this, but it has to be the reason the
 * sheet was ACTUALLY opened with: the 3s timeout pops it while the user is still aiming
 * at a barcode ("Barcode nicht lesbar?"), a deliberate tap does not.
 */
test("auxiliary_opened: the search sheet remembers why it was opened", () => {
  assert.equal(
    run({ type: "auxiliary_opened", sheet: "search", searchReason: "timeout" }).searchReason,
    "timeout",
  )
  assert.equal(
    run({ type: "auxiliary_opened", sheet: "search", searchReason: "camera" }).searchReason,
    "camera",
  )
  // An opening with no stated reason is a deliberate one.
  assert.equal(run({ type: "auxiliary_opened", sheet: "search" }).searchReason, "manual")
})

test("auxiliary_opened: the wishlist sheet never rewrites the search reason", () => {
  const state = run(
    { type: "auxiliary_opened", sheet: "search", searchReason: "timeout" },
    { type: "auxiliary_closed" },
    { type: "auxiliary_opened", sheet: "wishlist" },
  )

  assert.equal(state.auxiliary, "wishlist")
  assert.equal(state.searchReason, "timeout")
})

test("auxiliary_closed: returns to no auxiliary sheet without touching the step", () => {
  const state = run({ type: "auxiliary_opened", sheet: "wishlist" }, { type: "auxiliary_closed" })

  assert.equal(state.auxiliary, "none")
  assert.deepEqual(state.step, { kind: "scanning" })
})

// --- save sheet + saved state ----------------------------------------------

test("save_sheet_toggled: opens and closes the save sheet", () => {
  const opened = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: verdictResult() },
    { type: "save_sheet_toggled", open: true },
  )

  assert.equal(opened.saveOpen, true)
  assert.equal(scanFlowReducer(opened, { type: "save_sheet_toggled", open: false }).saveOpen, false)
})

test("saved_state_changed: updates the shown result's saved state", () => {
  const before = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: verdictResult("p1") },
  )

  const state = scanFlowReducer(before, {
    type: "saved_state_changed",
    productId: "p1",
    savedState: { state: "merkliste", managedByScan: true },
  })

  assert.equal(state.step.kind, "result")
  assert.deepEqual(state.step.kind === "result" ? state.step.result.savedState : null, {
    state: "merkliste",
    managedByScan: true,
  })
})

test("saved_state_changed: a save for product A never lands on product B's card (F5)", () => {
  const before = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: verdictResult("product-b") },
  )

  const state = scanFlowReducer(before, {
    type: "saved_state_changed",
    productId: "product-a",
    savedState: { state: "routine", managedByScan: true },
  })

  assert.equal(state, before)
})

test("saved_state_changed: dropped when no result sheet is open at all", () => {
  const before = initialScanFlowState

  assert.equal(
    scanFlowReducer(before, {
      type: "saved_state_changed",
      productId: "p1",
      savedState: { state: "merkliste", managedByScan: true },
    }),
    before,
  )
})

// --- camera -----------------------------------------------------------------

test("camera_unavailable: records the reason so the tile can explain itself", () => {
  for (const reason of ["denied", "no_camera", "insecure"] as const) {
    assert.deepEqual(run({ type: "camera_unavailable", reason }).camera, {
      status: "unavailable",
      reason,
    })
  }
})

test("camera_stalled: a dead stream is its own state, not an unavailable camera", () => {
  assert.deepEqual(run({ type: "camera_stalled" }).camera, { status: "stalled" })
})

test("camera_retry: puts the camera back live from unavailable and from stalled", () => {
  assert.deepEqual(
    run({ type: "camera_unavailable", reason: "denied" }, { type: "camera_retry" }).camera,
    { status: "live" },
  )
  assert.deepEqual(run({ type: "camera_stalled" }, { type: "camera_retry" }).camera, {
    status: "live",
  })
})

test("camera_live: a recovered stream reports itself live", () => {
  assert.deepEqual(run({ type: "camera_stalled" }, { type: "camera_live" }).camera, {
    status: "live",
  })
})

// --- derived predicates -----------------------------------------------------

test("isSheetOpen: true for every step except scanning", () => {
  assert.equal(isSheetOpen(initialScanFlowState), false)
  assert.equal(isSheetOpen(resolving()), true)
  assert.equal(
    isSheetOpen({ ...initialScanFlowState, step: { kind: "unknown", unknown: unknownResult } }),
    true,
  )
  assert.equal(
    isSheetOpen({ ...initialScanFlowState, step: { kind: "pending", pending: pendingResult } }),
    true,
  )
  assert.equal(
    isSheetOpen({ ...initialScanFlowState, step: { kind: "result", result: verdictResult() } }),
    true,
  )
  // An auxiliary sheet is not a step sheet.
  assert.equal(isSheetOpen({ ...initialScanFlowState, auxiliary: "search" }), false)
})

test("isDetectionPaused: only a bare scanning step with no sheet keeps decoding", () => {
  assert.equal(isDetectionPaused(initialScanFlowState), false)

  assert.equal(isDetectionPaused({ ...initialScanFlowState, auxiliary: "search" }), true)
  assert.equal(isDetectionPaused({ ...initialScanFlowState, auxiliary: "wishlist" }), true)
  assert.equal(isDetectionPaused({ ...initialScanFlowState, saveOpen: true }), true)
  assert.equal(isDetectionPaused(resolving()), true)
  assert.equal(
    isDetectionPaused({
      ...initialScanFlowState,
      step: { kind: "result", result: verdictResult() },
    }),
    true,
  )
  assert.equal(
    isDetectionPaused({
      ...initialScanFlowState,
      step: { kind: "unknown", unknown: unknownResult },
    }),
    true,
  )
  assert.equal(
    isDetectionPaused({
      ...initialScanFlowState,
      step: { kind: "pending", pending: pendingResult },
    }),
    true,
  )
  // Combinations stay paused.
  assert.equal(isDetectionPaused({ ...resolving(), auxiliary: "wishlist", saveOpen: true }), true)
})
