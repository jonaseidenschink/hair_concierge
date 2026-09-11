"use client"

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react"

import { PremiumSheet } from "@/components/premium-sheet/premium-sheet"
import { Skeleton } from "@/components/ui/skeleton"
import type { PremiumSheetContext } from "@/lib/premium-sheet/context"
import {
  noOpScanAnalytics,
  scanResultShownInCatalog,
  type ScanAnalyticsPort,
} from "@/lib/scan/scan-analytics"
import {
  initialScanFlowState,
  isDetectionPaused,
  scanFlowReducer,
  scanRevealAnimates,
  scanRevealedAlternatives,
  type ScanFlowState,
  type ScanFlowStep,
} from "@/lib/scan/scan-flow-state"
import { useLatestRequest } from "@/lib/scan/use-latest-request"
import {
  SCAN_RESOLVING_SUBLINE,
  SCAN_RESOLVING_TITLE,
  SCAN_REVEAL_EMPTY_NOTICE,
  SCAN_UNKNOWN_HEADLINE,
} from "@/lib/scan/verdict-labels"
import {
  isMaskedScanVerdict,
  type ScanClientResolveResult,
  type ScanVerdictResult,
} from "@/lib/scan/verdict-access"
import type { EntitlementTier } from "@/lib/entitlements"
import type { ScanAlternativePresentation } from "@/lib/scan/types"
import {
  createBrowserScanLocalStorage,
  createBrowserScanSessionStorage,
  readScanFatigueBudget,
  recordScanSession,
  writeScanFatigueBudget,
  type ScanTriggerStorage,
} from "@/lib/scan/triggers/session-marker"
import { scanTriggerSheetContext } from "@/lib/scan/triggers/trigger-rules"
// The app-wide provider is `providers/toast-provider` (mounted in AppRouteProviders);
// `components/ui/toast`'s hook talks to a second, unmounted store and would no-op.
import { useToast } from "@/providers/toast-provider"

import { ScanActionFooter } from "./scan-action-footer"
import { ScanResultCard } from "./scan-result-card"
import { ScanResultSheet } from "./scan-result-sheet"
import { ScanSaveSheet, type ScanSaveCompletion } from "./scan-save-sheet"
import { ScanSearchSheet } from "./scan-search-sheet"
import { ScanCategoryRepeatCard, ScanProactiveTriggerCard } from "./scan-trigger-cards"
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

/** Free-tier gates on this surface all open the same sheet (T5 opener contract). */
const SCAN_VERDICT_SOURCE = "scan:verdict"
const MERKLISTE_GATE: PremiumSheetContext = { feature: "merkliste", source: SCAN_VERDICT_SOURCE }
const EMPFEHLUNGEN_GATE: PremiumSheetContext = {
  feature: "empfehlungen",
  source: SCAN_VERDICT_SOURCE,
}

/**
 * T10's user-initiated gate 2 always maps to the same context — resolved once at module
 * scope (mirrors `MERKLISTE_GATE`/`EMPFEHLUNGEN_GATE` above) so the render path never
 * needs to assert away `scanTriggerSheetContext`'s nullable return.
 */
const ZWEI_SCANS_GATE: PremiumSheetContext = requireScanTriggerSheetContext(
  "zwei_scans_gleiche_kategorie",
)

function requireScanTriggerSheetContext(id: Parameters<typeof scanTriggerSheetContext>[0]) {
  const context = scanTriggerSheetContext(id)
  if (!context) throw new Error(`scan trigger "${id}" is missing its sheet context`)
  return context
}

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
 *
 * `tier` (fix round 1, F1) is the SERVER-derived signal — `/scan/page.tsx` loads it from
 * `loadAuthenticatedAppNavigationAccess()`, the same source T3's nav lock markers use,
 * which fails closed to `"premium"` — never a client-side entitlement guess. It is what
 * lets the header Merken bookmark lock from the very first paint, before any verdict has
 * proven the tier from a response shape; `state.tier` (learned from the resolve responses
 * themselves) still takes over independently once it has evidence, so a degraded nav
 * loader can never unlock a free user either. Omitted, it changes nothing: every existing
 * caller (tests, the labs harness without a tier boot flag) keeps today's behaviour.
 *
 * `sessionRecordStorage`/`fatigueStorage` (T10; split in fix round 1, F1) are the trigger
 * layer's two test seams, same idea as `scannerRuntime`: production leaves both undefined
 * (the real `localStorage`/`sessionStorage` adapters are used), tests inject memory stores
 * — pre-seeded to simulate a returning session, or shared across two mounts to prove the
 * fatigue budget survives a remount.
 */
export function ScanFlow({
  analytics = noOpScanAnalytics,
  scannerRuntime,
  tier,
  sessionRecordStorage,
  fatigueStorage,
  merklisteEnabled = false,
  navigate = (href: string) => {
    window.location.href = href
  },
}: {
  analytics?: ScanAnalyticsPort
  scannerRuntime?: ScannerRuntime
  tier?: EntitlementTier
  sessionRecordStorage?: ScanTriggerStorage
  fatigueStorage?: ScanTriggerStorage
  /**
   * T16: the freemium-flag gate for the Merkliste bookmark's count badge + deep-link (and
   * for the „Gemerkt" section it points at — see `RoutinePage`). A server-derived boolean,
   * never a client flag read (`isFreemiumScannerFirstEnabled()` is not Edge/browser-safe) —
   * mirrors how `tier` itself is threaded in. Defaults to `false` so a bare `<ScanFlow />`
   * (Storybook, this file's own test harness) stays on today's plain bookmark, unchanged.
   */
  merklisteEnabled?: boolean
  /**
   * DI seam for the premium bookmark's deep-link (`router.push`, supplied by
   * `ScanPageClient`) — not a bare `useRouter()` call in this component, so this file's
   * hand-rolled test harness (tests/scan-flow-ui.test.tsx, which does not provide a
   * `next/navigation` context) never has to fake one. Defaults to a plain location change,
   * safe for any caller that does not need client-side routing.
   */
  navigate?: (href: string) => void
} = {}) {
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
  /**
   * The Wiederkehrer trigger's "second session" input (T10; fix round 1, F4): set once,
   * from the localStorage session record, on mount — before any resolve can complete — so
   * `resolve()` below always reads a settled value rather than racing the effect. `1` (a
   * device's first-ever visit, which can never equal the required session number 2) is the
   * safe default for SSR, for a premium/flag-off mount that skips the read entirely (F5),
   * and for a storage read that fails.
   */
  const sessionNumberRef = useRef(1)
  /**
   * PR2 review fix (C2): mints a token per `revealAlternatives` call, independent of
   * `requests` (which only arbitrates resolve/submit). Two reveal attempts can legitimately
   * overlap for the SAME product — e.g. the F2 silent background re-serve still in flight
   * when a rescan of that same product starts another one — and product identity alone
   * (`ownsResultProduct`) cannot tell an older call's outcome from a newer one's. See
   * `scan-flow-state.ts`'s `ScanRevealState`/`ownsRevealToken`.
   */
  const revealTokenRef = useRef(0)
  /**
   * PR2 review fix (C3): guards `hydrateFatigueBudget` below so it runs at most once per
   * mount, regardless of which of its two call sites reaches it first.
   */
  const fatigueHydratedRef = useRef(false)
  /**
   * PR5 review fix (Z5): set once `PremiumSheet`'s server-verified `onUnlocked` fires, so
   * the stable `resolve()` callback stops reading the stale mount-time `tier` prop for
   * everything that happens AFTER the purchase. Never set from a client-side guess.
   */
  const tierUpgradedRef = useRef(false)

  const clearSheetTimer = useCallback(() => {
    if (sheetTimerRef.current !== null) window.clearTimeout(sheetTimerRef.current)
    sheetTimerRef.current = null
  }, [])

  useEffect(() => {
    scanSessionStartRef.current = performance.now()
    analytics.track("scan_started", {})
  }, [analytics])

  /**
   * Fix round 1 (F5): both trigger-layer storages are read ONLY once free tier is
   * confirmed, so premium and flag-off users cause zero storage activity, not merely zero
   * rendered surfaces. Guarded by `fatigueHydratedRef` to run at most once per mount.
   *
   * Fix round 1 (F1): also re-seeds the reducer's fatigue budget from `sessionStorage` via
   * `fatigue_hydrated`, before any resolve can land — see that action's doc for why a plain
   * ref cannot do this (the flag lives in reducer state, not just this closure).
   *
   * PR2 review fix (C3): free tier can be established from TWO independent sources — the
   * server-derived `tier` prop (checked by the mount effect below, unchanged from fix round
   * 1) OR a masked resolve response proving it later, when a degraded nav loader defaulted
   * `tier` to `"premium"` (its own fail-closed default) and only the response shape reveals
   * the truth. Before this fix, that second path never hydrated the persisted fatigue
   * budget at all: the mount effect's `tier !== "free"` guard skipped it forever, so a
   * pitch already spent in an earlier mount (persisted to `sessionStorage`) went unread and
   * a second proactive pitch could fire in what is really the same fatigue-budget session.
   * `resolve()`'s success handler below now also calls this, synchronously, BEFORE
   * dispatching `resolved` — the action whose reducer case actually evaluates this verdict's
   * trigger against the budget — so the hydrated value is always in place before it is used.
   */
  const hydrateFatigueBudget = useCallback(() => {
    if (fatigueHydratedRef.current) return
    fatigueHydratedRef.current = true
    sessionNumberRef.current = recordScanSession(
      sessionRecordStorage !== undefined ? sessionRecordStorage : createBrowserScanLocalStorage(),
    )
    const hydratedFatigue = readScanFatigueBudget(
      fatigueStorage !== undefined ? fatigueStorage : createBrowserScanSessionStorage(),
    )
    if (hydratedFatigue) dispatch({ type: "fatigue_hydrated", id: hydratedFatigue })
  }, [fatigueStorage, sessionRecordStorage])

  useEffect(() => {
    if (tier !== "free") return
    hydrateFatigueBudget()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Fix round 1 (F1): the write side of the fatigue budget — persists the session's one
   * spent pitch to `sessionStorage` so a later remount's read above can find it.
   * `state.proactiveTriggerShown` can only ever become non-null once a resolve's own
   * `effectiveTier` (below) was already free (see `resolveGatedProactiveScanTrigger`'s
   * gate), so this needs no additional tier check to satisfy F5.
   */
  useEffect(() => {
    if (state.proactiveTriggerShown === null) return
    writeScanFatigueBudget(
      fatigueStorage !== undefined ? fatigueStorage : createBrowserScanSessionStorage(),
      state.proactiveTriggerShown,
    )
  }, [state.proactiveTriggerShown, fatigueStorage])

  // Unmount only: never leave a sheet timer pointing at a dead component.
  useEffect(() => clearSheetTimer, [clearSheetTimer])

  /**
   * T16: the Merkliste bookmark's premium count badge (`ScanWishlistTrigger`'s `count`
   * prop) — a real `scan_wishlist` listing count, fetched separately, never a client
   * guess. `null` before the first successful load, and on a load failure the badge simply
   * stays absent (or keeps its last known value) rather than showing a wrong number.
   */
  const [wishlistCount, setWishlistCount] = useState<number | null>(null)
  /**
   * PR5 review fix (Z5). The listing and the auto-save race each other: the resolve
   * route defers its `scan_wishlist` insert through `after()`, so the refetch this
   * component fires when a resolve settles can (and on a warm connection routinely does)
   * read the row set from BEFORE that insert and paint a stale count — 0 for the very
   * product the user just scanned.
   *
   * Fixed by counting a UNION instead of a listing length: `confirmedWishlistIdsRef` is
   * what the last successful listing actually returned, `predictedWishlistIdsRef` holds
   * products this session has server-side evidence for (`savedState.state === "merkliste"`
   * on a premium in-catalog resolve — the resolve route predicts exactly that when, and
   * only when, it scheduled the insert) but that no listing has echoed back yet. A
   * prediction is dropped the moment a listing contains it, so the union converges on the
   * server's own truth rather than drifting from it — and no timing guess (a delayed
   * refetch, a retry loop) is needed anywhere.
   */
  const confirmedWishlistIdsRef = useRef<Set<string>>(new Set())
  const predictedWishlistIdsRef = useRef<Set<string>>(new Set())
  const wishlistLoadedRef = useRef(false)

  /** Union size of "what the last listing returned" and "what it has not caught up to yet". */
  const publishWishlistCount = useCallback(() => {
    if (!wishlistLoadedRef.current) return
    const union = new Set(confirmedWishlistIdsRef.current)
    for (const productId of predictedWishlistIdsRef.current) union.add(productId)
    setWishlistCount(union.size)
  }, [])

  const loadWishlistCount = useCallback(async () => {
    try {
      const response = await fetch("/api/scan/wishlist", { cache: "no-store" })
      if (!response.ok) return
      const body = (await response.json()) as { entries?: unknown[] }
      if (!Array.isArray(body.entries)) return
      const confirmed = new Set<string>()
      for (const entry of body.entries) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const productId = (entry as { productId?: unknown }).productId
          if (typeof productId === "string") confirmed.add(productId)
        }
      }
      confirmedWishlistIdsRef.current = confirmed
      // A prediction the listing now carries is no longer a prediction. One it does NOT
      // carry stays pending: either the deferred insert has not committed yet, or it
      // failed (a warning-level, best-effort write) — over-counting by one for the rest of
      // the session is the far smaller lie than dropping the product the user just saved.
      for (const productId of predictedWishlistIdsRef.current) {
        if (confirmed.has(productId)) predictedWishlistIdsRef.current.delete(productId)
      }
      wishlistLoadedRef.current = true
      publishWishlistCount()
    } catch {
      // Best-effort: the badge simply keeps whatever count (or absence) it already had.
    }
  }, [publishWishlistCount])

  /**
   * The resolve route's own answer about where this product now sits (PR5 review fix Z5).
   * `"merkliste"` on a premium in-catalog verdict means a row exists or is being inserted
   * for it right now — server evidence, not a client guess.
   */
  const notePredictedWishlistSave = useCallback(
    (productId: string) => {
      if (confirmedWishlistIdsRef.current.has(productId)) return
      predictedWishlistIdsRef.current.add(productId)
      publishWishlistCount()
    },
    [publishWishlistCount],
  )

  /**
   * Fires once per mount — only when the flag is on AND the tier is known-not-free. The
   * server-derived `tier` prop fails closed to "premium" (same as `merkenLocked` below), so
   * this fires from first paint for a genuinely premium session without waiting for a scan.
   * Flag-off and a `tier="free"` mount cause zero new network activity, matching this
   * task's byte-identity / no-new-free-behavior constraints.
   */
  useEffect(() => {
    if (!merklisteEnabled || tier === "free") return
    void loadWishlistCount()
    // Fix round 1 (F9): `loadWishlistCount` is a `useCallback` with an empty dependency
    // array, so it is referentially stable — listing it here changes nothing about when
    // this effect re-runs, it just removes the need for the disable comment that used to
    // sit here.
  }, [merklisteEnabled, tier, loadWishlistCount])

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

  /**
   * The free tier's one-lifetime reveal (T9), against T8's `POST /api/scan/reveal`. The
   * body carries the SCANNED product's id — masked alternatives have no id to round-trip
   * — and the reducer drops the answer unless that product is still on screen.
   *
   * The three outcomes the endpoint's contract asks the UI to tell apart:
   * - `200` with alternatives → the full card (animated for an explicit tap, already sharp
   *   for the `silent` background re-serve below — fix round 1, F2).
   * - `200` with an empty list → nothing to show and NO credit spent (fix round 1, F3: a
   *   distinct `"empty"` reason, not `"error"` — nothing failed).
   * - `409 already_used` → the credit went to a different product; the CTA becomes the
   *   Premium sheet rather than a button the server will keep refusing.
   *
   * `silent` (fix round 1, F2) is set by `resolve()` below for the BACKGROUND same-product
   * re-serve attempt, never by the user tapping a CTA: it suppresses every toast (a
   * background attempt failing must stay invisible — the masked card's existing gate
   * already covers that state) and marks a success so the card skips the unblur.
   */
  const revealAlternatives = useCallback(
    async (productId: string, options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false
      // Fix C2: this call's own identity, threaded through every action it dispatches, so
      // the reducer can tell its outcome apart from any OTHER reveal call for the same
      // product (e.g. an overlapping F2 background re-serve) rather than trusting whichever
      // one happens to land last.
      revealTokenRef.current += 1
      const token = revealTokenRef.current
      dispatch({ type: "reveal_started", productId, silent, token })
      try {
        const response = await fetch("/api/scan/reveal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId }),
        })
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null
          const alreadyUsed = payload?.error === "already_used"
          dispatch({
            type: "reveal_failed",
            productId,
            reason: alreadyUsed ? "already_used" : "error",
            token,
          })
          if (!alreadyUsed && !silent) toast({ title: GENERIC_ERROR, variant: "destructive" })
          return
        }
        const result = (await response.json()) as {
          alternatives?: ScanAlternativePresentation[]
        }
        const alternatives = result.alternatives ?? []
        if (alternatives.length === 0) {
          dispatch({ type: "reveal_failed", productId, reason: "empty", token })
          if (!silent) toast({ title: SCAN_REVEAL_EMPTY_NOTICE })
          return
        }
        dispatch({ type: "reveal_succeeded", productId, alternatives, silent, token })
      } catch {
        dispatch({ type: "reveal_failed", productId, reason: "error", token })
        if (!silent) toast({ title: GENERIC_ERROR, variant: "destructive" })
      }
    },
    [toast],
  )

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
        const result = (await response.json()) as ScanClientResolveResult
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
        // T10: the trigger layer's own tier gate, computed the same way as `merkenLocked`
        // below (server prop OR this response's own shape) — never a fresh client guess.
        // `stateRef` (not `state`) because `resolve` is not re-created on every render.
        // PR5 review fix (Z5): a SERVER-VERIFIED purchase made during this same mount
        // (`tier_upgraded`, see `handleTierUpgraded`) outranks both signals — the `tier`
        // prop still carries the mount-time "free" until `router.refresh()` re-serves it,
        // and this closure would otherwise keep classifying the buyer's own post-purchase
        // re-resolve as free, skipping every premium consequence below.
        const effectiveTier: EntitlementTier =
          !tierUpgradedRef.current && (tier === "free" || stateRef.current.tier === "free")
            ? "free"
            : "premium"
        // PR2 review fix (C3): the very first moment THIS resolve proves free tier — via
        // either source — the persisted fatigue budget must already be hydrated into
        // reducer state before the `resolved` dispatch below, because THAT dispatch is what
        // evaluates this verdict's own trigger decision against `proactiveTriggerShown`.
        // A no-op once already hydrated (from the mount effect or an earlier resolve), and
        // never called at all for a session that stays premium/flag-off the whole time.
        if (effectiveTier === "free") hydrateFatigueBudget()
        dispatch({
          type: "resolved",
          token,
          result,
          tier: effectiveTier,
          sessionNumber: sessionNumberRef.current,
        })
        // T16: a premium in-catalog resolve auto-saves server-side (POST /api/scan/resolve
        // itself, insert-only into scan_wishlist) — refresh the bookmark's count badge so a
        // newly-auto-saved product is reflected without waiting for the next mount. Free/
        // flag-off never reach this branch (`effectiveTier` above is never "premium" for a
        // free session; `merklisteEnabled` is the same server-derived flag gate the mount
        // effect uses), so neither performs this extra read.
        if (merklisteEnabled && effectiveTier === "premium" && result.kind === "in_catalog") {
          // Fix Z5: reconcile FIRST from this response's own `savedState` (the route
          // predicts `"merkliste"` exactly when it scheduled the deferred insert), then
          // refetch. Either order is safe now — the refetch counts the union, so a listing
          // that has not caught up to the deferred write can no longer paint a stale count.
          if (result.savedState.state === "merkliste") {
            notePredictedWishlistSave(result.product.productId)
          }
          void loadWishlistCount()
        }
        // Fix round 1 (F2): a masked verdict with the credit already spent MIGHT be the
        // same product the credit was spent on — the reveal endpoint is idempotent, so
        // attempting it silently either re-serves that same card (a rescan or a reload of
        // the revealed product) or 409s for a different one, which just confirms today's
        // Premium gate. `revealAlternatives` itself no-ops once the user has moved to a
        // different product (the reducer's `ownsResultProduct` guard).
        if (
          result.kind === "in_catalog" &&
          isMaskedScanVerdict(result) &&
          !result.freeRevealAvailable
        ) {
          void revealAlternatives(result.product.productId, { silent: true })
        }
      } catch {
        if (!requests.isCurrent(token)) return
        resolveInFlightRef.current = false
        dispatch({ type: "resolve_failed", token })
        toast({ title: GENERIC_ERROR, variant: "destructive" })
        returnToScanning()
      }
    },
    [
      analytics,
      clearSheetTimer,
      hydrateFatigueBudget,
      loadWishlistCount,
      merklisteEnabled,
      notePredictedWishlistSave,
      requests,
      returnToScanning,
      revealAlternatives,
      tier,
      toast,
    ],
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

  /**
   * Fix round 2: `tier_upgraded`'s reducer case deliberately leaves `step`/`result`
   * untouched (see its doc comment and the reducer test) — a purchase proves the tier,
   * it does not hand back a new verdict. But when the step on screen at that moment is a
   * MASKED `in_catalog` verdict, that original masked payload (blurred comparison table,
   * inert "Was passt stattdessen?" CTA) is now stale: the buyer just paid specifically to
   * see the alternatives it hides. `resolve({ productId })` re-fetches the SAME product
   * through the ordinary tokened machinery (`openFromProductId` above uses the exact same
   * call) — now that the server has verified the purchase, that response comes back
   * unmasked. `PremiumSheet`'s `onUnlocked` fires at most once (ref-guarded upstream), so
   * this cannot loop; the brief "resolving" skeleton it repaints through is the same
   * flicker any rescan already has. Every other step (`unknown`/`pending`, or premium
   * already, or no result yet) has nothing masked to fix, so nothing re-resolves.
   */
  const handleTierUpgraded = useCallback(() => {
    // PR5 review fix (Z5): remembered in a ref, not only in reducer state, because
    // `resolve()` is a stable callback — its `tier` prop closure keeps the mount-time
    // "free" until `router.refresh()` lands, and `stateRef` is read at RESPONSE time.
    tierUpgradedRef.current = true
    const current = stateRef.current.step
    const productId =
      current.kind === "result" && isMaskedScanVerdict(current.result)
        ? current.result.product.productId
        : null
    dispatch({ type: "tier_upgraded" })
    if (productId !== null) void resolve({ productId })
  }, [resolve])

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
  /**
   * Every free-state decision below reads either the server-derived `tier` prop or the
   * RESPONSE, never a client-side entitlement guess (fix round 1, F1): `merkenLocked`
   * locks from first paint off `tier` (fails closed to `"premium"` upstream, so this side
   * can never mislock a premium user) and stays locked once a resolve response proves the
   * caller free even if `tier` somehow degraded. The reveal affordances follow this
   * verdict's own masked shape.
   */
  const merkenLocked = tier === "free" || state.tier === "free"
  /**
   * T10: a plain local binding (not `state.activeProactiveTrigger` read again inline)
   * so TypeScript keeps the non-null narrowing inside the `onOpenSheet` closure below —
   * narrowing a `const` survives a closure; narrowing a property read from `state` would
   * not, since `state` could in principle change before the closure runs.
   */
  const activeProactiveTrigger = state.activeProactiveTrigger
  const revealedAlternatives = scanRevealedAlternatives(state)
  const revealAnimatesAlternatives = scanRevealAnimates(state)
  const revealPending = state.reveal.status === "pending"
  const revealUnavailable = state.reveal.status === "unavailable"
  const cameraTileReason: ScanCameraTileReason | null =
    state.camera.status === "unavailable"
      ? state.camera.reason
      : state.camera.status === "stalled"
        ? "stalled"
        : null

  /**
   * PR2 review fix (C4): the five T9/T10 debug attributes below are only ever meaningful
   * for a free-tier render — `state.tier`/`state.reveal`/the trigger fields never leave
   * their inert defaults for a premium or flag-off session, because none of the code paths
   * that change them can run without `merkenLocked` (or the equivalent tier check) being
   * true first. Gating their PRESENCE on the same signal, rather than always emitting them
   * (previously "unknown"/"idle"/"none"/"false"), is what makes a premium/flag-off render
   * byte-identical to before T9/T10 touched this file — the binding invariant every other
   * flag-gated surface in this repo holds (see `access.ts`'s doc comment on
   * `hasFreemiumPaidAccess`).
   */
  const scanFlowDebugAttributes = merkenLocked
    ? {
        "data-scan-tier": state.tier,
        "data-scan-reveal": state.reveal.status,
        "data-scan-premium-sheet": state.premiumSheet?.feature ?? "none",
        "data-scan-active-trigger": activeProactiveTrigger ?? "none",
        "data-scan-zwei-scans-gleiche-kategorie": state.zweiScansGleicheKategorie
          ? "true"
          : "false",
      }
    : {}

  return (
    <div
      /**
       * Debug surface for the dev-only `/labs/scan` harness and its Playwright spec
       * (`tests/scan-flow.spec.ts`): the reducer's whole observable state as data
       * attributes, so an end-to-end assertion can name a transition instead of guessing
       * it from copy. Cheaper than a debug prop (nothing to thread through, nothing the
       * production caller has to pass) and inert in production — six attributes on one
       * div, no behaviour attached. The five T9/T10 attributes are spread in via
       * `scanFlowDebugAttributes` — see its comment: absent, not merely "none"/"unknown",
       * for a premium or flag-off render.
       */
      data-scan-flow=""
      data-scan-step={step.kind}
      data-scan-auxiliary={state.auxiliary}
      data-scan-camera={state.camera.status}
      data-scan-camera-reason={cameraTileReason ?? "none"}
      data-scan-save-open={state.saveOpen ? "true" : "false"}
      data-scan-epoch={state.epoch}
      {...scanFlowDebugAttributes}
      className="mx-auto w-full max-w-[430px] px-3 sm:max-w-[560px] sm:px-5"
    >
      <div className="flex items-center justify-between py-2">
        <h1 className="text-[17px] font-bold text-foreground">Scan</h1>
        <ScanWishlistTrigger
          locked={merkenLocked}
          // T16: premium's bookmark is a one-tap shortcut to the „Gemerkt" section on the
          // Routine page — the section IS the Merkliste home now (plan ruling), not this
          // in-flow sheet. Free stays exactly as T9 built it (opens the Premium sheet); the
          // count badge is `wishlistCount`, which only ever loads when `merklisteEnabled`.
          count={wishlistCount ?? undefined}
          // PR5 review fix (Z1): the deep-link fires ONLY when the flag-on „Gemerkt"
          // section it points at actually exists. `merklisteEnabled` is the same
          // server-derived flag that gates that section on the Routine page (see
          // `RoutinePage`/`GemerktSection`), so with the flag off this bookmark keeps
          // T9's exact pre-branch behaviour — it opens the in-flow `ScanWishlistSheet`,
          // the only Merkliste surface that exists in that state. Before this fix a
          // flag-off tap navigated to `/routine#gemerkt`, a page with no such section
          // and no Merkliste at all.
          onClick={() =>
            merkenLocked
              ? dispatch({ type: "premium_sheet_opened", context: MERKLISTE_GATE })
              : merklisteEnabled
                ? navigate("/routine#gemerkt")
                : dispatch({ type: "auxiliary_opened", sheet: "wishlist" })
          }
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
              saveLocked={merkenLocked}
              onSave={() =>
                merkenLocked
                  ? dispatch({ type: "premium_sheet_opened", context: MERKLISTE_GATE })
                  : dispatch({ type: "save_sheet_toggled", open: true })
              }
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
            revealedAlternatives={revealedAlternatives}
            revealAnimates={revealAnimatesAlternatives}
            revealPending={revealPending}
            revealUnavailable={revealUnavailable}
            onReveal={() => void revealAlternatives(resultStep.result.product.productId)}
            onPremiumAlternatives={() =>
              dispatch({ type: "premium_sheet_opened", context: EMPFEHLUNGEN_GATE })
            }
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
        {/* T10 trigger layer: additive cards below the verdict, never inside
            `ScanResultCard` — T9's tested composition stays untouched. Both gates are
            zero-render for premium/flag-off (the reducer only ever sets these once the
            trigger's own tier gate has confirmed free tier). */}
        {resultStep && state.zweiScansGleicheKategorie ? (
          <ScanCategoryRepeatCard
            categoryLabel={resultStep.result.product.categoryLabel}
            onOpenSheet={() => dispatch({ type: "premium_sheet_opened", context: ZWEI_SCANS_GATE })}
          />
        ) : null}
        {resultStep && activeProactiveTrigger ? (
          <ScanProactiveTriggerCard
            id={activeProactiveTrigger}
            onOpenSheet={() => {
              const context = scanTriggerSheetContext(activeProactiveTrigger)
              // `kategorien_luecke` never opens the sheet (journey ruling) — its card is a
              // plain Link, so `onOpenSheet` is simply never invoked for it.
              if (context) dispatch({ type: "premium_sheet_opened", context })
            }}
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

      {/* Every free-tier gate on this surface — Merken and the post-reveal alternatives
          CTA — opens the one stub sheet from T5. PR4 replaces its body with the real
          paywall behind the same opener contract. */}
      <PremiumSheet
        open={state.premiumSheet !== null}
        context={state.premiumSheet}
        onClose={() => dispatch({ type: "premium_sheet_closed" })}
        // Fix round 1 (F1): the sheet's `router.refresh()` re-serves this component's
        // server props but cannot touch its reducer, and `state.tier` is sticky by design.
        // Without this the buyer returns from the purchase to a still-locked Merken
        // bookmark — the gate most of them started from.
        onUnlocked={handleTierUpgraded}
        // Fix round 1 (F2): a redirect payment (PayPal) returns on a fresh page load with
        // no sheet open, so a pending or failed outcome has nowhere to render. Reopen on
        // the gate the purchase started from; Merken is this surface's default origin.
        onRequestOpen={(context) =>
          dispatch({ type: "premium_sheet_opened", context: context ?? MERKLISTE_GATE })
        }
      />
    </div>
  )
}

/**
 * The `verdict` analytics property: the fit verdict on `in_catalog`, or the need
 * mode ("not_needed" / "deferred") when the category reached no fit verdict at all.
 */
function resultVerdictLabel(result: ScanVerdictResult): string {
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
