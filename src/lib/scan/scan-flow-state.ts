import type { ScanSearchReason } from "@/components/scan/scan-search-sheet"
import type { ScanUnavailableReason } from "@/components/scan/scanner"

import type { PersonalPlanCategory } from "@/lib/personal-plan/products/contracts"
import type { PremiumSheetContext } from "@/lib/premium-sheet/context"

import type { ScanSavedStatePayload } from "./saved-state"
import {
  firesGatedZweiScansGleicheKategorie,
  resolveGatedProactiveScanTrigger,
  type ScanProactiveTriggerId,
  type ScanTriggerGate,
} from "./triggers/trigger-rules"
import type {
  ScanAlternativePresentation,
  ScanPendingSubmissionResult,
  ScanUnknownProductResult,
} from "./types"
import {
  nextScanTierSignal,
  scanTierSignal,
  type ScanClientResolveResult,
  type ScanTierSignal,
  type ScanVerdictResult,
} from "./verdict-access"

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
  | { kind: "result"; result: ScanVerdictResult }
  | { kind: "unknown"; unknown: ScanUnknownProductResult }
  | { kind: "pending"; pending: ScanPendingSubmissionResult }

/**
 * The free tier's one-lifetime reveal (T9), scoped to the product it was started for so a
 * response that lands after the user scanned something else can never unblur the new
 * product's card. `unavailable` is the 409 `already_used` answer — the credit turns out to
 * be spent (a second tab, a reload) — which flips the CTA to the Premium sheet instead of
 * offering a reveal the server will keep refusing.
 *
 * `silent` (fix round 1, F2) tells `pending` and `revealed` apart from an explicit CTA tap:
 * `scan-flow.tsx` also fires this same reveal in the BACKGROUND, unprompted, whenever a
 * masked verdict arrives with the credit already spent — the reveal endpoint is idempotent,
 * so a 200 there means this is the SAME product the credit was spent on (a rescan or a
 * reload), not a fresh reveal. `silent: true` is what tells the card to show that card
 * already sharp instead of playing the 1.2s unblur meant for the moment of "revealing".
 *
 * `token` (PR2 review fix, C2) identifies WHICH reveal attempt is in flight, on top of
 * `ownsResultProduct`'s product-identity guard: the same product can have two overlapping
 * reveal calls (the F2 silent background re-serve, plus a fresh explicit/background attempt
 * from a rescan of that same product before the first call has settled). Product identity
 * alone cannot tell those apart, so an older call's failure could otherwise land after a
 * newer call's success and erase it. `reveal_succeeded`/`reveal_failed` only ever apply
 * when their `token` still matches the CURRENT `pending`/`revealed` state's token — see
 * `ownsRevealToken`.
 */
export type ScanRevealState =
  | { status: "idle" }
  | { status: "pending"; productId: string; silent: boolean; token: number }
  | {
      status: "revealed"
      productId: string
      alternatives: ScanAlternativePresentation[]
      silent: boolean
      token: number
    }
  | { status: "unavailable"; productId: string }

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
  /**
   * What the resolve responses seen so far prove about the caller's tier (T9). Learned
   * from the response SHAPE only (`verdict-access.ts`) — the client never guesses an
   * entitlement — and it outlives the result step, because the Merken bookmark in the
   * scan header stays locked between scans.
   */
  tier: ScanTierSignal
  reveal: ScanRevealState
  /** The stub Premium sheet's opener context, or null while it is closed (T5/T9). */
  premiumSheet: PremiumSheetContext | null
  /**
   * Trigger-layer session history (T10). Kept as raw facts here — the reducer never
   * decides which trigger fires, that stays in the pure `triggers/trigger-rules.ts` lib —
   * but the history has to survive `return_to_scanning`/the `epoch` bump, because the
   * fatigue rule and "two scans, same category" both span the whole app session, not just
   * one scan. `categoriesScanned` keeps every scan (duplicates included) so
   * "already scanned before this scan" is a plain slice, not a recomputation.
   */
  categoriesScanned: PersonalPlanCategory[]
  /** Consecutive "passt nicht" (mismatch) verdicts feeding the Frust-Serie trigger. */
  consecutiveMismatches: number
  /**
   * Which proactive trigger has already been shown this session, or null. Set once and
   * never cleared (not even on `return_to_scanning`) — the fatigue rule is "at most ONE
   * proactive pitch per session", not "one per scan".
   */
  proactiveTriggerShown: ScanProactiveTriggerId | null
  /**
   * The proactive trigger card to show for THE CURRENT result step, or null. Decided by
   * the caller (`scan-flow.tsx`, from the pure `triggers/trigger-rules.ts` lib) at the
   * moment `resolved` dispatches — the reducer only stores the verdict mechanically, same
   * division of labour as `token`. Reset on every new resolve and on `return_to_scanning`
   * (unlike `proactiveTriggerShown`, which persists): a proactive card belongs to the scan
   * that earned it, never lingering onto the next one.
   */
  activeProactiveTrigger: ScanProactiveTriggerId | null
  /** User-initiated gate 2, decided the same way, for the current result step only. */
  zweiScansGleicheKategorie: boolean
}

export type ScanFlowAction =
  | { type: "resolve_started"; token: number; showResolvingImmediately: boolean }
  | { type: "resolving_sheet_due"; token: number }
  | {
      type: "resolved"
      token: number
      result: ScanClientResolveResult
      /**
       * T10: the two leaf inputs the trigger-layer decision needs that the reducer cannot
       * derive from its own history — `tier` (the server-verified signal, gates every
       * trigger; see `scanTriggersEnabled`) and `sessionNumber` (fix round 1, F4: the
       * Wiederkehrer approximation from `triggers/session-marker.ts`'s localStorage record —
       * 1 on a device's first-ever visit). Both optional and default to the fail-closed
       * values (`"premium"`, `1`, which can never equal the required session number 2) so
       * every pre-T10 call site (a plain `{ token, result }`, across the test suites) keeps
       * compiling and firing zero triggers, unchanged.
       */
      tier?: "free" | "premium"
      sessionNumber?: number
    }
  | { type: "resolve_failed"; token: number }
  | { type: "reveal_started"; productId: string; silent: boolean; token: number }
  | {
      type: "reveal_succeeded"
      productId: string
      alternatives: ScanAlternativePresentation[]
      silent: boolean
      token: number
    }
  /**
   * `reason` distinguishes three outcomes that all land the CTA back on `idle`/`unavailable`
   * but mean different things for future analytics (fix round 1, F3): `"already_used"` is
   * the 409 (credit spent elsewhere), `"empty"` is a 200 with nothing eligible (T8 spends NO
   * credit for this), and `"error"` is an actual failure.
   */
  | {
      type: "reveal_failed"
      productId: string
      reason: "already_used" | "empty" | "error"
      token: number
    }
  | { type: "premium_sheet_opened"; context: PremiumSheetContext }
  | { type: "premium_sheet_closed" }
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
  /**
   * Fix round 1 (F1): re-seeds the session-wide fatigue budget from `sessionStorage`,
   * dispatched once from `scan-flow.tsx`'s very first mount effect — before any resolve can
   * land — so a remount (tab away and back) cannot forget an already-spent pitch. `id` is
   * `null` when nothing was persisted (a genuinely fresh session, or a storage read that
   * failed closed).
   */
  | { type: "fatigue_hydrated"; id: ScanProactiveTriggerId | null }

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
  tier: "unknown",
  reveal: { status: "idle" },
  premiumSheet: null,
  categoriesScanned: [],
  consecutiveMismatches: 0,
  proactiveTriggerShown: null,
  activeProactiveTrigger: null,
  zweiScansGleicheKategorie: false,
}

/**
 * Whether `action`'s token still owns the in-flight slot. The request KIND is compared
 * too, so a resolve response can never settle a submit (or vice versa) just because two
 * independently-counted guards handed out the same number.
 */
function owns(state: ScanFlowState, kind: "resolve" | "submit", token: number): boolean {
  return state.activeRequest?.kind === kind && state.activeRequest.token === token
}

/** Whether `productId` is still the product the result step is showing. */
function ownsResultProduct(state: ScanFlowState, productId: string): boolean {
  return state.step.kind === "result" && state.step.result.product.productId === productId
}

/**
 * Whether `token` is still the reveal attempt CURRENTLY tracked in `state.reveal` (fix C2).
 * A newer `reveal_started` overwrites `state.reveal` with its own token before an older
 * call's outcome can arrive, so this is false for any call an in-flight or already-settled
 * newer call has superseded — regardless of the order the two outcomes actually land in.
 */
function ownsRevealToken(state: ScanFlowState, token: number): boolean {
  return state.reveal.status !== "idle" && state.reveal.status !== "unavailable"
    ? state.reveal.token === token
    : false
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
        // A new verdict is on its way: whatever the previous one revealed belongs to a
        // product that is about to leave the screen.
        reveal: { status: "idle" },
        // Same reasoning (T10): a trigger card belongs to the step that earned it, not to
        // whatever comes up while this new resolve is in flight.
        activeProactiveTrigger: null,
        zweiScansGleicheKategorie: false,
      }

    case "resolving_sheet_due":
      if (!owns(state, "resolve", action.token)) return state
      return { ...state, step: { kind: "resolving" } }

    case "resolved": {
      if (!owns(state, "resolve", action.token)) return state
      const categoriesScanned = appendScannedCategory(state.categoriesScanned, action.result)
      const consecutiveMismatches = nextConsecutiveMismatches(
        state.consecutiveMismatches,
        action.result,
      )
      const category = categoryOfResult(action.result)
      const nextStep = stepForResult(action.result)
      const gate: ScanTriggerGate = {
        freemiumScannerFirstEnabled: true,
        tier: action.tier ?? "premium",
      }
      /**
       * Fix round 1 (F2): `unknown`/`pending` steps render neither new card (both are
       * gated on `resultStep` in `scan-flow.tsx`, i.e. exactly `nextStep.kind === "result"`)
       * — evaluating the proactive decision for them anyway would select and RECORD a
       * winner nobody ever sees, silently burning the session's one pitch. Only a genuine
       * result step (`in_catalog`/`not_needed`) may select or spend it.
       */
      const activeProactiveTrigger =
        nextStep.kind === "result"
          ? resolveGatedProactiveScanTrigger(
              gate,
              {
                categoriesScannedThisSession: categoriesScanned,
                verdict: action.result.kind === "in_catalog" ? action.result.verdict : null,
                consecutiveMismatchCount: consecutiveMismatches,
                sessionNumber: action.sessionNumber ?? 1,
              },
              state.proactiveTriggerShown !== null,
            )
          : null
      const zweiScansGleicheKategorie =
        category !== null &&
        firesGatedZweiScansGleicheKategorie(gate, {
          category,
          // BEFORE this scan: `state.categoriesScanned` is the pre-update history.
          categoriesScannedBeforeThisScan: state.categoriesScanned,
        })
      return {
        ...state,
        step: nextStep,
        activeRequest: null,
        tier: nextScanTierSignal(state.tier, scanTierSignal(action.result)),
        categoriesScanned,
        consecutiveMismatches,
        activeProactiveTrigger,
        zweiScansGleicheKategorie,
        // First one wins for the session (fatigue rule) — a later resolve's own decision
        // never overwrites an already-recorded one. `activeProactiveTrigger` is `null` for
        // an unknown/pending step (F2 above), so this line leaves an unspent budget
        // untouched rather than recording a phantom winner.
        proactiveTriggerShown: state.proactiveTriggerShown ?? activeProactiveTrigger,
      }
    }

    case "reveal_started":
      if (!ownsResultProduct(state, action.productId)) return state
      // Always takes over the reveal slot with ITS OWN token, even if another attempt for
      // the same product is already pending — that older call's eventual outcome (fix C2)
      // will fail `ownsRevealToken` once this one lands, and so can never overwrite it.
      return {
        ...state,
        reveal: {
          status: "pending",
          productId: action.productId,
          silent: action.silent,
          token: action.token,
        },
      }

    case "reveal_succeeded":
      // Same product-identity guard as `saved_state_changed` (F5): a reveal that resolves
      // after the user scanned something else must not unblur the new card. The token guard
      // (fix C2) additionally drops a SUPERSEDED call for the SAME product — otherwise a
      // stale success could still land after a newer call has already moved the state on.
      if (!ownsResultProduct(state, action.productId)) return state
      if (!ownsRevealToken(state, action.token)) return state
      return {
        ...state,
        reveal: {
          status: "revealed",
          productId: action.productId,
          alternatives: action.alternatives,
          silent: action.silent,
          token: action.token,
        },
      }

    case "reveal_failed":
      if (!ownsResultProduct(state, action.productId)) return state
      // Fix C2: an older, superseded call's failure must never erase a newer call's
      // (pending or already-succeeded) outcome for the same product — see `ownsRevealToken`.
      if (!ownsRevealToken(state, action.token)) return state
      return {
        ...state,
        reveal:
          action.reason === "already_used"
            ? { status: "unavailable", productId: action.productId }
            : { status: "idle" },
      }

    case "premium_sheet_opened":
      return { ...state, premiumSheet: action.context }

    case "premium_sheet_closed":
      return { ...state, premiumSheet: null }

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
        reveal: { status: "idle" },
        premiumSheet: null,
        // T10: a trigger card belongs to the step that earned it. `proactiveTriggerShown`
        // (the session-wide fatigue flag) deliberately stays untouched here.
        activeProactiveTrigger: null,
        zweiScansGleicheKategorie: false,
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

    case "fatigue_hydrated":
      // Only ever meaningful once, on the very first mount effect, before any resolve can
      // land — guarded anyway so a stray second dispatch can never clobber a budget this
      // same mount has already spent.
      return state.proactiveTriggerShown === null
        ? { ...state, proactiveTriggerShown: action.id }
        : state
  }
}

/**
 * Every category the flow has resolved a verdict for, oldest first. Only `in_catalog` and
 * `not_needed` results carry a `product.category` — `unknown`/`pending` results short-
 * circuit before a category is known, so they leave the history untouched.
 */
function appendScannedCategory(
  history: PersonalPlanCategory[],
  result: ScanClientResolveResult,
): PersonalPlanCategory[] {
  const category = categoryOfResult(result)
  return category === null ? history : [...history, category]
}

/** `null` for `unknown`/`pending`, which short-circuit before a category is known. */
function categoryOfResult(result: ScanClientResolveResult): PersonalPlanCategory | null {
  if (result.kind !== "in_catalog" && result.kind !== "not_needed") return null
  return result.product.category
}

/**
 * Feeds the Frust-Serie trigger (T10): counts CONSECUTIVE "passt nicht" (mismatch)
 * verdicts. Any other concrete fit verdict (ideal/supportive) resets the streak — it
 * proves the run of bad fits broke. `not_needed`/`unknown`/`pending` carry no fit verdict
 * at all, so they deliberately leave the count untouched rather than resetting it: a
 * stray non-fit scan mid-series should not erase the frustration signal.
 */
function nextConsecutiveMismatches(current: number, result: ScanClientResolveResult): number {
  if (result.kind !== "in_catalog") return current
  if (result.verdict === "mismatch") return current + 1
  return 0
}

function stepForResult(result: ScanClientResolveResult): ScanFlowStep {
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
  return (
    isSheetOpen(state) ||
    state.auxiliary !== "none" ||
    state.saveOpen ||
    state.premiumSheet !== null
  )
}

/**
 * The alternatives the result step should render, and how. `revealed` only ever applies
 * to the product the reveal was spent on; every other case falls back to whatever the
 * resolve response itself carried, so a premium (or flag-off) verdict is untouched.
 */
export function scanRevealedAlternatives(
  state: ScanFlowState,
): ScanAlternativePresentation[] | null {
  if (state.step.kind !== "result") return null
  if (state.reveal.status !== "revealed") return null
  if (state.reveal.productId !== state.step.result.product.productId) return null
  return state.reveal.alternatives
}

/**
 * Whether the currently revealed card should play the 1.2s unblur (fix round 1, F2).
 * `false` for the background same-product re-serve (a rescan or a reload replaying a
 * credit already spent on this exact product) — nothing is being "revealed" to the user
 * in that case, so the card should simply already look sharp. `true` for an explicit CTA
 * tap, which is the only moment the animation is meant to mark.
 */
export function scanRevealAnimates(state: ScanFlowState): boolean {
  if (state.step.kind !== "result") return false
  if (state.reveal.status !== "revealed") return false
  if (state.reveal.productId !== state.step.result.product.productId) return false
  return !state.reveal.silent
}
