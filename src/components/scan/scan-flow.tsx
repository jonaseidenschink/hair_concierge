"use client"

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react"

import { Skeleton } from "@/components/ui/skeleton"
import {
  noOpScanAnalytics,
  scanResultShownInCatalog,
  type ScanAnalyticsPort,
} from "@/lib/scan/scan-analytics"
import {
  initialScanFlowState,
  isDetectionPaused,
  scanFlowReducer,
  type ScanFlowState,
  type ScanFlowStep,
} from "@/lib/scan/scan-flow-state"
import { useLatestRequest } from "@/lib/scan/use-latest-request"
import {
  SCAN_RESOLVING_SUBLINE,
  SCAN_RESOLVING_TITLE,
  SCAN_UNKNOWN_HEADLINE,
} from "@/lib/scan/verdict-labels"
import type { ScanResolveResult, ScanResolvedVerdictResult } from "@/lib/scan/types"
// The app-wide provider is `providers/toast-provider` (mounted in AppRouteProviders);
// `components/ui/toast`'s hook talks to a second, unmounted store and would no-op.
import { useToast } from "@/providers/toast-provider"

import { ScanActionFooter } from "./scan-action-footer"
import { ScanResultCard } from "./scan-result-card"
import { ScanResultSheet } from "./scan-result-sheet"
import { ScanSaveSheet, type ScanSaveCompletion } from "./scan-save-sheet"
import { ScanSearchSheet } from "./scan-search-sheet"
import { ScanUnknownFlow, type ScanSubmissionInput } from "./scan-unknown-flow"
import { ScanWishlistSheet, ScanWishlistTrigger } from "./scan-wishlist-sheet"
import {
  Scanner,
  type ScanDecodedIdentifier,
  type ScannerRuntime,
  type ScanUnavailableReason,
} from "./scanner"

/**
 * Client orchestrator for `/scan` (the route itself is Task 6). Every transition of
 * scanning → resolving → sheet(result | unknown | pending) lives in the pure reducer
 * `scanFlowReducer`; this component only turns events into actions and actions into
 * markup. The guards that used to be scattered refs are now structural: each async
 * request carries a token and the reducer drops a response the user has moved past.
 *
 * The camera keeps running behind an open sheet — that is what "the sheet slides up over
 * the camera" means in the spec, and it makes "Nochmal scannen" instant. Only the
 * detection loop pauses (`isDetectionPaused`), and decodes that still land are ignored.
 */

type ScanIdentifier = { type: "ean"; value: string }

// Mirrors `CONFIRM_DURATION_MS` in scanner.tsx: the sheet waits this long after a camera
// decode so the green "✓ Gelesen – wird geprüft" state is actually visible.
const SCAN_CONFIRM_DELAY_MS = 400

const RESOLVE_ERRORS: Record<string, string> = {
  profile_missing: "Für den Scan brauchen wir zuerst deine Haaranalyse.",
  product_not_found: "Dieses Produkt können wir gerade nicht öffnen.",
  invalid_identifier: "Diese Barcode-Nummer stimmt nicht.",
  rate_limited: "Gerade zu viele Anfragen. Versuch es in einem Moment noch einmal.",
  temporarily_unavailable: "Hat nicht geklappt – versuch's nochmal.",
}
const GENERIC_ERROR = "Hat nicht geklappt – versuch's nochmal."

/** Why the viewfinder is replaced by the fallback tile. */
type ScanCameraTileReason = ScanUnavailableReason | "stalled"

const CAMERA_NOTICE_COPY: Record<ScanCameraTileReason, string> = {
  denied: "Ohne Kamerazugriff findest du dein Produkt hier über die Suche.",
  no_camera: "Wir finden keine Kamera — nutze so lange die Suche.",
  insecure: "Die Kamera braucht eine sichere Verbindung — nutze so lange die Suche.",
  stalled: "Das Kamerabild ist abgebrochen.",
}

/**
 * `insecure` is the one reason with no retry: nothing the user can do inside the page
 * turns an http:// origin into a secure context, so offering the button would only
 * promise a recovery that cannot happen.
 */
const CAMERA_RETRY_LABEL: Record<ScanCameraTileReason, string | null> = {
  denied: "Kamera erneut versuchen",
  no_camera: "Kamera erneut versuchen",
  insecure: null,
  stalled: "Kamera neu starten",
}

/**
 * `analytics` defaults to the safe no-op port (matches `Stage3ProductsFlow`'s default of
 * `noOpStage3Analytics`) — a bare `<ScanFlow />` never live-tracks. Production wiring
 * happens one layer up in `scan-page-client.tsx`, the thin client boundary that supplies
 * the real consent-aware `scanAnalytics` instance (`/scan/page.tsx` is a Server Component
 * and can't pass a port object as a prop across the RSC boundary itself).
 *
 * `scannerRuntime` is the camera/detector test seam handed straight to `<Scanner>`; the
 * labs harness supplies it, production leaves it undefined.
 */
export function ScanFlow({
  analytics = noOpScanAnalytics,
  scannerRuntime,
}: { analytics?: ScanAnalyticsPort; scannerRuntime?: ScannerRuntime } = {}) {
  const { toast } = useToast()
  const [state, dispatch] = useReducer(scanFlowReducer, initialScanFlowState)
  const requests = useLatestRequest()
  /**
   * Counts "Kamera erneut versuchen" taps. It keys the `<Scanner>` so a retry really
   * re-runs `getUserMedia` (after `onStalled` the loop stops retrying for that camera
   * cycle, so nothing short of a fresh mount recovers), and `> 0` tells the fallback
   * apart from the first failure — see `handleUnavailable`.
   */
  const [cameraRetries, setCameraRetries] = useState(0)

  // Reset at the start of every scanning window (mount + each "Nochmal scannen") so
  // `scan_decoded`'s `ms_to_decode` measures this attempt, not the whole page visit.
  const scanSessionStartRef = useRef(0)
  // The confirm-window timer that raises the resolving skeleton. Stored in a ref so
  // `returnToScanning` and unmount can clear it; a timer that still fires is harmless,
  // because `resolving_sheet_due` carries its request's token.
  const sheetTimerRef = useRef<number | null>(null)
  /**
   * Latest state for the handlers the scanner calls from its frame loop. Synced in an
   * effect rather than during render: those callbacks are stable across renders, so a
   * closure over `state` would read the value from the render that created them.
   *
   * A LAYOUT effect (it only writes a ref — no setState, so the React Compiler rules are
   * satisfied): the scanner's frame loop runs outside React's commit cycle, so a passive
   * effect would leave a window after a commit in which the mirror still describes the
   * previous state and a decode could pass a guard the new state closes.
   */
  const stateRef = useRef<ScanFlowState>(state)
  useLayoutEffect(() => {
    stateRef.current = state
  }, [state])
  /**
   * `stateRef`'s mirror only updates once the effect above runs after a render — a
   * decode that fires a second time before that render (the scanner's frame loop is
   * outside React's commit cycle) would still read the stale `activeRequest: null` and
   * slip through `handleDecoded`'s guard. This ref is set the instant `resolve()` claims
   * a token, so the guard has a synchronous source of truth for "a resolve is in flight"
   * with no such window.
   */
  const resolveInFlightRef = useRef(false)

  const clearSheetTimer = useCallback(() => {
    if (sheetTimerRef.current !== null) window.clearTimeout(sheetTimerRef.current)
    sheetTimerRef.current = null
  }, [])

  useEffect(() => {
    scanSessionStartRef.current = performance.now()
    analytics.track("scan_started", {})
  }, [analytics])

  // Unmount only: never leave a sheet timer pointing at a dead component.
  useEffect(() => clearSheetTimer, [clearSheetTimer])

  /**
   * The single way back to the scanning step. The camera never stops (the sheet slides up
   * over it), so the scanner's session guards have to be restarted explicitly: the
   * reducer's `epoch` does that (see `Scanner`'s `sessionEpoch`). Without it the same
   * product could never be scanned twice on one page visit and the 3s search-fallback
   * timeout never re-armed.
   */
  const returnToScanning = useCallback(() => {
    clearSheetTimer()
    // Nothing outstanding may write any more. The reducer drops stale *actions* on its
    // own; this is what also stops the `already_in_catalog` chain from starting a resolve
    // for a sheet the user just dismissed.
    requests.invalidateAll()
    resolveInFlightRef.current = false
    dispatch({ type: "return_to_scanning" })
    scanSessionStartRef.current = performance.now()
    analytics.track("scan_started", {})
  }, [analytics, clearSheetTimer, requests])

  const resolve = useCallback(
    async (
      body: { identifier: ScanIdentifier } | { productId: string },
      options?: { sheetDelayMs?: number },
    ) => {
      // Decode-confirm moment (Variante A): a camera decode passes `sheetDelayMs` so the
      // scanner's green "✓ Gelesen – wird geprüft" state stays visible before the sheet slides
      // up — the fetch below still starts immediately, so no time-to-verdict is lost.
      const token = requests.begin()
      resolveInFlightRef.current = true
      dispatch({
        type: "resolve_started",
        token,
        showResolvingImmediately: !options?.sheetDelayMs,
      })
      // Fast success must not cut the confirm moment short: the result waits out the
      // remainder of the window (the sheet timer shows the skeleton at the boundary).
      const confirmUntil =
        options?.sheetDelayMs !== undefined ? performance.now() + options.sheetDelayMs : null
      // The previous request is already stale, so its pending timer is a no-op — dropping
      // it here just keeps one timer per flow instead of one per resolve.
      clearSheetTimer()
      if (options?.sheetDelayMs) {
        sheetTimerRef.current = window.setTimeout(() => {
          sheetTimerRef.current = null
          dispatch({ type: "resolving_sheet_due", token })
        }, options.sheetDelayMs)
      }
      try {
        const response = await fetch("/api/scan/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null
          if (!requests.isCurrent(token)) return
          resolveInFlightRef.current = false
          dispatch({ type: "resolve_failed", token })
          toast({
            title: RESOLVE_ERRORS[payload?.error ?? ""] ?? GENERIC_ERROR,
            variant: "destructive",
          })
          returnToScanning()
          return
        }
        const result = (await response.json()) as ScanResolveResult
        if (confirmUntil !== null) {
          const remaining = confirmUntil - performance.now()
          if (remaining > 0) await new Promise((done) => window.setTimeout(done, remaining))
        }
        if (!requests.isCurrent(token)) return
        resolveInFlightRef.current = false
        if (result.kind === "unknown_product") {
          analytics.track("scan_not_found", {})
        } else if (result.kind !== "pending_submission") {
          analytics.track("scan_result_shown", {
            verdict: resultVerdictLabel(result),
            category: result.product.category,
            inCatalog: scanResultShownInCatalog(result),
            snapshotSource: result.snapshotSource,
          })
        }
        dispatch({ type: "resolved", token, result })
      } catch {
        if (!requests.isCurrent(token)) return
        resolveInFlightRef.current = false
        dispatch({ type: "resolve_failed", token })
        toast({ title: GENERIC_ERROR, variant: "destructive" })
        returnToScanning()
      }
    },
    [analytics, clearSheetTimer, requests, returnToScanning, toast],
  )

  /**
   * Answers the scanner: `true` only when this decode actually started a resolve. A
   * refusal leaves the value unconsumed in the loop's session (see `unfireDetection`), so
   * the same barcode fires again as soon as the flow can take it — the user does not have
   * to move the bottle out of frame and back (controller ruling C3).
   */
  const handleDecoded = useCallback(
    (identifier: ScanDecodedIdentifier): boolean => {
      const current = stateRef.current
      if (isDetectionPaused(current)) return false
      // During the 400ms confirm window the step is still "scanning", so detection keeps
      // running and a second, different EAN could fire. The first one owns the flow.
      // `stateRef.current` only catches up after the next render's passive effect, so a
      // second decode fired before that render would see a stale `activeRequest: null` —
      // `resolveInFlightRef` is set synchronously inside `resolve()` and closes that
      // window.
      if (current.activeRequest || resolveInFlightRef.current) return false
      analytics.track("scan_decoded", {
        msToDecode: Math.round(performance.now() - scanSessionStartRef.current),
        format: identifier.value.length === 8 ? "ean_8" : "ean_13",
      })
      void resolve({ identifier }, { sheetDelayMs: SCAN_CONFIRM_DELAY_MS })
      return true
    },
    [analytics, resolve],
  )

  const handleUnavailable = useCallback(
    (reason: ScanUnavailableReason) => {
      dispatch({ type: "camera_unavailable", reason })
      // Only the FIRST failure pops the search sheet. After a retry the user has already
      // seen (and dismissed) it once — re-opening it over their deliberate retry would
      // just be the pop-open they closed a moment ago.
      if (cameraRetries === 0) {
        dispatch({ type: "auxiliary_opened", sheet: "search", searchReason: "camera" })
      }
      // Pass the real reason through ("denied" | "no_camera" | "insecure") — `trigger`
      // is a plain string in the event map, so the finer-grained value costs nothing.
      analytics.track("scan_fallback_search_used", { trigger: reason })
    },
    [analytics, cameraRetries],
  )

  const retryCamera = useCallback(() => {
    setCameraRetries((count) => count + 1)
    dispatch({ type: "camera_retry" })
  }, [])

  const handleStalled = useCallback(() => {
    dispatch({ type: "camera_stalled" })
  }, [])

  const handleTimeout = useCallback(() => {
    if (isDetectionPaused(stateRef.current)) return
    dispatch({ type: "auxiliary_opened", sheet: "search", searchReason: "timeout" })
    analytics.track("scan_fallback_search_used", { trigger: "timeout" })
  }, [analytics])

  /**
   * F5: a completed save belongs to the product it was STARTED for. The sheet names that
   * product, and every consequence — the state change, `scan_saved`, closing the sheet —
   * happens only while that product is still the one on screen. `stateRef` is read rather
   * than the render's `resultStep`, because the in-flight save closed over the render
   * that started it: that closure still describes product A even after B replaced it.
   */
  const handleSaveCompleted = useCallback(
    ({ productId, savedState }: ScanSaveCompletion) => {
      const current = stateRef.current.step
      if (current.kind !== "result") return
      if (current.result.product.productId !== productId) return
      dispatch({ type: "saved_state_changed", productId, savedState })
      // Only the save direction is `scan_saved`; a removal (savedState -> null) isn't a
      // "save" event.
      if (savedState.state) {
        analytics.track("scan_saved", {
          kind: savedState.state,
          verdict: resultVerdictLabel(current.result),
        })
      }
      dispatch({ type: "save_sheet_toggled", open: false })
    },
    [analytics],
  )

  const openFromProductId = useCallback(
    (productId: string) => {
      // The reducer's `resolve_started` deliberately leaves auxiliary sheets alone, so
      // the search/Merkliste sheet has to be closed before the skeleton goes up.
      dispatch({ type: "auxiliary_closed" })
      void resolve({ productId })
    },
    [resolve],
  )

  const submitUnknown = useCallback(
    async (input: ScanSubmissionInput, identifier: ScanIdentifier) => {
      const token = requests.begin()
      dispatch({ type: "submit_started", token })
      try {
        const response = await fetch("/api/scan/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier, ...input }),
        })
        if (!response.ok) {
          dispatch({ type: "submit_failed", token, error: GENERIC_ERROR })
          return
        }
        const result = (await response.json()) as
          | { kind: "already_in_catalog"; productId: string }
          | { kind: "pending_submission"; submissionId: string; headline: string }
        if (result.kind === "already_in_catalog") {
          // The EAN was catalogued between the scan and the submission — show the real
          // verdict instead of a research receipt for a product we already know. Only if
          // this submission still owns the flow: otherwise the user dismissed the sheet
          // and a resolve would re-open one over the live viewfinder (F4).
          if (!requests.isCurrent(token)) return
          await resolve({ productId: result.productId })
          return
        }
        // The submission exists server-side the moment this response lands, whether or
        // not the user is still looking at the sheet — tracked unconditionally. Only the
        // `submitted` dispatch (which would repaint the step) stays token-guarded.
        analytics.track("scan_submission_created", { category: input.category })
        dispatch({
          type: "submitted",
          token,
          pending: {
            kind: "pending_submission",
            submissionId: result.submissionId,
            headline: result.headline,
            status: "pending_review",
          },
        })
      } catch {
        dispatch({ type: "submit_failed", token, error: GENERIC_ERROR })
      }
    },
    [analytics, requests, resolve],
  )

  const { step } = state
  const sheetOpen = step.kind !== "scanning"
  const resultStep = step.kind === "result" ? step : null
  const cameraTileReason: ScanCameraTileReason | null =
    state.camera.status === "unavailable"
      ? state.camera.reason
      : state.camera.status === "stalled"
        ? "stalled"
        : null

  return (
    <div
      /**
       * Debug surface for the dev-only `/labs/scan` harness and its Playwright spec
       * (`tests/scan-flow.spec.ts`): the reducer's whole observable state as data
       * attributes, so an end-to-end assertion can name a transition instead of guessing
       * it from copy. Cheaper than a debug prop (nothing to thread through, nothing the
       * production caller has to pass) and inert in production — six attributes on one
       * div, no behaviour attached.
       */
      data-scan-flow=""
      data-scan-step={step.kind}
      data-scan-auxiliary={state.auxiliary}
      data-scan-camera={state.camera.status}
      data-scan-camera-reason={cameraTileReason ?? "none"}
      data-scan-save-open={state.saveOpen ? "true" : "false"}
      data-scan-epoch={state.epoch}
      className="mx-auto w-full max-w-[430px] px-3 sm:max-w-[560px] sm:px-5"
    >
      <div className="flex items-center justify-between py-2">
        <h1 className="text-[17px] font-bold text-foreground">Scan</h1>
        <ScanWishlistTrigger
          onClick={() => dispatch({ type: "auxiliary_opened", sheet: "wishlist" })}
        />
      </div>

      {cameraTileReason === null ? (
        <Scanner
          // A retry must re-mount: `useScannerLoop` gives up on a camera cycle once it
          // has reported `onStalled`, so only a fresh mount re-acquires the stream.
          key={cameraRetries}
          active
          detectionPaused={isDetectionPaused(state)}
          sessionEpoch={state.epoch}
          runtime={scannerRuntime}
          onDecoded={handleDecoded}
          onUnavailable={handleUnavailable}
          onTimeout={handleTimeout}
          onStalled={handleStalled}
        />
      ) : (
        <div className="flex aspect-[3/4] w-full flex-col items-center justify-center rounded-2xl bg-muted px-6 text-center">
          <p className="text-sm leading-6 text-muted-foreground">
            {CAMERA_NOTICE_COPY[cameraTileReason]}
          </p>
          {CAMERA_RETRY_LABEL[cameraTileReason] ? (
            <button
              type="button"
              onClick={retryCamera}
              className="mt-4 min-h-[48px] w-auto min-w-[220px] rounded-[12px] border-[1.5px] border-[var(--brand-plum-light)] bg-transparent px-6 text-[15px] font-semibold text-[var(--brand-plum-dark)] transition-colors hover:border-[var(--brand-plum)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-plum)] focus-visible:ring-offset-2"
            >
              {CAMERA_RETRY_LABEL[cameraTileReason]}
            </button>
          ) : null}
        </div>
      )}

      <p className="mt-3 text-center text-sm text-muted-foreground">
        Barcode nicht lesbar?{" "}
        <button
          type="button"
          onClick={() => {
            dispatch({ type: "auxiliary_opened", sheet: "search", searchReason: "manual" })
            analytics.track("scan_fallback_search_used", { trigger: "manual" })
          }}
          className="font-semibold text-[var(--brand-plum)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-plum)] focus-visible:ring-offset-2"
        >
          Produkt suchen
        </button>
      </p>

      <ScanResultSheet
        open={sheetOpen}
        title={sheetTitle(step)}
        onClose={returnToScanning}
        footer={
          resultStep ? (
            <ScanActionFooter
              kind={resultStep.result.kind}
              verdict={resultStep.result.kind === "in_catalog" ? resultStep.result.verdict : null}
              product={resultStep.result.product}
              savedState={resultStep.result.savedState}
              onSave={() => dispatch({ type: "save_sheet_toggled", open: true })}
              onBuy={() =>
                analytics.track("scan_buy_clicked", {
                  verdict: resultVerdictLabel(resultStep.result),
                })
              }
            />
          ) : undefined
        }
      >
        {step.kind === "resolving" ? <ResolvingBody /> : null}
        {resultStep ? (
          <ScanResultCard
            result={resultStep.result}
            onRescan={returnToScanning}
            onOpenAlternative={openFromProductId}
            // An alternative's "Kaufen ↗" reports the verdict of the payload it was
            // offered under — the scanned product's — not the alternative's own pill.
            onBuyAlternative={() =>
              analytics.track("scan_buy_clicked", {
                verdict: resultVerdictLabel(resultStep.result),
              })
            }
          />
        ) : null}
        {step.kind === "unknown" ? (
          <ScanUnknownFlow
            unknown={step.unknown}
            submitting={state.submitting}
            error={state.submitError}
            // The v1 scan surface is EAN-only in both directions (resolve returns the
            // scanned/typed EAN, submit accepts nothing else), so the narrowing is safe.
            onSubmit={(input) =>
              void submitUnknown(input, { type: "ean", value: step.unknown.identifier.value })
            }
          />
        ) : null}
        {step.kind === "pending" ? (
          <PendingBody headline={step.pending.headline} onContinue={returnToScanning} />
        ) : null}
      </ScanResultSheet>

      {resultStep ? (
        <ScanSaveSheet
          open={state.saveOpen && step.kind === "result"}
          productId={resultStep.result.product.productId}
          savedState={resultStep.result.savedState}
          onOpenChange={(open) => dispatch({ type: "save_sheet_toggled", open })}
          onSavedStateChange={handleSaveCompleted}
        />
      ) : null}

      <ScanSearchSheet
        open={state.auxiliary === "search"}
        reason={state.searchReason}
        onOpenChange={(open) =>
          dispatch(
            open
              ? { type: "auxiliary_opened", sheet: "search", searchReason: "manual" }
              : { type: "auxiliary_closed" },
          )
        }
        onSelectProduct={openFromProductId}
        onSubmitIdentifier={(identifier) => {
          dispatch({ type: "auxiliary_closed" })
          void resolve({ identifier })
        }}
      />

      <ScanWishlistSheet
        open={state.auxiliary === "wishlist"}
        onOpenChange={(open) =>
          dispatch(
            open ? { type: "auxiliary_opened", sheet: "wishlist" } : { type: "auxiliary_closed" },
          )
        }
        onOpenProduct={openFromProductId}
        // The Merkliste list carries no verdict of its own; "merkliste" is the surface the
        // click came from. `verdict` is a plain string in the event map, so this is legal
        // and keeps every buy click in one event.
        onBuy={() => analytics.track("scan_buy_clicked", { verdict: "merkliste" })}
      />
    </div>
  )
}

/**
 * The `verdict` analytics property: the fit verdict on `in_catalog`, or the need
 * mode ("not_needed" / "deferred") when the category reached no fit verdict at all.
 */
function resultVerdictLabel(result: ScanResolvedVerdictResult): string {
  return result.kind === "in_catalog" ? result.verdict : result.mode
}

function sheetTitle(step: ScanFlowStep): string {
  switch (step.kind) {
    case "result":
      return step.result.kind === "in_catalog" ? step.result.verdictTitle : step.result.headline
    case "unknown":
      return SCAN_UNKNOWN_HEADLINE
    case "pending":
      return step.pending.headline
    default:
      return "Produkt wird geprüft"
  }
}

function ResolvingBody() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-live="polite">
      <div>
        <p className="text-[17px] font-bold leading-snug">{SCAN_RESOLVING_TITLE}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{SCAN_RESOLVING_SUBLINE}</p>
      </div>
      <div className="flex items-center gap-3">
        <Skeleton className="h-12 w-12 rounded-[10px]" />
        <div className="flex-1">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="mt-2 h-3 w-1/3" />
        </div>
      </div>
      <Skeleton className="h-[72px] w-full rounded-[14px]" />
      <Skeleton className="h-[120px] w-full rounded-[14px]" />
    </div>
  )
}

function PendingBody({ headline, onContinue }: { headline: string; onContinue: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <span aria-hidden="true" className="text-3xl">
        🕐
      </span>
      <h2 className="font-header text-2xl leading-tight text-foreground">{headline}</h2>
      <p className="max-w-[320px] text-sm leading-6 text-[var(--text-sub)]">
        Meist innerhalb von 24 Stunden – wir melden uns im Chat.
      </p>
      <button
        type="button"
        onClick={onContinue}
        className="mt-2 min-h-[48px] w-full rounded-[12px] border-[1.5px] border-[var(--brand-plum-light)] bg-transparent px-6 text-[15px] font-semibold text-[var(--brand-plum-dark)] transition-colors hover:border-[var(--brand-plum)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-plum)] focus-visible:ring-offset-2"
      >
        Weiter scannen
      </button>
    </div>
  )
}
