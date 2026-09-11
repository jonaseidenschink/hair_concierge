import assert from "node:assert/strict"
import test from "node:test"
import React, { type ReactElement, type ReactNode } from "react"

import { PremiumSheet } from "../src/components/premium-sheet/premium-sheet"
import { ScanActionFooter } from "../src/components/scan/scan-action-footer"
import { ScanFlow } from "../src/components/scan/scan-flow"
import { ScanResultCard } from "../src/components/scan/scan-result-card"
import { ScanResultSheet } from "../src/components/scan/scan-result-sheet"
import { ScanSaveSheet, type ScanSaveCompletion } from "../src/components/scan/scan-save-sheet"
import { ScanSearchSheet } from "../src/components/scan/scan-search-sheet"
import {
  ScanCategoryRepeatCard,
  ScanProactiveTriggerCard,
} from "../src/components/scan/scan-trigger-cards"
import { ScanUnknownFlow } from "../src/components/scan/scan-unknown-flow"
import { ScanWishlistSheet, ScanWishlistTrigger } from "../src/components/scan/scan-wishlist-sheet"
import { Scanner } from "../src/components/scan/scanner"
import type { ScanWishlistEntry } from "../src/app/api/scan/wishlist/route"
import type { EntitlementTier } from "../src/lib/entitlements"
import type { ScanMaskedVerdictResult } from "../src/lib/scan/masked-alternative"
import type { ScanAnalyticsPort } from "../src/lib/scan/scan-analytics"
import type { ScanSavedStatePayload } from "../src/lib/scan/saved-state"
import {
  createMemoryScanTriggerStorage,
  SCAN_SESSION_RECORD_KEY,
} from "../src/lib/scan/triggers/session-marker"
import type {
  ScanAlternativePresentation,
  ScanResolvedVerdictResult,
  ScanUnknownProductResult,
} from "../src/lib/scan/types"

/**
 * `ScanFlow` is a "use client" component: this repo has no jsdom/testing-library, so the
 * component function is called directly under a hand-rolled hook dispatcher and the
 * returned element tree is walked (same harness family as
 * `tests/personal-plan-stage3-flow.test.tsx`, extended with `useReducer`/`useContext`).
 *
 * Child components are never invoked — `<Scanner>`, `<ScanResultSheet>` and the sheets
 * stay plain elements — so no module mocking is needed to keep the camera, Radix and the
 * DOM out of the test: the assertions read the props the flow hands them.
 */

// The flow schedules its confirm-window timer through `window`; `performance` and `fetch`
// are Node globals already. Assigned after the imports so no module sees a browser-ish
// global while it is being evaluated.
Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis })

// --- element-tree helpers ---------------------------------------------------

type AnyElement = ReactElement<Record<string, any>>

function childrenOf(node: ReactNode): ReactNode[] {
  if (!React.isValidElement(node)) return []
  return React.Children.toArray((node as ReactElement<{ children?: ReactNode }>).props.children)
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  return childrenOf(node)
    .map((child) => textContent(child))
    .join("")
}

function findAll(node: ReactNode, predicate: (element: AnyElement) => boolean): AnyElement[] {
  if (!React.isValidElement(node)) return []
  const element = node as AnyElement
  const matches = predicate(element) ? [element] : []
  return [...matches, ...childrenOf(element).flatMap((child) => findAll(child, predicate))]
}

function findByType(node: ReactNode, type: AnyElement["type"]): AnyElement | null {
  return findAll(node, (element) => element.type === type)[0] ?? null
}

function requireByType(node: ReactNode, type: AnyElement["type"], label: string): AnyElement {
  const match = findByType(node, type)
  assert.ok(match, `Expected a <${label}> in the tree`)
  return match
}

function buttonLabels(node: ReactNode): string[] {
  return findAll(node, (element) => element.type === "button").map((element) =>
    textContent(element),
  )
}

// --- hook harness -----------------------------------------------------------

type ReactDispatcherInternals = { H: unknown }
type EffectRecord = { deps: unknown[] | undefined; cleanup?: () => void }
type MemoRecord<T> = { deps: unknown[] | undefined; value: T }

type Harness = { render: () => Promise<ReactElement | null> }

function createClientStateHarness(
  renderComponent: () => ReactElement | null,
  contextValue: unknown,
): Harness {
  const reactInternals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: ReactDispatcherInternals
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const previousDispatcher = reactInternals.H
  const hookValues: unknown[] = []
  let cursor = 0
  let pendingEffects: Array<{ index: number; effect: () => void | (() => void) }> = []

  function depsChanged(previous: unknown[] | undefined, next: unknown[] | undefined): boolean {
    return (
      !previous ||
      !next ||
      previous.length !== next.length ||
      next.some((dep, index) => dep !== previous[index])
    )
  }

  const dispatcher = {
    useCallback<T extends (...args: never[]) => unknown>(callback: T, deps?: unknown[]): T {
      return this.useMemo(() => callback, deps)
    },
    // Every context read in this flow is `useToast()`; the harness hands back one fake
    // port rather than mounting a provider.
    useContext<T>(): T {
      return contextValue as T
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const index = cursor
      cursor += 1
      const previous = hookValues[index] as EffectRecord | undefined
      if (!depsChanged(previous?.deps, deps)) return
      previous?.cleanup?.()
      hookValues[index] = { deps } satisfies EffectRecord
      pendingEffects.push({ index, effect })
    },
    useLayoutEffect(effect: () => void | (() => void), deps?: unknown[]) {
      this.useEffect(effect, deps)
    },
    useMemo<T>(factory: () => T, deps?: unknown[]): T {
      const index = cursor
      cursor += 1
      const previous = hookValues[index] as MemoRecord<T> | undefined
      if (previous && !depsChanged(previous.deps, deps)) return previous.value
      const value = factory()
      hookValues[index] = { deps, value } satisfies MemoRecord<T>
      return value
    },
    useReducer<S, A>(reducer: (state: S, action: A) => S, initialState: S): [S, (a: A) => void] {
      const index = cursor
      cursor += 1
      if (hookValues.length <= index) hookValues[index] = initialState
      return [
        hookValues[index] as S,
        (action) => {
          hookValues[index] = reducer(hookValues[index] as S, action)
        },
      ]
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = cursor
      cursor += 1
      if (!hookValues[index]) hookValues[index] = { current: initialValue }
      return hookValues[index] as { current: T }
    },
    useState<T>(initialState: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] {
      const index = cursor
      cursor += 1
      if (hookValues.length <= index) {
        hookValues[index] =
          typeof initialState === "function" ? (initialState as () => T)() : initialState
      }
      return [
        hookValues[index] as T,
        (next) => {
          hookValues[index] =
            typeof next === "function" ? (next as (previous: T) => T)(hookValues[index] as T) : next
        },
      ]
    },
  }

  return {
    async render() {
      cursor = 0
      pendingEffects = []
      reactInternals.H = dispatcher
      try {
        const tree = renderComponent()
        const effects = pendingEffects
        pendingEffects = []
        for (const { index, effect } of effects) {
          const cleanup = effect()
          // Keyed by the effect's own hook slot: a shared "first record without a
          // cleanup" heuristic hangs the unmount cleanup on the wrong effect and then
          // runs it on every unrelated dep change.
          if (typeof cleanup === "function") {
            ;(hookValues[index] as EffectRecord).cleanup = cleanup
          }
        }
        await Promise.resolve()
        return tree
      } finally {
        reactInternals.H = previousDispatcher
      }
    },
  }
}

// --- fixtures and wiring ----------------------------------------------------

type TrackedEvent = { name: string; payload: Record<string, unknown> }

function verdictResult(productId = "p-a"): ScanResolvedVerdictResult {
  return {
    kind: "not_needed",
    mode: "not_needed",
    status: "neutral",
    headline: `Brauchst du nicht (${productId})`,
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

type FlowHarness = {
  tree: ReactElement | null
  events: TrackedEvent[]
  toasts: string[]
  settle: () => Promise<ReactElement | null>
}

/**
 * Mounts `ScanFlow` with a fake analytics port, a fake toast context and a routed
 * `fetch`. `settle()` re-renders twice around a macrotask so a dispatch made from an
 * awaited callback is visible in the tree it returns.
 */
async function mountFlow(
  route: (url: string, init: RequestInit | undefined) => Promise<Response>,
  options: {
    tier?: EntitlementTier
    /** T10: pre-seed to simulate a given session number for the Wiederkehrer trigger. */
    sessionRecordStorage?: ReturnType<typeof createMemoryScanTriggerStorage>
    /** Fix round 1 (F1): shared across two `mountFlow` calls to simulate a remount. */
    fatigueStorage?: ReturnType<typeof createMemoryScanTriggerStorage>
  } = {},
): Promise<FlowHarness> {
  const events: TrackedEvent[] = []
  const toasts: string[] = []
  const analytics: ScanAnalyticsPort = {
    track(name, payload) {
      events.push({ name, payload: payload as Record<string, unknown> })
    },
  }
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) =>
    route(String(input), init)) as typeof fetch
  test.after?.(() => {
    globalThis.fetch = previousFetch
  })

  const harness = createClientStateHarness(
    () =>
      ScanFlow({
        analytics,
        tier: options.tier,
        sessionRecordStorage: options.sessionRecordStorage,
        fatigueStorage: options.fatigueStorage,
      }),
    {
      toasts: [],
      dismiss: () => {},
      toast: (input: { title: string }) => toasts.push(input.title),
    },
  )

  const flow: FlowHarness = {
    tree: null,
    events,
    toasts,
    async settle() {
      await harness.render()
      await delay(0)
      flow.tree = await harness.render()
      return flow.tree
    },
  }
  await flow.settle()
  return flow
}

function scannerProps(tree: ReactNode): Record<string, any> {
  return requireByType(tree, Scanner, "Scanner").props
}

function sheetProps(tree: ReactNode): Record<string, any> {
  return requireByType(tree, ScanResultSheet, "ScanResultSheet").props
}

const notFound = async () => json({ error: "unexpected_call" }, 500)

// --- decode → resolving → result --------------------------------------------

test("ScanFlow: a decode holds the viewfinder for the confirm window, then resolves into the result sheet", async () => {
  const gate = deferred<Response>()
  const flow = await mountFlow(async (url) => {
    assert.equal(url, "/api/scan/resolve")
    return gate.promise
  })

  assert.equal(sheetProps(flow.tree).open, false)
  assert.equal(scannerProps(flow.tree).sessionEpoch, 0)
  assert.equal(scannerProps(flow.tree).detectionPaused, false)

  scannerProps(flow.tree).onDecoded({ type: "ean", value: "4006381333931" })
  await flow.settle()

  // Confirm moment (Variante A): the step is still scanning, so the green pill is what
  // the user sees — the skeleton must not have jumped up yet.
  assert.equal(sheetProps(flow.tree).open, false)
  assert.ok(findByType(flow.tree, Scanner))

  await delay(450)
  await flow.settle()
  assert.equal(sheetProps(flow.tree).open, true)
  assert.equal(sheetProps(flow.tree).title, "Produkt wird geprüft")

  gate.resolve(json(verdictResult()))
  await flow.settle()

  assert.equal(sheetProps(flow.tree).open, true)
  assert.equal(sheetProps(flow.tree).title, "Brauchst du nicht (p-a)")
  // Detection stops behind the sheet while the camera itself keeps running.
  assert.equal(scannerProps(flow.tree).detectionPaused, true)
  assert.deepEqual(
    flow.events.map((event) => event.name),
    ["scan_started", "scan_decoded", "scan_result_shown"],
  )
})

test("ScanFlow: a second decode inside the confirm window is ignored", async () => {
  const bodies: string[] = []
  const gate = deferred<Response>()
  const flow = await mountFlow(async (_url, init) => {
    bodies.push(String(init?.body))
    return gate.promise
  })

  scannerProps(flow.tree).onDecoded({ type: "ean", value: "4006381333931" })
  await flow.settle()
  scannerProps(flow.tree).onDecoded({ type: "ean", value: "4005808298389" })
  await flow.settle()

  assert.equal(bodies.length, 1)
  assert.equal(flow.events.filter((event) => event.name === "scan_decoded").length, 1)
  gate.resolve(json(verdictResult()))
  await flow.settle()
})

test("ScanFlow: two different decodes fired back-to-back without a settle between them only resolve once", async () => {
  // `stateRef` (the mirror `handleDecoded` reads `activeRequest` from) only catches up
  // once the passive effect runs after a render — deliberately not awaiting `settle()`
  // between the two decodes reproduces the one-frame window where the mirror still says
  // "no active request" even though the first decode already started a resolve.
  const bodies: string[] = []
  const gate = deferred<Response>()
  const flow = await mountFlow(async (_url, init) => {
    bodies.push(String(init?.body))
    return gate.promise
  })

  scannerProps(flow.tree).onDecoded({ type: "ean", value: "4006381333931" })
  scannerProps(flow.tree).onDecoded({ type: "ean", value: "4005808298389" })
  await flow.settle()

  assert.equal(bodies.length, 1)
  assert.equal(flow.events.filter((event) => event.name === "scan_decoded").length, 1)
  gate.resolve(json(verdictResult()))
  await flow.settle()
})

test("ScanFlow: a decode behind an auxiliary sheet is refused and the same barcode is taken after it closes (C3)", async () => {
  const bodies: string[] = []
  const flow = await mountFlow(async (_url, init) => {
    bodies.push(String(init?.body))
    return json(verdictResult())
  })

  requireByType(flow.tree, ScanSearchSheet, "ScanSearchSheet").props.onOpenChange(true)
  await flow.settle()
  assert.equal(scannerProps(flow.tree).detectionPaused, true)

  // `false` is the contract the loop needs: the value was NOT consumed, so the scanner
  // rewinds its dedupe guards (`unfireDetection`) instead of burning the barcode.
  assert.equal(scannerProps(flow.tree).onDecoded({ type: "ean", value: "4006381333931" }), false)
  await flow.settle()
  assert.equal(bodies.length, 0)
  assert.equal(
    flow.events.some((event) => event.name === "scan_decoded"),
    false,
  )

  requireByType(flow.tree, ScanSearchSheet, "ScanSearchSheet").props.onOpenChange(false)
  await flow.settle()
  assert.equal(scannerProps(flow.tree).detectionPaused, false)

  // The very same barcode, still in frame: now it is taken.
  assert.equal(scannerProps(flow.tree).onDecoded({ type: "ean", value: "4006381333931" }), true)
  await delay(450)
  await flow.settle()

  assert.equal(bodies.length, 1)
  assert.equal(sheetProps(flow.tree).title, "Brauchst du nicht (p-a)")
})

// --- closing the sheet ------------------------------------------------------

test("ScanFlow: closing the result sheet returns to scanning and bumps the scanner epoch", async () => {
  const flow = await mountFlow(async () => json(verdictResult()))

  scannerProps(flow.tree).onDecoded({ type: "ean", value: "4006381333931" })
  await delay(450)
  await flow.settle()
  assert.equal(sheetProps(flow.tree).open, true)

  sheetProps(flow.tree).onClose()
  await flow.settle()

  assert.equal(sheetProps(flow.tree).open, false)
  assert.equal(scannerProps(flow.tree).sessionEpoch, 1)
  assert.equal(scannerProps(flow.tree).detectionPaused, false)
  // A fresh scanning window is a fresh attempt for `ms_to_decode`.
  assert.equal(flow.events.filter((event) => event.name === "scan_started").length, 2)
})

// --- F4: a dismissed submission may not re-open a sheet ---------------------

test("ScanFlow: dismissing the unknown sheet before the submit lands leaves no pending sheet (F4)", async () => {
  const submitGate = deferred<Response>()
  const flow = await mountFlow(async (url) => {
    if (url === "/api/scan/resolve") return json(unknownResult)
    if (url === "/api/scan/submit") return submitGate.promise
    return notFound()
  })

  scannerProps(flow.tree).onDecoded({ type: "ean", value: "4006381333931" })
  await delay(450)
  await flow.settle()

  const unknownFlow = requireByType(flow.tree, ScanUnknownFlow, "ScanUnknownFlow")
  unknownFlow.props.onSubmit({ category: "shampoo" })
  await flow.settle()
  assert.equal(requireByType(flow.tree, ScanUnknownFlow, "ScanUnknownFlow").props.submitting, true)

  sheetProps(flow.tree).onClose()
  await flow.settle()
  assert.equal(sheetProps(flow.tree).open, false)

  submitGate.resolve(
    json({ kind: "pending_submission", submissionId: "s1", headline: "Wir prüfen das gerade" }),
  )
  await flow.settle()

  // The response arrived for a request the user walked away from: no sheet reopens over
  // the live viewfinder — but the submission exists server-side regardless of whether the
  // sheet is still open, so it must still be tracked, exactly once.
  assert.equal(sheetProps(flow.tree).open, false)
  assert.equal(flow.events.filter((event) => event.name === "scan_submission_created").length, 1)
})

test("ScanFlow: a failed submission keeps the unknown sheet open with its error (F17)", async () => {
  const flow = await mountFlow(async (url) => {
    if (url === "/api/scan/resolve") return json(unknownResult)
    return json({ error: "temporarily_unavailable" }, 500)
  })

  scannerProps(flow.tree).onDecoded({ type: "ean", value: "4006381333931" })
  await delay(450)
  await flow.settle()

  requireByType(flow.tree, ScanUnknownFlow, "ScanUnknownFlow").props.onSubmit({
    category: "shampoo",
  })
  await flow.settle()

  const unknownFlow = requireByType(flow.tree, ScanUnknownFlow, "ScanUnknownFlow")
  assert.equal(unknownFlow.props.submitting, false)
  assert.equal(unknownFlow.props.error, "Hat nicht geklappt – versuch's nochmal.")
})

// --- F5: a save may only land on the product it was started for -------------

test("ScanFlow: a save that completes after the next product is shown leaves that product untouched (F5)", async () => {
  const results = [verdictResult("p-a"), verdictResult("p-b")]
  const flow = await mountFlow(async () => json(results.shift() ?? verdictResult("p-x")))

  scannerProps(flow.tree).onDecoded({ type: "ean", value: "4006381333931" })
  await delay(450)
  await flow.settle()

  const saveSheetA = requireByType(flow.tree, ScanSaveSheet, "ScanSaveSheet")
  assert.equal(saveSheetA.props.productId, "p-a")
  // The completion A's still-open request will report — captured from A's render, which
  // is exactly the closure that used to close B's sheet and track B's save.
  const completeSaveForA = saveSheetA.props.onSavedStateChange as (
    completion: ScanSaveCompletion,
  ) => void

  sheetProps(flow.tree).onClose()
  await flow.settle()
  scannerProps(flow.tree).onDecoded({ type: "ean", value: "4005808298389" })
  await delay(450)
  await flow.settle()
  assert.equal(requireByType(flow.tree, ScanSaveSheet, "ScanSaveSheet").props.productId, "p-b")

  // The user is already picking a destination for B when A's save finally lands.
  requireByType(flow.tree, ScanSaveSheet, "ScanSaveSheet").props.onOpenChange(true)
  await flow.settle()
  assert.equal(requireByType(flow.tree, ScanSaveSheet, "ScanSaveSheet").props.open, true)

  completeSaveForA({ productId: "p-a", savedState: { state: "merkliste", managedByScan: true } })
  await flow.settle()

  const saveSheetB = requireByType(flow.tree, ScanSaveSheet, "ScanSaveSheet")
  assert.equal(saveSheetB.props.productId, "p-b")
  assert.deepEqual(saveSheetB.props.savedState, { state: null, managedByScan: false })
  // Not one side effect of A's save may land on B: no state, no event, no closed sheet.
  assert.equal(saveSheetB.props.open, true)
  assert.equal(
    flow.events.some((event) => event.name === "scan_saved"),
    false,
  )
})

test("ScanFlow: a save that completes for the product on screen updates it, tracks it and closes the sheet", async () => {
  const flow = await mountFlow(async () => json(verdictResult("p-a")))

  scannerProps(flow.tree).onDecoded({ type: "ean", value: "4006381333931" })
  await delay(450)
  await flow.settle()

  const saveSheet = requireByType(flow.tree, ScanSaveSheet, "ScanSaveSheet")
  saveSheet.props.onOpenChange(true)
  await flow.settle()
  assert.equal(requireByType(flow.tree, ScanSaveSheet, "ScanSaveSheet").props.open, true)

  saveSheet.props.onSavedStateChange({
    productId: "p-a",
    savedState: { state: "merkliste", managedByScan: true },
  })
  await flow.settle()

  const applied = requireByType(flow.tree, ScanSaveSheet, "ScanSaveSheet")
  assert.deepEqual(applied.props.savedState, { state: "merkliste", managedByScan: true })
  assert.equal(applied.props.open, false)
  assert.deepEqual(
    flow.events.filter((event) => event.name === "scan_saved").map((event) => event.payload.kind),
    ["merkliste"],
  )
})

// --- camera fallback tile ---------------------------------------------------

const TILE_CASES = [
  {
    reason: "denied" as const,
    notice: "Ohne Kamerazugriff findest du dein Produkt hier über die Suche.",
    button: "Kamera erneut versuchen",
  },
  {
    reason: "no_camera" as const,
    notice: "Wir finden keine Kamera — nutze so lange die Suche.",
    button: "Kamera erneut versuchen",
  },
  {
    reason: "insecure" as const,
    notice: "Die Kamera braucht eine sichere Verbindung — nutze so lange die Suche.",
    button: null,
  },
]

for (const tileCase of TILE_CASES) {
  test(`ScanFlow: an unavailable camera (${tileCase.reason}) shows its notice and retry affordance`, async () => {
    const flow = await mountFlow(notFound)

    scannerProps(flow.tree).onUnavailable(tileCase.reason)
    await flow.settle()

    assert.equal(findByType(flow.tree, Scanner), null)
    const notices = findAll(
      flow.tree,
      (element) => element.type === "p" && textContent(element) === tileCase.notice,
    )
    assert.equal(notices.length, 1, `expected the ${tileCase.reason} notice verbatim`)

    const labels = buttonLabels(flow.tree)
    if (tileCase.button) assert.ok(labels.includes(tileCase.button), labels.join(" | "))
    else {
      assert.equal(labels.includes("Kamera erneut versuchen"), false)
      assert.equal(labels.includes("Kamera neu starten"), false)
    }

    // The search sheet still pops on the first failure, with the real reason tracked.
    const sheet = requireByType(flow.tree, ScanSearchSheet, "ScanSearchSheet")
    assert.equal(sheet.props.open, true)
    // The user was just told the camera failed, so the sheet keeps its plain header
    // rather than asking about a barcode they never got to point at.
    assert.equal(sheet.props.reason, "camera")
    assert.deepEqual(
      flow.events.filter((event) => event.name === "scan_fallback_search_used"),
      [{ name: "scan_fallback_search_used", payload: { trigger: tileCase.reason } }],
    )
  })
}

/**
 * The 3s fallback opens the sheet on the user's behalf while they are still aiming at a
 * barcode, so the sheet has to name that ("Barcode nicht lesbar?"); a deliberate tap on
 * "Produkt suchen" must not (plan 2026-09-05).
 */
test("ScanFlow: the sheet knows whether the timeout or the user opened it", async () => {
  const flow = await mountFlow(notFound)

  scannerProps(flow.tree).onTimeout()
  await flow.settle()

  let sheet = requireByType(flow.tree, ScanSearchSheet, "ScanSearchSheet")
  assert.equal(sheet.props.open, true)
  assert.equal(sheet.props.reason, "timeout")

  sheet.props.onOpenChange(false)
  await flow.settle()

  const manual = findAll(
    flow.tree,
    (element) => element.type === "button" && textContent(element) === "Produkt suchen",
  )[0]
  assert.ok(manual)
  manual.props.onClick()
  await flow.settle()

  sheet = requireByType(flow.tree, ScanSearchSheet, "ScanSearchSheet")
  assert.equal(sheet.props.open, true)
  assert.equal(sheet.props.reason, "manual")
})

test("ScanFlow: a stalled stream swaps in the restart tile", async () => {
  const flow = await mountFlow(notFound)

  scannerProps(flow.tree).onStalled()
  await flow.settle()

  assert.equal(findByType(flow.tree, Scanner), null)
  assert.equal(
    findAll(
      flow.tree,
      (element) =>
        element.type === "p" && textContent(element) === "Das Kamerabild ist abgebrochen.",
    ).length,
    1,
  )
  assert.ok(buttonLabels(flow.tree).includes("Kamera neu starten"))
  // A stall is not a search fallback: nothing pops open, nothing is tracked.
  assert.equal(requireByType(flow.tree, ScanSearchSheet, "ScanSearchSheet").props.open, false)
  assert.deepEqual(
    flow.events.map((event) => event.name),
    ["scan_started"],
  )
})

test("ScanFlow: retrying re-mounts the scanner, and a second failure does not re-open the search sheet", async () => {
  const flow = await mountFlow(notFound)

  const firstKey = requireByType(flow.tree, Scanner, "Scanner").key
  scannerProps(flow.tree).onUnavailable("denied")
  await flow.settle()

  requireByType(flow.tree, ScanSearchSheet, "ScanSearchSheet").props.onOpenChange(false)
  await flow.settle()

  const retry = findAll(
    flow.tree,
    (element) => element.type === "button" && textContent(element) === "Kamera erneut versuchen",
  )[0]
  assert.ok(retry)
  retry.props.onClick()
  await flow.settle()

  // Back to a live viewfinder under a NEW key: `useScannerLoop` gives up on a camera
  // cycle once it has stalled, so only a fresh mount re-runs `getUserMedia`.
  const retriedScanner = requireByType(flow.tree, Scanner, "Scanner")
  assert.notEqual(retriedScanner.key, firstKey)

  scannerProps(flow.tree).onUnavailable("denied")
  await flow.settle()

  // The tile is back, the reason is tracked again, but the sheet the user just closed
  // stays closed.
  assert.ok(buttonLabels(flow.tree).includes("Kamera erneut versuchen"))
  assert.equal(requireByType(flow.tree, ScanSearchSheet, "ScanSearchSheet").props.open, false)
  assert.deepEqual(
    flow.events
      .filter((event) => event.name === "scan_fallback_search_used")
      .map((event) => event.payload.trigger),
    ["denied", "denied"],
  )
})

// --- resolve failure --------------------------------------------------------

test("ScanFlow: a failing resolve toasts the mapped copy once and returns to scanning", async () => {
  const flow = await mountFlow(async () => json({ error: "profile_missing" }, 403))

  scannerProps(flow.tree).onDecoded({ type: "ean", value: "4006381333931" })
  await delay(450)
  await flow.settle()

  assert.deepEqual(flow.toasts, ["Für den Scan brauchen wir zuerst deine Haaranalyse."])
  assert.equal(sheetProps(flow.tree).open, false)
  assert.equal(scannerProps(flow.tree).sessionEpoch, 1)
})

// --- F13: the Merkliste sheet's load and removal races -----------------------

function wishlistEntry(productId: string): ScanWishlistEntry {
  return {
    productId,
    name: `Produkt ${productId}`,
    brand: "Olaplex",
    imageUrl: null,
    priceLabel: "24,90 €",
    purchaseUrl: null,
  }
}

function removeButton(tree: ReactNode, productId: string): AnyElement {
  const match = findAll(
    tree,
    (element) =>
      element.type === "button" &&
      element.props["aria-label"] === `Produkt ${productId} von der Merkliste entfernen`,
  )[0]
  assert.ok(match, `Expected a remove button for ${productId}`)
  return match
}

function entryIds(tree: ReactNode): string[] {
  return findAll(tree, (element) => element.type === "li").map((element) =>
    String(element.key).replace(/^\.\$/, ""),
  )
}

async function mountWishlist(
  route: (url: string, init: RequestInit | undefined) => Promise<Response>,
  props: { open: boolean },
) {
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) =>
    route(String(input), init)) as typeof fetch
  test.after?.(() => {
    globalThis.fetch = previousFetch
  })

  const harness = createClientStateHarness(
    () =>
      ScanWishlistSheet({
        open: props.open,
        onOpenChange: () => {},
        onOpenProduct: () => {},
        onBuy: () => {},
      }),
    {},
  )
  const view = {
    tree: null as ReactElement | null,
    async settle() {
      await harness.render()
      await delay(0)
      view.tree = await harness.render()
      return view.tree
    },
  }
  await view.settle()
  return view
}

test("ScanWishlistSheet: a failed removal restores only its own entry, at its own index (F13)", async () => {
  const deleteGates = new Map<string, ReturnType<typeof deferred<Response>>>()
  const view = await mountWishlist(
    async (url, init) => {
      if (url === "/api/scan/wishlist") {
        return json({ entries: ["a", "b", "c"].map(wishlistEntry) })
      }
      const { productId } = JSON.parse(String(init?.body)) as { productId: string }
      const gate = deferred<Response>()
      deleteGates.set(productId, gate)
      return gate.promise
    },
    { open: true },
  )

  assert.deepEqual(entryIds(view.tree), ["a", "b", "c"])

  // Two removals overlap: "b" will fail, "a" will succeed.
  removeButton(view.tree, "b").props.onClick()
  await view.settle()
  removeButton(view.tree, "a").props.onClick()
  await view.settle()
  assert.deepEqual(entryIds(view.tree), ["c"])

  deleteGates.get("a")!.resolve(json({ savedState: { state: null, managedByScan: true } }))
  await view.settle()
  deleteGates.get("b")!.resolve(json({ error: "remove_failed" }, 500))
  await view.settle()

  // "b" comes back at index 1 — and "a", whose removal succeeded, stays gone. A
  // whole-array snapshot restore would have resurrected it too.
  assert.deepEqual(entryIds(view.tree), ["b", "c"])
})

test("ScanWishlistSheet: a stale load cannot overwrite the newer list (F13)", async () => {
  const gates: Array<ReturnType<typeof deferred<Response>>> = []
  const props = { open: true }
  const view = await mountWishlist(async () => {
    const gate = deferred<Response>()
    gates.push(gate)
    return gate.promise
  }, props)

  // Close and re-open while the first GET is still in flight, then answer it LAST.
  props.open = false
  await view.settle()
  props.open = true
  await view.settle()
  assert.equal(gates.length, 2)

  gates[1].resolve(json({ entries: [wishlistEntry("new")] }))
  await view.settle()
  gates[0].resolve(json({ entries: [wishlistEntry("stale")] }))
  await view.settle()

  assert.deepEqual(entryIds(view.tree), ["new"])
})

// --- T9: the free tier's verdict states, end to end through the flow ---------

/**
 * A free-tier `in_catalog` verdict, i.e. T8's masked shape. The only structural
 * difference to the premium response is the alternatives list plus `freeRevealAvailable`
 * — which is exactly the signal the flow gates every free state on.
 */
function maskedVerdict(productId = "p-a", freeRevealAvailable = true): ScanMaskedVerdictResult {
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

/** The same verdict a premium (or flag-off) caller gets: no masking marker at all. */
function premiumVerdict(productId = "p-a"): ScanResolvedVerdictResult {
  const { freeRevealAvailable: _omitted, ...rest } = maskedVerdict(productId)
  return { ...rest, alternatives: [] }
}

const REVEALED_ALTERNATIVE: ScanAlternativePresentation = {
  productId: "p-alt",
  displayName: "Lab Shampoo Gamma",
  imageUrl: null,
  priceLabel: "9,99 €",
  netContentLabel: null,
  verdict: "ideal",
  verdictLabel: "Passt",
  brand: "Chaarlie Lab",
  purchaseUrl: null,
}

function cardProps(tree: ReactNode): Record<string, any> {
  return requireByType(tree, ScanResultCard, "ScanResultCard").props
}

function wishlistTriggerProps(tree: ReactNode): Record<string, any> {
  return requireByType(tree, ScanWishlistTrigger, "ScanWishlistTrigger").props
}

function footerProps(tree: ReactNode): Record<string, any> {
  return requireByType(sheetProps(tree).footer, ScanActionFooter, "ScanActionFooter").props
}

function premiumSheetProps(tree: ReactNode): Record<string, any> {
  return requireByType(tree, PremiumSheet, "PremiumSheet").props
}

/** Decode `ean`, wait out the confirm window, and settle into the result sheet. */
async function scanInto(flow: FlowHarness, ean = "4006381333931"): Promise<void> {
  scannerProps(flow.tree).onDecoded({ type: "ean", value: ean })
  await delay(450)
  await flow.settle()
}

test("fix round 1 (F1): the server-derived tier prop locks Merken before any scan at all", async () => {
  const free = await mountFlow(notFound, { tier: "free" })
  assert.equal(wishlistTriggerProps(free.tree).locked, true)

  const premium = await mountFlow(notFound, { tier: "premium" })
  assert.equal(wishlistTriggerProps(premium.tree).locked, false)

  // No `tier` prop at all (every other caller in this suite, the labs harness without its
  // boot flag): unchanged from today — only a resolve response can lock it.
  const untiered = await mountFlow(notFound)
  assert.equal(wishlistTriggerProps(untiered.tree).locked, false)
})

test("free tier: a masked verdict locks Merken on both surfaces and offers the reveal", async () => {
  const flow = await mountFlow(async () => json(maskedVerdict()))
  await scanInto(flow)

  assert.equal(cardProps(flow.tree).result.freeRevealAvailable, true)
  assert.equal(cardProps(flow.tree).revealedAlternatives, null)
  assert.equal(wishlistTriggerProps(flow.tree).locked, true)
  assert.equal(footerProps(flow.tree).saveLocked, true)
  assert.equal(premiumSheetProps(flow.tree).open, false)
})

test("free tier: the reveal posts the SCANNED product's id and unblurs into the full card", async () => {
  const revealBodies: string[] = []
  const flow = await mountFlow(async (url, init) => {
    if (url === "/api/scan/resolve") return json(maskedVerdict("p-a"))
    if (url === "/api/scan/reveal") {
      revealBodies.push(String(init?.body))
      return json({ ok: true, productId: "p-a", alternatives: [REVEALED_ALTERNATIVE] })
    }
    return notFound()
  })
  await scanInto(flow)

  cardProps(flow.tree).onReveal()
  await flow.settle()

  // Masked alternatives carry no id to round-trip, so the body names the scanned product.
  assert.deepEqual(JSON.parse(revealBodies[0]), { productId: "p-a" })
  assert.deepEqual(cardProps(flow.tree).revealedAlternatives, [REVEALED_ALTERNATIVE])
  assert.equal(cardProps(flow.tree).revealPending, false)
  assert.deepEqual(flow.toasts, [])
})

test("free tier: 409 already_used turns the CTA into the Premium gate without a toast", async () => {
  const flow = await mountFlow(async (url) => {
    if (url === "/api/scan/resolve") return json(maskedVerdict())
    return json({ error: "already_used" }, 409)
  })
  await scanInto(flow)

  cardProps(flow.tree).onReveal()
  await flow.settle()

  assert.equal(cardProps(flow.tree).revealUnavailable, true)
  assert.equal(cardProps(flow.tree).revealedAlternatives, null)
  // Nothing went wrong for the user — the credit is simply spent elsewhere.
  assert.deepEqual(flow.toasts, [])
})

test("free tier: an empty reveal says so and leaves the unspent credit's CTA in place", async () => {
  const flow = await mountFlow(async (url) => {
    if (url === "/api/scan/resolve") return json(maskedVerdict())
    // T8: an empty eligible list is a 200 that deliberately spends NO credit.
    return json({ ok: true, productId: "p-a", alternatives: [] })
  })
  await scanInto(flow)

  cardProps(flow.tree).onReveal()
  await flow.settle()

  assert.deepEqual(flow.toasts, ["Gerade keine Alternative verfügbar."])
  assert.equal(cardProps(flow.tree).revealedAlternatives, null)
  assert.equal(cardProps(flow.tree).revealUnavailable, false)
  assert.equal(cardProps(flow.tree).result.freeRevealAvailable, true)
})

test("free tier: the post-reveal CTA opens the Premium sheet for empfehlungen", async () => {
  const flow = await mountFlow(async (url) => {
    if (url === "/api/scan/resolve") return json(maskedVerdict("p-a", false))
    // Fix round 1 (F2): `freeRevealAvailable:false` now makes the flow attempt a silent
    // background reveal for this SAME product; here it belongs to a different one, so 409.
    return json({ error: "already_used" }, 409)
  })
  await scanInto(flow)

  assert.equal(cardProps(flow.tree).result.freeRevealAvailable, false)
  cardProps(flow.tree).onPremiumAlternatives()
  await flow.settle()

  assert.equal(premiumSheetProps(flow.tree).open, true)
  assert.deepEqual(premiumSheetProps(flow.tree).context, {
    feature: "empfehlungen",
    source: "scan:verdict",
  })
  // A paywall over the viewfinder must not keep the detector burning frames.
  assert.equal(scannerProps(flow.tree).detectionPaused, true)
})

test("fix round 1 (F2): a masked verdict with the credit spent re-serves the SAME product silently", async () => {
  const revealBodies: string[] = []
  const flow = await mountFlow(async (url, init) => {
    if (url === "/api/scan/resolve") return json(maskedVerdict("p-a", false))
    if (url === "/api/scan/reveal") {
      revealBodies.push(String(init?.body))
      // The endpoint's idempotent re-serve: this IS the product the credit was spent on.
      return json({ ok: true, productId: "p-a", alternatives: [REVEALED_ALTERNATIVE] })
    }
    return notFound()
  })
  await scanInto(flow)

  // Nobody called `onReveal` — the flow revealed it on its own.
  assert.deepEqual(JSON.parse(revealBodies[0]), { productId: "p-a" })
  assert.deepEqual(cardProps(flow.tree).revealedAlternatives, [REVEALED_ALTERNATIVE])
  // No unblur this time — nothing is being "revealed" to the user.
  assert.equal(cardProps(flow.tree).revealAnimates, false)
  assert.deepEqual(flow.toasts, [])
})

test("fix round 1 (F2): a background re-serve attempt that 409s stays on the Premium gate, silently", async () => {
  const revealBodies: string[] = []
  const flow = await mountFlow(async (url, init) => {
    if (url === "/api/scan/resolve") return json(maskedVerdict("p-a", false))
    if (url === "/api/scan/reveal") {
      revealBodies.push(String(init?.body))
      return json({ error: "already_used" }, 409)
    }
    return notFound()
  })
  await scanInto(flow)

  assert.deepEqual(JSON.parse(revealBodies[0]), { productId: "p-a" })
  assert.equal(cardProps(flow.tree).revealedAlternatives, null)
  // A background attempt failing must stay invisible — the Premium gate already shows.
  assert.deepEqual(flow.toasts, [])
})

test("free tier: Merken opens the Premium sheet instead of the Merkliste or the save sheet", async () => {
  const flow = await mountFlow(async () => json(maskedVerdict()))
  await scanInto(flow)

  footerProps(flow.tree).onSave()
  await flow.settle()
  assert.deepEqual(premiumSheetProps(flow.tree).context, {
    feature: "merkliste",
    source: "scan:verdict",
  })
  assert.equal(requireByType(flow.tree, ScanSaveSheet, "ScanSaveSheet").props.open, false)

  premiumSheetProps(flow.tree).onClose()
  await flow.settle()
  assert.equal(premiumSheetProps(flow.tree).open, false)

  // The header bookmark stays locked between scans, so it never 403s a free user.
  sheetProps(flow.tree).onClose()
  await flow.settle()
  assert.equal(wishlistTriggerProps(flow.tree).locked, true)
  wishlistTriggerProps(flow.tree).onClick()
  await flow.settle()
  assert.deepEqual(premiumSheetProps(flow.tree).context, {
    feature: "merkliste",
    source: "scan:verdict",
  })
  assert.equal(requireByType(flow.tree, ScanWishlistSheet, "ScanWishlistSheet").props.open, false)
})

test("premium: an unmasked verdict leaves every Merken and reveal affordance untouched", async () => {
  const flow = await mountFlow(async (url) => {
    if (url === "/api/scan/resolve") return json(premiumVerdict())
    if (url === "/api/scan/wishlist") return json({ entries: [] })
    return notFound()
  })
  await scanInto(flow)

  assert.equal(wishlistTriggerProps(flow.tree).locked, false)
  assert.equal(footerProps(flow.tree).saveLocked, false)
  assert.equal(cardProps(flow.tree).revealedAlternatives, null)
  assert.equal(premiumSheetProps(flow.tree).open, false)

  // Merken still opens the real save sheet, not a paywall.
  footerProps(flow.tree).onSave()
  await flow.settle()
  assert.equal(requireByType(flow.tree, ScanSaveSheet, "ScanSaveSheet").props.open, true)
  assert.equal(premiumSheetProps(flow.tree).open, false)
})

// --- T10: trigger layer, wired end to end through the flow -------------------

/** `verdictResult` with the category overridden, for scanning a 2nd, different category. */
function verdictResultInCategory(
  productId: string,
  category: "shampoo" | "conditioner",
): ScanResolvedVerdictResult {
  const base = verdictResult(productId)
  return { ...base, product: { ...base.product, category, categoryLabel: category } }
}

function triggerCardProps(tree: ReactNode): Record<string, any> {
  return requireByType(tree, ScanProactiveTriggerCard, "ScanProactiveTriggerCard").props
}

const THIRTY_ONE_MINUTES_MS = 31 * 60 * 1000

/** Pre-seeds the localStorage record so the NEXT `recordScanSession` call is session 2. */
function seedPriorSession(
  storage: ReturnType<typeof createMemoryScanTriggerStorage>,
  count = 1,
): void {
  storage.setItem(
    SCAN_SESSION_RECORD_KEY,
    JSON.stringify({ count, lastSeenAt: Date.now() - THIRTY_ONE_MINUTES_MS }),
  )
}

/** Counts every `getItem`/`setItem` call — F5's "zero storage activity" needs a spy. */
function spyStorage(): {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  calls: number
} {
  const inner = createMemoryScanTriggerStorage()
  const spy = {
    calls: 0,
    getItem(key: string) {
      spy.calls += 1
      return inner.getItem(key)
    },
    setItem(key: string, value: string) {
      spy.calls += 1
      inner.setItem(key, value)
    },
  }
  return spy
}

test("T10: two scans in the same category surface the repeat card, opening empfehlungen", async () => {
  const flow = await mountFlow(async () => json(verdictResult("p-a")), { tier: "free" })
  await scanInto(flow, "1111111111111")
  assert.equal(findByType(flow.tree, ScanCategoryRepeatCard), null)

  sheetProps(flow.tree).onClose()
  await flow.settle()
  await scanInto(flow, "2222222222222")

  const card = requireByType(flow.tree, ScanCategoryRepeatCard, "ScanCategoryRepeatCard")
  // F7: the repeat card names the actual category, not a debug label.
  assert.equal(card.props.categoryLabel, "Shampoo")
  card.props.onOpenSheet()
  await flow.settle()
  assert.deepEqual(premiumSheetProps(flow.tree).context, {
    feature: "empfehlungen",
    source: "trigger:zwei-scans-gleiche-kategorie",
  })
})

test("T10/F4: a session record of exactly 2 shows the Wiederkehrer pitch, opening routine", async () => {
  const sessionRecordStorage = createMemoryScanTriggerStorage()
  seedPriorSession(sessionRecordStorage) // next recordScanSession() call becomes session 2
  const flow = await mountFlow(async () => json(verdictResult("p-a")), {
    tier: "free",
    sessionRecordStorage,
  })
  await scanInto(flow)

  assert.equal(triggerCardProps(flow.tree).id, "wiederkehrer")
  triggerCardProps(flow.tree).onOpenSheet()
  await flow.settle()
  assert.deepEqual(premiumSheetProps(flow.tree).context, {
    feature: "routine",
    source: "trigger:wiederkehrer",
  })
})

test("F4: session 1 (no prior record) and session 3+ never show Wiederkehrer", async () => {
  // Session 1: fresh storage, nothing pre-seeded.
  const sessionOne = await mountFlow(async () => json(verdictResult("p-a")), {
    tier: "free",
    sessionRecordStorage: createMemoryScanTriggerStorage(),
  })
  await scanInto(sessionOne)
  assert.equal(findByType(sessionOne.tree, ScanProactiveTriggerCard), null)

  // Session 3: the record already says count 2, so the next visit becomes session 3.
  const sessionThreeStorage = createMemoryScanTriggerStorage()
  seedPriorSession(sessionThreeStorage, 2)
  const sessionThree = await mountFlow(async () => json(verdictResult("p-a")), {
    tier: "free",
    sessionRecordStorage: sessionThreeStorage,
  })
  await scanInto(sessionThree)
  assert.equal(findByType(sessionThree.tree, ScanProactiveTriggerCard), null)
})

test("T10: fatigue — a second qualifying proactive candidate in the same session shows nothing", async () => {
  const sessionRecordStorage = createMemoryScanTriggerStorage()
  seedPriorSession(sessionRecordStorage)
  let call = 0
  const flow = await mountFlow(
    async () => {
      call += 1
      return json(
        call === 1
          ? verdictResultInCategory("p1", "shampoo")
          : verdictResultInCategory("p2", "conditioner"),
      )
    },
    { tier: "free", sessionRecordStorage },
  )
  await scanInto(flow, "1111111111111")
  assert.equal(triggerCardProps(flow.tree).id, "wiederkehrer")

  sheetProps(flow.tree).onClose()
  await flow.settle()
  await scanInto(flow, "2222222222222")

  // The 2nd scan's own category-gap condition would otherwise qualify kategorien_luecke,
  // but the session already spent its one proactive pitch on Wiederkehrer.
  assert.equal(findByType(flow.tree, ScanProactiveTriggerCard), null)
})

test("F1: the fatigue budget survives a remount (tab away and back) via shared sessionStorage", async () => {
  const fatigueStorage = createMemoryScanTriggerStorage()
  const sessionRecordStorage = createMemoryScanTriggerStorage()
  seedPriorSession(sessionRecordStorage) // this mount's visit becomes session 2

  // Mount 1: a scan qualifies and spends Wiederkehrer.
  const mount1 = await mountFlow(async () => json(verdictResult("p-a")), {
    tier: "free",
    sessionRecordStorage,
    fatigueStorage,
  })
  await scanInto(mount1)
  assert.equal(triggerCardProps(mount1.tree).id, "wiederkehrer")

  // Mount 2: a genuinely fresh `ScanFlow` instance (a real remount resets the reducer's
  // in-memory state exactly like this) sharing the SAME `fatigueStorage` — the fix round 1
  // regression this test guards against is the fatigue flag resetting to unfired here,
  // which used to let a second proactive pitch (Kategorien-Lücke, from the 2-category scan
  // below) render on the very next return to `/scan`.
  let call = 0
  const mount2 = await mountFlow(
    async () => {
      call += 1
      return json(
        call === 1
          ? verdictResultInCategory("p1", "shampoo")
          : verdictResultInCategory("p2", "conditioner"),
      )
    },
    { tier: "free", sessionRecordStorage, fatigueStorage },
  )
  await scanInto(mount2, "1111111111111")
  assert.equal(findByType(mount2.tree, ScanProactiveTriggerCard), null)
  sheetProps(mount2.tree).onClose()
  await mount2.settle()
  await scanInto(mount2, "2222222222222")
  assert.equal(findByType(mount2.tree, ScanProactiveTriggerCard), null)
})

/** `maskedVerdict` with the category overridden, for scanning a 2nd, different category. */
function maskedVerdictInCategory(
  productId: string,
  category: "shampoo" | "conditioner",
): ScanMaskedVerdictResult {
  const base = maskedVerdict(productId)
  return { ...base, product: { ...base.product, category, categoryLabel: category } }
}

test("C3: a degraded-nav mount (tier prop defaults to premium) still reads the persisted fatigue budget once a response proves free", async () => {
  const fatigueStorage = createMemoryScanTriggerStorage()

  // Mount 1: a genuinely free session (server-verified tier prop) spends the one proactive
  // pitch this "session" on Wiederkehrer.
  const priorSessionRecord = createMemoryScanTriggerStorage()
  seedPriorSession(priorSessionRecord)
  const mount1 = await mountFlow(async () => json(verdictResult("p-a")), {
    tier: "free",
    sessionRecordStorage: priorSessionRecord,
    fatigueStorage,
  })
  await scanInto(mount1)
  assert.equal(triggerCardProps(mount1.tree).id, "wiederkehrer")

  // Mount 2: the C3 repro. A degraded nav loader defaulted the `tier` PROP to "premium" for
  // what is really the SAME free user, sharing the same `fatigueStorage` (a real remount
  // keeps the same `sessionStorage`). Only a MASKED response — proving free tier via its
  // own shape, never the prop — can establish free tier here at all.
  let call = 0
  const mount2 = await mountFlow(
    async () => {
      call += 1
      return json(
        call === 1
          ? maskedVerdictInCategory("p1", "shampoo")
          : maskedVerdictInCategory("p2", "conditioner"),
      )
    },
    { tier: "premium", fatigueStorage },
  )
  // Scan 1 is the response that FIRST proves free tier: its OWN trigger gate still
  // evaluates as premium (no evidence existed yet at the moment the gate was computed for
  // this very verdict), so nothing fires here regardless of the fix — this assertion pins
  // that unaffected baseline.
  await scanInto(mount2, "1111111111111")
  assert.equal(findByType(mount2.tree, ScanProactiveTriggerCard), null)
  sheetProps(mount2.tree).onClose()
  await mount2.settle()
  // Scan 2: `effectiveTier` is now "free" (scan 1 proved it) and the Kategorien-Lücke
  // condition qualifies (2 distinct categories scanned, no leave-in) — the exact case the
  // fix targets. Before it, this mount's fatigue budget was NEVER hydrated (the mount
  // effect's `tier !== "free"` guard skipped it forever), so this fired a SECOND proactive
  // pitch in what `fatigueStorage` proves is really the same spent session.
  await scanInto(mount2, "2222222222222")
  assert.equal(findByType(mount2.tree, ScanProactiveTriggerCard), null)
})

test("T10: Kategorien-Lücke links into /routine and never opens the Premium sheet", async () => {
  let call = 0
  const flow = await mountFlow(
    async () => {
      call += 1
      return json(
        call === 1
          ? verdictResultInCategory("p1", "shampoo")
          : verdictResultInCategory("p2", "conditioner"),
      )
    },
    { tier: "free" },
  )
  await scanInto(flow, "1111111111111")
  assert.equal(findByType(flow.tree, ScanProactiveTriggerCard), null)

  sheetProps(flow.tree).onClose()
  await flow.settle()
  await scanInto(flow, "2222222222222")

  assert.equal(triggerCardProps(flow.tree).id, "kategorien_luecke")
  assert.equal(premiumSheetProps(flow.tree).open, false)
})

test("T10: premium sees zero trigger surfaces even under conditions that would fire every one of them", async () => {
  const sessionRecordStorage = createMemoryScanTriggerStorage()
  seedPriorSession(sessionRecordStorage)
  let call = 0
  const flow = await mountFlow(
    async () => {
      call += 1
      return json(
        call === 1
          ? verdictResultInCategory("p1", "shampoo")
          : verdictResultInCategory("p2", "conditioner"),
      )
    },
    { tier: "premium", sessionRecordStorage },
  )
  await scanInto(flow, "1111111111111")
  assert.equal(findByType(flow.tree, ScanProactiveTriggerCard), null)
  assert.equal(findByType(flow.tree, ScanCategoryRepeatCard), null)

  sheetProps(flow.tree).onClose()
  await flow.settle()
  await scanInto(flow, "2222222222222")

  assert.equal(findByType(flow.tree, ScanProactiveTriggerCard), null)
  assert.equal(findByType(flow.tree, ScanCategoryRepeatCard), null)
  assert.equal(premiumSheetProps(flow.tree).open, false)
})

test("F5: premium and flag-off (no tier prop) cause zero trigger-storage activity", async () => {
  const premiumRecord = spyStorage()
  const premiumFatigue = spyStorage()
  const premium = await mountFlow(async () => json(verdictResultInCategory("p1", "shampoo")), {
    tier: "premium",
    sessionRecordStorage: premiumRecord,
    fatigueStorage: premiumFatigue,
  })
  await scanInto(premium)
  assert.equal(premiumRecord.calls, 0)
  assert.equal(premiumFatigue.calls, 0)

  // No `tier` prop at all is exactly what a flag-off mount looks like in production
  // (`navigation-access.ts` never assigns `tier: "free"` with the flag off).
  const flagOffRecord = spyStorage()
  const flagOffFatigue = spyStorage()
  const flagOff = await mountFlow(async () => json(verdictResultInCategory("p1", "shampoo")), {
    sessionRecordStorage: flagOffRecord,
    fatigueStorage: flagOffFatigue,
  })
  await scanInto(flagOff)
  assert.equal(flagOffRecord.calls, 0)
  assert.equal(flagOffFatigue.calls, 0)
})

// --- PR2 review fix (C4): premium/flag-off render-identity -------------------

/** The five T9/T10 debug attributes that must be entirely absent, not merely inert. */
const SCAN_FLOW_DEBUG_ATTRIBUTES = [
  "data-scan-tier",
  "data-scan-reveal",
  "data-scan-premium-sheet",
  "data-scan-active-trigger",
  "data-scan-zwei-scans-gleiche-kategorie",
] as const

test("C4: a premium render never carries the T9/T10 debug attributes, even after a resolve and a Premium-gated action attempt", async () => {
  const premium = await mountFlow(async () => json(verdictResultInCategory("p1", "shampoo")), {
    tier: "premium",
  })
  await scanInto(premium)
  const rootProps = (premium.tree as AnyElement).props
  for (const attribute of SCAN_FLOW_DEBUG_ATTRIBUTES) {
    assert.equal(attribute in rootProps, false, `expected ${attribute} to be absent for premium`)
  }
})

test("C4: a flag-off render (no tier prop at all) never carries the T9/T10 debug attributes", async () => {
  const flagOff = await mountFlow(async () => json(verdictResultInCategory("p1", "shampoo")))
  await scanInto(flagOff)
  const rootProps = (flagOff.tree as AnyElement).props
  for (const attribute of SCAN_FLOW_DEBUG_ATTRIBUTES) {
    assert.equal(attribute in rootProps, false, `expected ${attribute} to be absent for flag-off`)
  }
})

test("C4: a free-tier render carries all five T9/T10 debug attributes", async () => {
  const free = await mountFlow(async () => json(maskedVerdict("p1")), { tier: "free" })
  await scanInto(free)
  const rootProps = (free.tree as AnyElement).props
  for (const attribute of SCAN_FLOW_DEBUG_ATTRIBUTES) {
    assert.equal(attribute in rootProps, true, `expected ${attribute} to be present for free tier`)
  }
  assert.equal(rootProps["data-scan-tier"], "free")
})
