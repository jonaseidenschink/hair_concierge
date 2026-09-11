import assert from "node:assert/strict"
import test from "node:test"

import type { ScanMaskedVerdictResult } from "../src/lib/scan/masked-alternative"
import {
  initialScanFlowState,
  isDetectionPaused,
  isSheetOpen,
  scanFlowReducer,
  scanRevealAnimates,
  scanRevealedAlternatives,
  type ScanFlowAction,
  type ScanFlowState,
} from "../src/lib/scan/scan-flow-state"
import type {
  ScanAlternativePresentation,
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
    tier: "unknown",
    reveal: { status: "idle" },
    premiumSheet: null,
    categoriesScanned: [],
    consecutiveMismatches: 0,
    proactiveTriggerShown: null,
    activeProactiveTrigger: null,
    zweiScansGleicheKategorie: false,
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

// --- T9: tier signal, one-lifetime reveal, Premium sheet --------------------

/** A free-tier `in_catalog` verdict (T8's masked shape) for `productId`. */
function maskedResult(productId = "p1", freeRevealAvailable = true): ScanMaskedVerdictResult {
  return {
    kind: "in_catalog",
    verdict: "mismatch",
    verdictLabel: "Passt nicht",
    verdictTitle: "Passt nicht zu deinem Haar",
    status: "danger",
    subtitle: "1 von 3 Zielbereichen getroffen",
    evaluatedRole: null,
    evaluatedRoleLabel: null,
    dimensions: [],
    criteria: [],
    coverage: null,
    fitNarrative: null,
    alternatives: [
      {
        verdict: "ideal",
        verdictLabel: "Passt",
        comparison: {
          rows: [{ rowId: "care_weight", label: "Pflegegewicht", state: "match" }],
          summaryScore: 1,
        },
      },
    ],
    product: verdictResult(productId).product,
    snapshotSource: "refined",
    savedState: { state: null, managedByScan: false },
    freeRevealAvailable,
  }
}

const REVEALED: ScanAlternativePresentation[] = [
  {
    productId: "alt-1",
    displayName: "Lab Shampoo Gamma",
    imageUrl: null,
    priceLabel: "9,99 €",
    netContentLabel: null,
    verdict: "ideal",
    verdictLabel: "Passt",
    brand: "Chaarlie Lab",
    purchaseUrl: null,
  },
]

/** The state showing `productId`'s masked verdict, nothing in flight. */
function maskedShown(productId = "p1", freeRevealAvailable = true): ScanFlowState {
  return run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: maskedResult(productId, freeRevealAvailable) },
  )
}

test("scanFlowReducer: a masked verdict proves the free tier, an unmasked one proves premium", () => {
  assert.equal(maskedShown().tier, "free")
  assert.equal(
    run(
      { type: "resolve_started", token: 1, showResolvingImmediately: true },
      { type: "resolved", token: 1, result: { ...maskedResult(), freeRevealAvailable: false } },
    ).tier,
    "free",
  )
  // The premium/flag-off response: the same verdict WITHOUT the masking marker.
  const { freeRevealAvailable: _omitted, ...premiumResult } = maskedResult()
  const premium = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    {
      type: "resolved",
      token: 1,
      result: { ...premiumResult, alternatives: [] } as ScanResolvedVerdictResult,
    },
  )
  assert.equal(premium.tier, "premium")
})

test("scanFlowReducer: a later evidence-free verdict does not unlock a proven free tier", () => {
  const afterMasked = maskedShown()
  const afterNotNeeded = scanFlowReducer(
    scanFlowReducer(afterMasked, {
      type: "resolve_started",
      token: 2,
      showResolvingImmediately: true,
    }),
    { type: "resolved", token: 2, result: verdictResult("p2") },
  )
  assert.equal(afterNotNeeded.tier, "free")
})

test("scanFlowReducer: a successful reveal only lands on the product it was started for", () => {
  const started = scanFlowReducer(maskedShown("p1"), {
    type: "reveal_started",
    productId: "p1",
    silent: false,
    token: 1,
  })
  assert.deepEqual(started.reveal, { status: "pending", productId: "p1", silent: false, token: 1 })

  const revealed = scanFlowReducer(started, {
    type: "reveal_succeeded",
    productId: "p1",
    alternatives: REVEALED,
    silent: false,
    token: 1,
  })
  assert.deepEqual(revealed.reveal, {
    status: "revealed",
    productId: "p1",
    alternatives: REVEALED,
    silent: false,
    token: 1,
  })
  assert.deepEqual(scanRevealedAlternatives(revealed), REVEALED)
  assert.equal(scanRevealAnimates(revealed), true)

  // The same response, arriving after the user scanned something else: dropped whole.
  const moved = scanFlowReducer(
    scanFlowReducer(started, { type: "resolve_started", token: 2, showResolvingImmediately: true }),
    { type: "resolved", token: 2, result: maskedResult("p2") },
  )
  const late = scanFlowReducer(moved, {
    type: "reveal_succeeded",
    productId: "p1",
    alternatives: REVEALED,
    silent: false,
    token: 1,
  })
  assert.equal(late, moved)
  assert.equal(scanRevealedAlternatives(late), null)
  assert.equal(scanRevealAnimates(late), false)
})

test("scanFlowReducer: fix round 1 (F2) — a silent (background) reveal skips the unblur", () => {
  const started = scanFlowReducer(maskedShown("p1"), {
    type: "reveal_started",
    productId: "p1",
    silent: true,
    token: 1,
  })
  assert.deepEqual(started.reveal, { status: "pending", productId: "p1", silent: true, token: 1 })

  const revealed = scanFlowReducer(started, {
    type: "reveal_succeeded",
    productId: "p1",
    alternatives: REVEALED,
    silent: true,
    token: 1,
  })
  // The card still renders the full alternatives — only the animation decision differs.
  assert.deepEqual(scanRevealedAlternatives(revealed), REVEALED)
  assert.equal(scanRevealAnimates(revealed), false)
})

test("scanFlowReducer: 409 already_used flips the CTA; an empty list or any other failure only clears the busy flag", () => {
  const started = scanFlowReducer(maskedShown("p1"), {
    type: "reveal_started",
    productId: "p1",
    silent: false,
    token: 1,
  })
  assert.deepEqual(
    scanFlowReducer(started, {
      type: "reveal_failed",
      productId: "p1",
      reason: "already_used",
      token: 1,
    }).reveal,
    { status: "unavailable", productId: "p1" },
  )
  assert.deepEqual(
    scanFlowReducer(started, { type: "reveal_failed", productId: "p1", reason: "error", token: 1 })
      .reveal,
    { status: "idle" },
  )
  // Fix round 1 (F3): a distinct reason from "error" (T8 spends no credit here), but the
  // same `idle` state — the CTA stays exactly as available as it was.
  assert.deepEqual(
    scanFlowReducer(started, { type: "reveal_failed", productId: "p1", reason: "empty", token: 1 })
      .reveal,
    { status: "idle" },
  )
})

test("scanFlowReducer: C2 — a superseded reveal's late failure never erases a newer reveal's success (same product)", () => {
  // The exact PR2 review repro: product A's silent background re-serve (token 1) is still
  // in flight when the user rescans A, which starts a SECOND reveal attempt (token 2) for
  // the same product — e.g. `resolve()`'s own F2 background re-serve firing again for the
  // freshly-resolved masked verdict. The newer call (token 2) succeeds first; the older,
  // now-superseded call (token 1) fails afterwards and must be dropped, not applied.
  const firstStarted = scanFlowReducer(maskedShown("p1"), {
    type: "reveal_started",
    productId: "p1",
    silent: true,
    token: 1,
  })
  const secondStarted = scanFlowReducer(firstStarted, {
    type: "reveal_started",
    productId: "p1",
    silent: true,
    token: 2,
  })
  assert.deepEqual(secondStarted.reveal, {
    status: "pending",
    productId: "p1",
    silent: true,
    token: 2,
  })

  const secondSucceeded = scanFlowReducer(secondStarted, {
    type: "reveal_succeeded",
    productId: "p1",
    alternatives: REVEALED,
    silent: true,
    token: 2,
  })
  assert.deepEqual(secondSucceeded.reveal, {
    status: "revealed",
    productId: "p1",
    alternatives: REVEALED,
    silent: true,
    token: 2,
  })

  // The stale token-1 failure lands after: dropped whole, state unchanged.
  const afterStaleFailure = scanFlowReducer(secondSucceeded, {
    type: "reveal_failed",
    productId: "p1",
    reason: "already_used",
    token: 1,
  })
  assert.equal(afterStaleFailure, secondSucceeded)
  assert.deepEqual(scanRevealedAlternatives(afterStaleFailure), REVEALED)

  // A stale token-1 SUCCESS landing late must be dropped the same way.
  const afterStaleSuccess = scanFlowReducer(secondSucceeded, {
    type: "reveal_succeeded",
    productId: "p1",
    alternatives: [],
    silent: true,
    token: 1,
  })
  assert.equal(afterStaleSuccess, secondSucceeded)
})

test("scanFlowReducer: a new resolve and a return to scanning both drop what the reveal showed", () => {
  const revealed = scanFlowReducer(
    scanFlowReducer(maskedShown("p1"), {
      type: "reveal_started",
      productId: "p1",
      silent: false,
      token: 1,
    }),
    { type: "reveal_succeeded", productId: "p1", alternatives: REVEALED, silent: false, token: 1 },
  )
  assert.deepEqual(
    scanFlowReducer(revealed, { type: "resolve_started", token: 2, showResolvingImmediately: true })
      .reveal,
    { status: "idle" },
  )
  assert.deepEqual(scanFlowReducer(revealed, { type: "return_to_scanning" }).reveal, {
    status: "idle",
  })
})

test("tier_upgraded: a verified purchase unlocks this surface and clears every free-tier pitch", () => {
  // Fix round 1 (F1). `state.tier` is sticky and `router.refresh()` cannot reach it, so the
  // sheet dispatches this after the server verified the purchase. Everything cleared here
  // is a free-tier affordance — the paywall itself and the two cards that pitch it.
  const pitching = scanFlowReducer(
    {
      ...maskedShown(),
      activeProactiveTrigger: "wiederkehrer",
      zweiScansGleicheKategorie: true,
    },
    { type: "premium_sheet_opened", context: { feature: "merkliste", source: "scan:verdict" } },
  )
  assert.equal(pitching.tier, "free")
  assert.notEqual(pitching.premiumSheet, null)

  const unlocked = scanFlowReducer(pitching, { type: "tier_upgraded" })
  assert.equal(unlocked.tier, "premium")
  assert.equal(unlocked.premiumSheet, null)
  assert.equal(unlocked.activeProactiveTrigger, null)
  assert.equal(unlocked.zweiScansGleicheKategorie, false)
  // The verdict on screen is untouched — the purchase changes what is locked, not the scan.
  assert.deepEqual(unlocked.step, pitching.step)

  // And a leftover affordance on that masked verdict can no longer reopen a sheet that is
  // terminal after its own unlock (it would render benefits with no CTA).
  assert.equal(
    scanFlowReducer(unlocked, {
      type: "premium_sheet_opened",
      context: { feature: "empfehlungen", source: "scan:verdict" },
    }).premiumSheet,
    null,
  )
})

test("scanFlowReducer: the Premium sheet opens with its context, closes empty, and pauses detection", () => {
  const opened = scanFlowReducer(maskedShown(), {
    type: "premium_sheet_opened",
    context: { feature: "merkliste", source: "scan:verdict" },
  })
  assert.deepEqual(opened.premiumSheet, { feature: "merkliste", source: "scan:verdict" })
  assert.equal(
    isDetectionPaused({ ...initialScanFlowState, premiumSheet: opened.premiumSheet }),
    true,
  )
  assert.equal(scanFlowReducer(opened, { type: "premium_sheet_closed" }).premiumSheet, null)
  // Returning to the viewfinder can never leave a paywall hanging over it.
  assert.equal(scanFlowReducer(opened, { type: "return_to_scanning" }).premiumSheet, null)
})

// --- T10: trigger-layer session history --------------------------------------

test("resolved: an in_catalog/not_needed verdict appends its category to the scan history", () => {
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: verdictResult("p1") }, // category: shampoo
  )
  assert.deepEqual(state.categoriesScanned, ["shampoo"])
})

test("resolved: an unknown/pending result leaves the category history untouched", () => {
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: unknownResult },
  )
  assert.deepEqual(state.categoriesScanned, [])

  const pendingState = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: pendingResult },
  )
  assert.deepEqual(pendingState.categoriesScanned, [])
})

test("resolved: the category history survives return_to_scanning and accumulates across scans", () => {
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: verdictResult("p1") },
    { type: "return_to_scanning" },
    { type: "resolve_started", token: 2, showResolvingImmediately: true },
    { type: "resolved", token: 2, result: verdictResult("p2") },
  )
  assert.deepEqual(state.categoriesScanned, ["shampoo", "shampoo"])
})

test("resolved: a mismatch verdict increments consecutiveMismatches, any other fit verdict resets it", () => {
  const twoMismatches = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: maskedResult("p1") }, // verdict: mismatch
    { type: "return_to_scanning" },
    { type: "resolve_started", token: 2, showResolvingImmediately: true },
    { type: "resolved", token: 2, result: maskedResult("p2") },
  )
  assert.equal(twoMismatches.consecutiveMismatches, 2)

  const brokenByIdeal = scanFlowReducer(
    run(
      { type: "resolve_started", token: 1, showResolvingImmediately: true },
      { type: "resolved", token: 1, result: maskedResult("p1") },
      { type: "return_to_scanning" },
      { type: "resolve_started", token: 2, showResolvingImmediately: true },
    ),
    { type: "resolved", token: 2, result: { ...maskedResult("p2"), verdict: "ideal" } },
  )
  assert.equal(brokenByIdeal.consecutiveMismatches, 0)
})

test("resolved: not_needed/unknown/pending leave a running mismatch streak untouched, not reset", () => {
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: maskedResult("p1") },
    { type: "return_to_scanning" },
    { type: "resolve_started", token: 2, showResolvingImmediately: true },
    { type: "resolved", token: 2, result: unknownResult },
  )
  assert.equal(state.consecutiveMismatches, 1)
})

/** `maskedResult` with the category overridden — for scanning a 2nd, different category. */
function maskedResultInCategory(
  productId: string,
  category: "shampoo" | "conditioner",
): ScanMaskedVerdictResult {
  const base = maskedResult(productId)
  return {
    ...base,
    product: { ...base.product, category, categoryLabel: category },
  }
}

test("resolved: the trigger-layer decision is derived from tier/sessionNumber, not passed verbatim", () => {
  // Second scan, same category ("shampoo" again) — fires zwei_scans_gleiche_kategorie.
  // Only 1 distinct category so far, so no proactive candidate qualifies yet.
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: verdictResult("p1"), tier: "free" },
    { type: "return_to_scanning" },
    { type: "resolve_started", token: 2, showResolvingImmediately: true },
    { type: "resolved", token: 2, result: verdictResult("p2"), tier: "free" },
  )
  assert.equal(state.zweiScansGleicheKategorie, true)
  assert.equal(state.activeProactiveTrigger, null)
  assert.equal(state.proactiveTriggerShown, null)
})

test("resolved: omitting tier/sessionNumber fails closed to no trigger at all (every pre-T10 call site)", () => {
  const state = scanFlowReducer(resolving(), {
    type: "resolved",
    token: 1,
    result: verdictResult(),
  })
  assert.equal(state.activeProactiveTrigger, null)
  assert.equal(state.zweiScansGleicheKategorie, false)
  assert.equal(state.proactiveTriggerShown, null)
})

test("resolved: a genuinely free session can fire a proactive trigger (Wiederkehrer, session 2)", () => {
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    {
      type: "resolved",
      token: 1,
      result: verdictResult("p1"),
      tier: "free",
      sessionNumber: 2,
    },
  )
  assert.equal(state.activeProactiveTrigger, "wiederkehrer")
  assert.equal(state.proactiveTriggerShown, "wiederkehrer")
})

test("resolved: Wiederkehrer does NOT fire on session 1 or session 3+ (F4)", () => {
  const sessionOne = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: verdictResult("p1"), tier: "free", sessionNumber: 1 },
  )
  assert.equal(sessionOne.activeProactiveTrigger, null)

  const sessionThree = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: verdictResult("p1"), tier: "free", sessionNumber: 3 },
  )
  assert.equal(sessionThree.activeProactiveTrigger, null)
})

test("fatigue: once a proactive trigger has fired, a later resolve's own card is suppressed", () => {
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    {
      type: "resolved",
      token: 1,
      result: verdictResult("p1"),
      tier: "free",
      sessionNumber: 2,
    },
    { type: "return_to_scanning" },
    { type: "resolve_started", token: 2, showResolvingImmediately: true },
    // A second, different category — on its own this would qualify kategorien_luecke —
    // but the session already spent its one proactive pitch on Wiederkehrer.
    {
      type: "resolved",
      token: 2,
      result: maskedResultInCategory("p2", "conditioner"),
      tier: "free",
    },
  )
  assert.equal(state.proactiveTriggerShown, "wiederkehrer")
  assert.equal(state.activeProactiveTrigger, null)
})

// --- F2 (fix round 1): unknown/pending resolves never select nor spend a proactive trigger

test("F2: an unknown_product resolve under would-be-qualifying conditions selects no trigger and leaves the budget unspent", () => {
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    // sessionNumber 2 alone would fire Wiederkehrer for an in_catalog/not_needed result —
    // here the result is `unknown_product`, so no card can ever render for it.
    { type: "resolved", token: 1, result: unknownResult, tier: "free", sessionNumber: 2 },
  )
  assert.equal(state.activeProactiveTrigger, null)
  assert.equal(state.proactiveTriggerShown, null)
})

test("F2: a pending_submission resolve under would-be-qualifying conditions also leaves the budget unspent", () => {
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: pendingResult, tier: "free", sessionNumber: 2 },
  )
  assert.equal(state.activeProactiveTrigger, null)
  assert.equal(state.proactiveTriggerShown, null)
})

test("F2: after an unknown resolve, the NEXT in_catalog resolve can still pitch (budget was never spent)", () => {
  const state = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: unknownResult, tier: "free", sessionNumber: 2 },
    { type: "return_to_scanning" },
    { type: "resolve_started", token: 2, showResolvingImmediately: true },
    { type: "resolved", token: 2, result: verdictResult("p2"), tier: "free", sessionNumber: 2 },
  )
  assert.equal(state.activeProactiveTrigger, "wiederkehrer")
  assert.equal(state.proactiveTriggerShown, "wiederkehrer")
})

test("activeProactiveTrigger and zweiScansGleicheKategorie reset on a new resolve and on return_to_scanning", () => {
  const shown = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: verdictResult("p1"), tier: "free" },
    { type: "return_to_scanning" },
    { type: "resolve_started", token: 2, showResolvingImmediately: true },
    // A 2nd, DIFFERENT category (kategorien_luecke's condition) — no wiederkehrer/frust
    // candidate is qualified here, so this is deterministically the winner.
    {
      type: "resolved",
      token: 2,
      result: maskedResultInCategory("p2", "conditioner"),
      tier: "free",
    },
  )
  assert.equal(shown.activeProactiveTrigger, "kategorien_luecke")
  assert.equal(shown.zweiScansGleicheKategorie, false)

  const afterReturn = scanFlowReducer(shown, { type: "return_to_scanning" })
  assert.equal(afterReturn.activeProactiveTrigger, null)
  assert.equal(afterReturn.zweiScansGleicheKategorie, false)
  // Fatigue persists across the return — it is session-scoped, not per-step.
  assert.equal(afterReturn.proactiveTriggerShown, "kategorien_luecke")

  const midFlightNewResolve = scanFlowReducer(shown, {
    type: "resolve_started",
    token: 3,
    showResolvingImmediately: true,
  })
  assert.equal(midFlightNewResolve.activeProactiveTrigger, null)
  assert.equal(midFlightNewResolve.zweiScansGleicheKategorie, false)
})

// --- F1 (fix round 1): the fatigue budget survives a remount via `fatigue_hydrated` ----

test("fatigue_hydrated: re-seeds an empty budget from a persisted value (simulates a remount)", () => {
  const hydrated = scanFlowReducer(initialScanFlowState, {
    type: "fatigue_hydrated",
    id: "kategorien_luecke",
  })
  assert.equal(hydrated.proactiveTriggerShown, "kategorien_luecke")

  // The persisted budget is now respected by a fresh resolve, exactly like an in-mount
  // fatigue flag would be — the whole point of hydrating before any resolve can land.
  const state = scanFlowReducer(
    scanFlowReducer(hydrated, {
      type: "resolve_started",
      token: 1,
      showResolvingImmediately: true,
    }),
    {
      type: "resolved",
      token: 1,
      result: maskedResultInCategory("p1", "conditioner"),
      tier: "free",
      sessionNumber: 2,
    },
  )
  assert.equal(state.activeProactiveTrigger, null)
  assert.equal(state.proactiveTriggerShown, "kategorien_luecke")
})

test("fatigue_hydrated: null (nothing persisted) leaves the budget open for this mount", () => {
  const state = scanFlowReducer(initialScanFlowState, { type: "fatigue_hydrated", id: null })
  assert.equal(state.proactiveTriggerShown, null)
})

test("fatigue_hydrated: never clobbers a budget already spent this same mount", () => {
  const alreadySpent = run(
    { type: "resolve_started", token: 1, showResolvingImmediately: true },
    { type: "resolved", token: 1, result: verdictResult("p1"), tier: "free", sessionNumber: 2 },
  )
  assert.equal(alreadySpent.proactiveTriggerShown, "wiederkehrer")
  const state = scanFlowReducer(alreadySpent, {
    type: "fatigue_hydrated",
    id: "frust_serie",
  })
  assert.equal(state.proactiveTriggerShown, "wiederkehrer")
})
