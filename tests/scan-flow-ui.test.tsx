import assert from "node:assert/strict"
import test from "node:test"
import React, { type ReactElement, type ReactNode } from "react"

import { ScanFlow } from "../src/components/scan/scan-flow"
import { ScanResultSheet } from "../src/components/scan/scan-result-sheet"
import { ScanSaveSheet, type ScanSaveCompletion } from "../src/components/scan/scan-save-sheet"
import { ScanSearchSheet } from "../src/components/scan/scan-search-sheet"
import { ScanUnknownFlow } from "../src/components/scan/scan-unknown-flow"
import { ScanWishlistSheet } from "../src/components/scan/scan-wishlist-sheet"
import { Scanner } from "../src/components/scan/scanner"
import type { ScanWishlistEntry } from "../src/app/api/scan/wishlist/route"
import type { ScanAnalyticsPort } from "../src/lib/scan/scan-analytics"
import type { ScanSavedStatePayload } from "../src/lib/scan/saved-state"
import type { ScanResolvedVerdictResult, ScanUnknownProductResult } from "../src/lib/scan/types"

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

  const harness = createClientStateHarness(() => ScanFlow({ analytics }), {
    toasts: [],
    dismiss: () => {},
    toast: (input: { title: string }) => toasts.push(input.title),
  })

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
