import type { ScanSearchReason } from "@/components/scan/scan-search-sheet"
import type { ScanUnavailableReason } from "@/components/scan/scanner"

import type { ScanSavedStatePayload } from "./saved-state"
import type {
  ScanPendingSubmissionResult,
  ScanResolveResult,
  ScanResolvedVerdictResult,
  ScanUnknownProductResult,
} from "./types"

/**
 * The whole `/scan` client state machine as one pure reducer, so the transitions can be
 * tested without a camera, a DOM or a network — and so the guards that used to live in
 * scattered refs inside `ScanFlow` become structural instead of conventional.
 *
 * Two of those guards are the point of the extraction:
 * - Every async action carries the token of the request it belongs to, and is a no-op
 *   unless that request is still the active one. A resolve or submit whose sheet the user
 *   already dismissed can therefore no longer repaint the step, re-open a sheet over a
 *   live viewfinder, or clear a newer request's `submitting` flag (finding F4).
 * - `saved_state_changed` carries the product it belongs to, so a save that completes
 *   after the user scanned something else cannot land on the new product's card (F5).
 */

export type ScanFlowStep =
  | { kind: "scanning" }
  | { kind: "resolving" }
  | { kind: "result"; result: ScanResolvedVerdictResult }
  | { kind: "unknown"; unknown: ScanUnknownProductResult }
  | { kind: "pending"; pending: ScanPendingSubmissionResult }

/**
 * `unavailable` is "we never got a stream" (permission, no device, insecure context);
 * `stalled` is "we had one and it died" (track ended/muted, restored from bfcache). They
 * stay distinct because only the second one can be recovered by re-acquiring silently.
 */
export type ScanCameraState =
  | { status: "live" }
  | { status: "unavailable"; reason: ScanUnavailableReason }
  | { status: "stalled" }

export type ScanFlowState = {
  step: ScanFlowStep
  /** Sheets that open over a still-live scanner without changing the step. */
  auxiliary: "none" | "search" | "wishlist"
  /**
   * How the search sheet was last opened. Kept as its own field rather than folded into
   * `auxiliary` so every existing `auxiliary` check (and the `data-scan-auxiliary`
   * attribute the Playwright spec reads) stays a plain string comparison. Only the
   * sheet's header depends on it; the search behind it is the same either way.
   */
  searchReason: ScanSearchReason
  saveOpen: boolean
  camera: ScanCameraState
  submitting: boolean
  submitError: string | null
  /** Bumped on every return to scanning; drives the `Scanner`'s `sessionEpoch`. */
  epoch: number
  activeRequest: { kind: "resolve" | "submit"; token: number } | null
}

export type ScanFlowAction =
  | { type: "resolve_started"; token: number; showResolvingImmediately: boolean }
  | { type: "resolving_sheet_due"; token: number }
  | { type: "resolved"; token: number; result: ScanResolveResult }
  | { type: "resolve_failed"; token: number }
  | { type: "submit_started"; token: number }
  | { type: "submitted"; token: number; pending: ScanPendingSubmissionResult }
  | { type: "submit_failed"; token: number; error: string }
  | { type: "return_to_scanning" }
  | { type: "auxiliary_opened"; sheet: "search" | "wishlist"; searchReason?: ScanSearchReason }
  | { type: "auxiliary_closed" }
  | { type: "save_sheet_toggled"; open: boolean }
  | { type: "saved_state_changed"; productId: string; savedState: ScanSavedStatePayload }
  | { type: "camera_unavailable"; reason: ScanUnavailableReason }
  | { type: "camera_stalled" }
  | { type: "camera_retry" }
  | { type: "camera_live" }

export const initialScanFlowState: ScanFlowState = {
  step: { kind: "scanning" },
  auxiliary: "none",
  searchReason: "manual",
  saveOpen: false,
  camera: { status: "live" },
  submitting: false,
  submitError: null,
  epoch: 0,
  activeRequest: null,
}

/**
 * Whether `action`'s token still owns the in-flight slot. The request KIND is compared
 * too, so a resolve response can never settle a submit (or vice versa) just because two
 * independently-counted guards handed out the same number.
 */
function owns(state: ScanFlowState, kind: "resolve" | "submit", token: number): boolean {
  return state.activeRequest?.kind === kind && state.activeRequest.token === token
}

export function scanFlowReducer(state: ScanFlowState, action: ScanFlowAction): ScanFlowState {
  switch (action.type) {
    case "resolve_started":
      return {
        ...state,
        // A camera decode keeps the viewfinder (and its green confirm state) for the
        // 400ms window and only then raises the skeleton via `resolving_sheet_due`;
        // every other entry point shows it at once.
        step: action.showResolvingImmediately ? { kind: "resolving" } : state.step,
        // A resolve takes over the in-flight slot, so any submit that was still running
        // is structurally dead from here on and its terminal action will be dropped.
        // Clearing the busy flag with it is what keeps the `already_in_catalog` chain
        // (submit -> resolve) from leaving `submitting` stuck true forever.
        submitting: false,
        submitError: null,
        activeRequest: { kind: "resolve", token: action.token },
      }

    case "resolving_sheet_due":
      if (!owns(state, "resolve", action.token)) return state
      return { ...state, step: { kind: "resolving" } }

    case "resolved": {
      if (!owns(state, "resolve", action.token)) return state
      return { ...state, step: stepForResult(action.result), activeRequest: null }
    }

    case "resolve_failed":
      if (!owns(state, "resolve", action.token)) return state
      // Deliberately does NOT return to scanning: the component toasts first and then
      // dispatches `return_to_scanning`, mirroring today's order. Settling the request
      // here is what keeps a stale second failure from toasting again (F1's toast loop).
      return { ...state, activeRequest: null }

    case "submit_started":
      return {
        ...state,
        submitting: true,
        submitError: null,
        activeRequest: { kind: "submit", token: action.token },
      }

    case "submitted":
      if (!owns(state, "submit", action.token)) return state
      return {
        ...state,
        step: { kind: "pending", pending: action.pending },
        submitting: false,
        submitError: null,
        activeRequest: null,
      }

    case "submit_failed":
      if (!owns(state, "submit", action.token)) return state
      // The unknown sheet stays open so the user can correct and retry (F17).
      return {
        ...state,
        submitting: false,
        submitError: action.error,
        activeRequest: null,
      }

    case "return_to_scanning":
      // The single way back. `submitting` is cleared here because a submission the user
      // dismissed mid-flight has its terminal action dropped by the token guard, so
      // nothing else would ever unstick the busy flag.
      return {
        ...state,
        step: { kind: "scanning" },
        saveOpen: false,
        submitting: false,
        submitError: null,
        activeRequest: null,
        epoch: state.epoch + 1,
      }

    case "auxiliary_opened":
      // Can't happen today (both triggers are only reachable on the scanning step); kept
      // as an invariant so a search sheet can never hide behind a result sheet.
      if (state.step.kind !== "scanning") return state
      return {
        ...state,
        auxiliary: action.sheet,
        // A reopen with no stated reason keeps the deliberate one: only the timeout and
        // the camera failure open this sheet on the user's behalf, and both say so.
        searchReason:
          action.sheet === "search" ? (action.searchReason ?? "manual") : state.searchReason,
      }

    case "auxiliary_closed":
      return { ...state, auxiliary: "none" }

    case "save_sheet_toggled":
      return { ...state, saveOpen: action.open }

    case "saved_state_changed":
      // F5: the completion must name the product it belongs to. A save that resolves
      // after the user scanned something else is simply dropped.
      if (state.step.kind !== "result") return state
      if (state.step.result.product.productId !== action.productId) return state
      return {
        ...state,
        step: { kind: "result", result: { ...state.step.result, savedState: action.savedState } },
      }

    case "camera_unavailable":
      return { ...state, camera: { status: "unavailable", reason: action.reason } }

    case "camera_stalled":
      return { ...state, camera: { status: "stalled" } }

    case "camera_retry":
    case "camera_live":
      return { ...state, camera: { status: "live" } }
  }
}

function stepForResult(result: ScanResolveResult): ScanFlowStep {
  if (result.kind === "unknown_product") return { kind: "unknown", unknown: result }
  if (result.kind === "pending_submission") return { kind: "pending", pending: result }
  return { kind: "result", result }
}

/** A step sheet covers the viewfinder. Auxiliary sheets do not change the step. */
export function isSheetOpen(state: ScanFlowState): boolean {
  return state.step.kind !== "scanning"
}

/**
 * Any open surface pauses the DETECTION LOOP (never the camera stream): decoding behind
 * a sheet burns battery on frames nobody can aim, and a read that lands there would be
 * discarded anyway.
 */
export function isDetectionPaused(state: ScanFlowState): boolean {
  return isSheetOpen(state) || state.auxiliary !== "none" || state.saveOpen
}
