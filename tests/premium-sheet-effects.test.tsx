import assert from "node:assert/strict"
import test from "node:test"
import React, { type ReactElement, type ReactNode } from "react"

import { BottomSheetContent } from "@/components/ui/bottom-sheet"
import { PremiumSheet } from "@/components/premium-sheet/premium-sheet"
import { PREMIUM_SHEET_PURCHASE_COPY } from "@/lib/premium-sheet/purchase-copy"
import type { PremiumSheetContext } from "@/lib/premium-sheet/context"

/**
 * The EFFECT half of the Premium sheet (freemium-scanner-first T14, fix round 1 F8).
 *
 * `tests/premium-sheet-component.test.tsx` renders the sheet under a harness whose
 * `useEffect` is a deliberate no-op — good enough for the plan rows and the escape, but it
 * left the entire "verified → visibly unlocked" half of the journey untested, which is
 * exactly where F1, F2 and F3 lived. This harness RUNS effects (same family as
 * `tests/scan-flow-ui.test.tsx`), with a fake router, a fake toast context, a fake
 * `sessionStorage` and a routed `fetch`, so the three lanes the review found broken are
 * driven for real:
 *
 *   1. a verified completion tells the opener, refreshes, toasts and closes;
 *   2. a redirect (PayPal) return that lands `pending` reopens the sheet;
 *   3. a redirect return that FAILS reopens it with the retry.
 */

type AnyElement = ReactElement<Record<string, any>>

function childrenOf(node: ReactNode): ReactNode[] {
  if (!React.isValidElement(node)) return []
  return React.Children.toArray((node as ReactElement<{ children?: ReactNode }>).props.children)
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (!React.isValidElement(node)) return ""
  return childrenOf(node)
    .map((child) => textContent(child))
    .join("")
}

function findAll(node: ReactNode, predicate: (element: AnyElement) => boolean): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate))
  if (!React.isValidElement(node)) return []
  const element = node as AnyElement
  const matches = predicate(element) ? [element] : []
  return [...matches, ...childrenOf(element).flatMap((child) => findAll(child, predicate))]
}

function sheetParts(tree: ReactNode): ReactNode[] {
  const content = findAll(tree, (element) => element.type === BottomSheetContent)[0]
  assert.ok(content, "expected a BottomSheetContent")
  return [content.props.children, content.props.header, content.props.footer] as ReactNode[]
}

function byData(tree: ReactNode, attribute: string): AnyElement[] {
  return sheetParts(tree).flatMap((part) =>
    findAll(part, (element) => element.props[attribute] !== undefined),
  )
}

// --- environment ------------------------------------------------------------

type MemoryStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function memoryStorage(seed: Record<string, string> = {}): MemoryStorage {
  const values = new Map(Object.entries(seed))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  }
}

const SESSION_ID = "cs_test_return_1"
const REMEMBERED: PremiumSheetContext = { feature: "merkliste", source: "scan:verdict" }

function installWindow(search: string, storage: MemoryStorage) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search }, sessionStorage: storage },
  })
}

// --- hook harness (runs effects) --------------------------------------------

type ReactDispatcherInternals = { H: unknown }
type EffectRecord = { deps: unknown[] | undefined; cleanup?: () => void }
type MemoRecord<T> = { deps: unknown[] | undefined; value: T }

function depsChanged(previous: unknown[] | undefined, next: unknown[] | undefined): boolean {
  return (
    !previous ||
    !next ||
    previous.length !== next.length ||
    next.some((dep, index) => dep !== previous[index])
  )
}

function createEffectHarness(renderComponent: () => ReactElement | null, contextValue: unknown) {
  const reactInternals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: ReactDispatcherInternals
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const previousDispatcher = reactInternals.H
  const hookValues: unknown[] = []
  let cursor = 0
  let pendingEffects: Array<{ index: number; effect: () => void | (() => void) }> = []

  const dispatcher = {
    useCallback<T extends (...args: never[]) => unknown>(callback: T, deps?: unknown[]): T {
      return this.useMemo(() => callback, deps)
    },
    /**
     * `useRouter` and `useToast` both read a context. One merged fake serves both — the
     * contexts themselves are module-private, so identity switching is not available here.
     */
    useContext<T>(): T {
      return contextValue as T
    },
    /** `usePathname` reads its context through `use`, not `useContext`. */
    use(): unknown {
      return "/scan"
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
      // Real React guarantees the dispatch function's IDENTITY is stable across every
      // render of the component that owns it — production code (`verify`'s own
      // `useCallback`, keyed on `dispatchPurchase`) relies on exactly that to stay a stable
      // reference itself. A dispatch closure rebuilt every render here would make effects
      // that depend on it (transitively, through `verify`) re-run every render too — not a
      // production bug, a test-harness one, so the dispatch slot is allocated and built
      // once and reused (Codex fix wave round 2, R3 test coverage).
      const stateIndex = cursor
      cursor += 1
      const dispatchIndex = cursor
      cursor += 1
      if (hookValues.length <= stateIndex) hookValues[stateIndex] = initialState
      if (!hookValues[dispatchIndex]) {
        hookValues[dispatchIndex] = (action: A) => {
          hookValues[stateIndex] = reducer(hookValues[stateIndex] as S, action)
        }
      }
      return [hookValues[stateIndex] as S, hookValues[dispatchIndex] as (a: A) => void]
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
    async render(): Promise<ReactElement | null> {
      cursor = 0
      pendingEffects = []
      reactInternals.H = dispatcher
      try {
        const tree = renderComponent()
        const effects = pendingEffects
        pendingEffects = []
        for (const { index, effect } of effects) {
          const cleanup = effect()
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

/**
 * The poll schedule starts at 2s (`purchase-poll.ts`). Collapsing every delay to a
 * macrotask keeps the suite fast while still driving the REAL effect wiring — the schedule
 * itself is asserted in `premium-sheet-purchase-state`/`purchase-poll`'s own unit tests.
 */
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = ((handler: TimerHandler, _delay?: number, ...args: unknown[]) =>
  realSetTimeout(
    handler as never,
    0,
    ...(args as never[]),
  )) as unknown as typeof globalThis.setTimeout

type SheetHarness = {
  tree: ReactElement | null
  calls: string[]
  toasts: { title: string; description?: string }[]
  opened: (PremiumSheetContext | null)[]
  completionRequests: number
  storage: MemoryStorage
  open: boolean
  settle: () => Promise<void>
}

/**
 * Mounts the sheet with a routed `fetch`. `settle()` re-renders twice around a macrotask
 * so a dispatch made from an awaited callback lands in the tree it returns.
 */
async function mountSheet(options: {
  completion: () => Response | Promise<Response>
  search?: string
  storage?: MemoryStorage
  open?: boolean
  context?: PremiumSheetContext | null
}): Promise<SheetHarness> {
  const storage = options.storage ?? memoryStorage()
  installWindow(options.search ?? "", storage)
  const calls: string[] = []
  const toasts: { title: string; description?: string }[] = []
  const opened: (PremiumSheetContext | null)[] = []
  const completionRequests: string[] = []

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    completionRequests.push(String(url))
    assert.equal(url, "/api/freemium/purchase/complete")
    assert.match(String(init?.body), new RegExp(SESSION_ID))
    return options.completion()
  }) as never

  const state = {
    open: options.open ?? false,
    context: options.context === undefined ? null : options.context,
  }
  const harness = createEffectHarness(
    () =>
      PremiumSheet({
        open: state.open,
        context: state.context,
        onClose: () => {
          calls.push("close")
          state.open = false
        },
        onUnlocked: () => calls.push("unlocked"),
        onRequestOpen: (context) => {
          calls.push("requestOpen")
          opened.push(context)
          state.open = true
          state.context = context ?? state.context
        },
      }),
    {
      // Router half.
      refresh: () => calls.push("refresh"),
      replace: (href: string) => calls.push(`replace:${href}`),
      push: () => calls.push("push"),
      // Toast half — the app-wide provider every sheet surface has in its route layout.
      toasts: [],
      dismiss: () => {},
      toast: (entry: { title: string; description?: string }) => {
        calls.push("toast")
        toasts.push(entry)
      },
    },
  )

  const result: SheetHarness = {
    tree: null,
    calls,
    toasts,
    opened,
    storage,
    get completionRequests() {
      return completionRequests.length
    },
    get open() {
      return state.open
    },
    async settle() {
      await harness.render()
      await new Promise((resolve) => setTimeout(resolve, 0))
      result.tree = await harness.render()
    },
  }
  // Three cycles: the return dispatch, the verification fetch, and the render that acts on
  // its outcome (unlock, or the reopen request).
  await result.settle()
  await result.settle()
  await result.settle()
  return result
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

// --- the three lanes --------------------------------------------------------

test("F1/F3: a verified return unlocks the opener, refreshes, toasts and closes", async () => {
  const sheet = await mountSheet({
    completion: () => json({ status: "complete", routineReady: true }),
    search: `?freemium_checkout=${SESSION_ID}`,
    open: true,
    context: REMEMBERED,
  })

  // Exactly one of each, after three render cycles: openers pass inline callbacks, so this
  // effect's deps change on every render and the refresh causes one — an unguarded unlock
  // would be a refresh loop raising a toast per turn.
  // The opener is told BEFORE the refresh: the surfaces that hold their own tier state
  // (the scanner's Merken bookmark) cannot learn it from a re-served server prop.
  assert.deepEqual(
    sheet.calls.filter((call) => call !== "replace:/scan"),
    ["unlocked", "refresh", "toast", "close"],
  )
  assert.deepEqual(sheet.toasts, [{ title: PREMIUM_SHEET_PURCHASE_COPY.unlockToast }])
  assert.equal(sheet.open, false)
})

test("F1: a degraded provisioning still unlocks, and the toast says the Routine is coming", async () => {
  const sheet = await mountSheet({
    completion: () => json({ status: "complete", routineReady: false }),
    search: `?freemium_checkout=${SESSION_ID}`,
    open: true,
    context: REMEMBERED,
  })

  assert.deepEqual(sheet.toasts, [
    {
      title: PREMIUM_SHEET_PURCHASE_COPY.unlockToast,
      description: PREMIUM_SHEET_PURCHASE_COPY.unlockToastRoutinePending,
    },
  ])
  assert.ok(sheet.calls.includes("unlocked"))
})

test("F3: the sheet raises no toast of its own — the surviving provider owns it", async () => {
  // The refresh replaces the gated subtree this component lives in, so a portal owned by
  // the sheet would be unmounted a few hundred ms into a 5s toast.
  const sheet = await mountSheet({
    completion: () => json({ status: "complete", routineReady: true }),
    search: `?freemium_checkout=${SESSION_ID}`,
    open: true,
    context: REMEMBERED,
  })
  assert.equal(
    findAll(sheet.tree, (element) => element.props["data-premium-sheet-unlock-toast"] !== undefined)
      .length,
    0,
  )
})

test("F2: a redirect return that is still settling reopens the sheet on its pending state", async () => {
  const sheet = await mountSheet({
    completion: () => json({ status: "pending" }),
    search: `?freemium_checkout=${SESSION_ID}`,
    storage: memoryStorage({
      "chaarlie.premium-sheet.checkout-context": JSON.stringify(REMEMBERED),
    }),
    // The buyer comes back on a FRESH page load: nothing is open.
    open: false,
    context: null,
  })

  assert.ok(sheet.calls.includes("requestOpen"), "a closed sheet renders nothing at all")
  // Reopened on the gate the purchase started from, not the surface's default.
  assert.deepEqual(sheet.opened, [REMEMBERED])
  assert.equal(sheet.open, true)
  assert.equal(byData(sheet.tree, "data-premium-sheet-purchase-phase").length, 1)
  assert.equal(
    textContent(byData(sheet.tree, "data-premium-sheet-purchase-phase")[0]).includes(
      PREMIUM_SHEET_PURCHASE_COPY.pendingTitle,
    ),
    true,
  )
  assert.equal(sheet.toasts.length, 0, "nothing is unlocked while the payment is unsettled")
})

test("F2: a redirect return that fails verification reopens the sheet with the retry", async () => {
  const sheet = await mountSheet({
    completion: () => json({ status: "failed", reason: "checkout_subscription_expired" }),
    search: `?freemium_checkout=${SESSION_ID}`,
    open: false,
    context: null,
  })

  assert.ok(sheet.calls.includes("requestOpen"))
  assert.equal(sheet.open, true)
  const alert = byData(sheet.tree, "data-premium-sheet-purchase-phase")[0]
  assert.ok(alert, "the failure must be visible, not dispatched into a closed sheet")
  assert.equal(alert.props["data-premium-sheet-purchase-phase"], "failed")
  assert.equal(textContent(alert), PREMIUM_SHEET_PURCHASE_COPY.verificationFailed)
  // The free session is untouched: the plan rows are back, behind one retry.
  assert.equal(byData(sheet.tree, "data-premium-sheet-plans").length, 1)
  assert.equal(
    textContent(byData(sheet.tree, "data-premium-sheet-cta")[0]),
    PREMIUM_SHEET_PURCHASE_COPY.retry,
  )
  assert.equal(sheet.calls.includes("unlocked"), false)
})

test("F2: nothing happens without a return parameter — the ordinary mount is unchanged", async () => {
  const sheet = await mountSheet({
    completion: () => {
      throw new Error("no completion request may be made")
    },
    search: "",
    open: true,
    context: REMEMBERED,
  })

  assert.deepEqual(sheet.calls, [])
  assert.equal(byData(sheet.tree, "data-premium-sheet-plans").length, 1)
})

/* ------------------------------------------------------------------------- *
 * Y3 — the pending state polls, and survives a refresh.
 * ------------------------------------------------------------------------- */

const PENDING_SESSION_KEY = "chaarlie.premium-sheet.pending-session"
const CONTEXT_KEY = "chaarlie.premium-sheet.checkout-context"

test("Y3: a pending payment that settles unlocks the mounted sheet — no reload", async () => {
  // Before this the sheet asked once and then sat there: the webhook finished the purchase
  // minutes later and the buyer stayed gated until they reloaded the page.
  let answered = 0
  const sheet = await mountSheet({
    completion: () => {
      answered += 1
      return answered === 1
        ? json({ status: "pending" })
        : json({ status: "complete", routineReady: true })
    },
    search: `?freemium_checkout=${SESSION_ID}`,
    open: true,
    context: REMEMBERED,
  })
  // Let the poll fire and land.
  await sheet.settle()
  await sheet.settle()

  assert.ok(sheet.completionRequests >= 2, "the pending state must ask again on its own")
  assert.ok(sheet.calls.includes("unlocked"), "the settled payment unlocks in place")
  assert.deepEqual(sheet.toasts, [{ title: PREMIUM_SHEET_PURCHASE_COPY.unlockToast }])
  assert.equal(sheet.open, false)
})

test("Y3: a refresh during a pending payment resumes verification from storage", async () => {
  // The return effect strips `?freemium_checkout=` immediately, so after one reload the URL
  // carries nothing. `sessionStorage` is the only handle left on the Session.
  const sheet = await mountSheet({
    completion: () => json({ status: "pending" }),
    search: "",
    storage: memoryStorage({
      [CONTEXT_KEY]: JSON.stringify(REMEMBERED),
      [PENDING_SESSION_KEY]: SESSION_ID,
    }),
    open: false,
    context: null,
  })

  assert.ok(sheet.completionRequests >= 1, "the resumed verification must actually run")
  assert.ok(sheet.calls.includes("requestOpen"))
  assert.deepEqual(sheet.opened, [REMEMBERED], "and on the gate the purchase started from")
  assert.equal(
    byData(sheet.tree, "data-premium-sheet-purchase-phase")[0]?.props[
      "data-premium-sheet-purchase-phase"
    ],
    "pending",
  )
})

test("Y3: the remembered gate is NOT consumed while the payment is still settling", async () => {
  const storage = memoryStorage({ [CONTEXT_KEY]: JSON.stringify(REMEMBERED) })
  const sheet = await mountSheet({
    completion: () => json({ status: "pending" }),
    search: `?freemium_checkout=${SESSION_ID}`,
    storage,
    open: false,
    context: null,
  })
  assert.equal(storage.getItem(CONTEXT_KEY), JSON.stringify(REMEMBERED))
  assert.equal(storage.getItem(PENDING_SESSION_KEY), SESSION_ID, "the Session stays resumable")
  assert.deepEqual(sheet.opened, [REMEMBERED])
})

test("Y3: both memos are dropped once the purchase is terminal", async () => {
  const storage = memoryStorage({
    [CONTEXT_KEY]: JSON.stringify(REMEMBERED),
    [PENDING_SESSION_KEY]: SESSION_ID,
  })
  await mountSheet({
    completion: () => json({ status: "complete", routineReady: true }),
    search: `?freemium_checkout=${SESSION_ID}`,
    storage,
    open: true,
    context: REMEMBERED,
  })
  assert.equal(storage.getItem(CONTEXT_KEY), null)
  assert.equal(storage.getItem(PENDING_SESSION_KEY), null)
})

test("Y3: a manual „Status prüfen“ is offered and drives the same verification", async () => {
  let answered = 0
  const sheet = await mountSheet({
    completion: () => {
      answered += 1
      return json({ status: "pending" })
    },
    search: `?freemium_checkout=${SESSION_ID}`,
    open: true,
    context: REMEMBERED,
  })
  const recheck = byData(sheet.tree, "data-premium-sheet-recheck")[0]
  assert.ok(recheck, "a bounded poll must always leave a button to press")
  assert.equal(textContent(recheck), PREMIUM_SHEET_PURCHASE_COPY.recheck)

  const before = answered
  recheck.props.onClick()
  await sheet.settle()
  assert.ok(answered > before)
})

/* ------------------------------------------------------------------------- *
 * Y1 — paid, entitled, plan not built: said out loud, never as „freigeschaltet".
 * ------------------------------------------------------------------------- */

test("Y1: a provisioning failure never raises the unlock toast", async () => {
  const sheet = await mountSheet({
    completion: () => json({ status: "provisioning", retryable: true, reason: "acceptance" }),
    search: `?freemium_checkout=${SESSION_ID}`,
    open: true,
    context: REMEMBERED,
  })

  const panel = byData(sheet.tree, "data-premium-sheet-purchase-phase")[0]
  assert.equal(panel?.props["data-premium-sheet-purchase-phase"], "provisioning")
  assert.ok(textContent(panel).includes(PREMIUM_SHEET_PURCHASE_COPY.provisioningTitle))
  assert.ok(textContent(panel).includes(PREMIUM_SHEET_PURCHASE_COPY.provisioningBody))
  assert.deepEqual(sheet.toasts, [], "„Alles freigeschaltet“ over an empty plan is a lie")
  assert.equal(sheet.calls.includes("close"), false, "the sheet keeps saying what is happening")
  // The ACCESS half is true and is applied: client-held locks flip, the gates re-render.
  assert.ok(sheet.calls.includes("unlocked"))
  assert.ok(sheet.calls.includes("refresh"))
})

test("Y1: a provisioning failure that polling can fix converges to the unlock", async () => {
  let answered = 0
  const sheet = await mountSheet({
    completion: () => {
      answered += 1
      return answered === 1
        ? json({ status: "provisioning", retryable: true, reason: "acceptance" })
        : json({ status: "complete", routineReady: true })
    },
    search: `?freemium_checkout=${SESSION_ID}`,
    open: true,
    context: REMEMBERED,
  })
  await sheet.settle()
  await sheet.settle()

  assert.deepEqual(sheet.toasts, [{ title: PREMIUM_SHEET_PURCHASE_COPY.unlockToast }])
  assert.equal(sheet.open, false)
})

test("Y1: a provisioning failure polling cannot fix stops asking and says so", async () => {
  const sheet = await mountSheet({
    completion: () =>
      json({ status: "provisioning", retryable: false, reason: "no_quiz_artifact" }),
    search: `?freemium_checkout=${SESSION_ID}`,
    open: true,
    context: REMEMBERED,
  })
  const requestsAfterFirstAnswer = sheet.completionRequests
  await sheet.settle()
  await sheet.settle()

  assert.equal(sheet.completionRequests, requestsAfterFirstAnswer, "no endless polling")
  const panel = byData(sheet.tree, "data-premium-sheet-purchase-phase")[0]
  assert.ok(textContent(panel).includes(PREMIUM_SHEET_PURCHASE_COPY.provisioningStalledBody))
  assert.equal(byData(sheet.tree, "data-premium-sheet-recheck").length, 0)
})

/* ------------------------------------------------------------------------- *
 * Y4 — an expired or abandoned Session reads as what it is.
 * ------------------------------------------------------------------------- */

test("Y4: an expired Session gets its own line and a fresh checkout, not a spinner", async () => {
  const sheet = await mountSheet({
    completion: () => json({ status: "failed", reason: "checkout_session_expired" }),
    search: `?freemium_checkout=${SESSION_ID}`,
    open: true,
    context: REMEMBERED,
  })
  const alert = byData(sheet.tree, "data-premium-sheet-purchase-phase")[0]
  assert.equal(alert.props["data-premium-sheet-purchase-phase"], "failed")
  assert.equal(textContent(alert), PREMIUM_SHEET_PURCHASE_COPY.checkoutExpired)
  assert.equal(
    textContent(byData(sheet.tree, "data-premium-sheet-cta")[0]),
    PREMIUM_SHEET_PURCHASE_COPY.retry,
  )
})

test("Y4: an abandoned Session says so, and the plan rows are back", async () => {
  const sheet = await mountSheet({
    completion: () => json({ status: "failed", reason: "checkout_session_abandoned" }),
    search: `?freemium_checkout=${SESSION_ID}`,
    open: true,
    context: REMEMBERED,
  })
  const alert = byData(sheet.tree, "data-premium-sheet-purchase-phase")[0]
  assert.equal(textContent(alert), PREMIUM_SHEET_PURCHASE_COPY.checkoutAbandoned)
  assert.equal(byData(sheet.tree, "data-premium-sheet-plans").length, 1)
})

/* ------------------------------------------------------------------------- *
 * Codex fix wave round 2 — R1: a transient error on the RESUME lane stays
 * pending, never fails the purchase outright; an authoritative verdict still
 * does.
 * ------------------------------------------------------------------------- */

test("R1: a resumed pending purchase treats a transport error as still-pending, not failed", async () => {
  const storage = memoryStorage({
    [CONTEXT_KEY]: JSON.stringify(REMEMBERED),
    [PENDING_SESSION_KEY]: SESSION_ID,
  })
  let answered = 0
  const sheet = await mountSheet({
    completion: () => {
      answered += 1
      // The RESUME lane's first verify call — a transport/5xx error here must not read as
      // the server's own "we could not confirm your payment".
      return answered === 1
        ? new Response("upstream unreachable", { status: 502 })
        : json({ status: "pending" })
    },
    search: "",
    storage,
    open: false,
    context: null,
  })

  const panel = byData(sheet.tree, "data-premium-sheet-purchase-phase")[0]
  assert.equal(
    panel?.props["data-premium-sheet-purchase-phase"],
    "pending",
    "a transient error on resume stays pending, not failed",
  )
  assert.equal(sheet.toasts.length, 0)
  assert.equal(sheet.calls.includes("close"), false)
  // The resume handle is NOT torn down — the paid buyer can still reach their purchase.
  assert.equal(storage.getItem(PENDING_SESSION_KEY), SESSION_ID)
  assert.equal(storage.getItem(CONTEXT_KEY), JSON.stringify(REMEMBERED))
})

test("R1: an authoritative failure verdict on the RESUME lane is still terminal", async () => {
  const storage = memoryStorage({
    [CONTEXT_KEY]: JSON.stringify(REMEMBERED),
    [PENDING_SESSION_KEY]: SESSION_ID,
  })
  const sheet = await mountSheet({
    completion: () => json({ status: "failed", reason: "checkout_session_expired" }),
    search: "",
    storage,
    open: false,
    context: null,
  })

  const alert = byData(sheet.tree, "data-premium-sheet-purchase-phase")[0]
  assert.equal(alert?.props["data-premium-sheet-purchase-phase"], "failed")
  assert.equal(textContent(alert), PREMIUM_SHEET_PURCHASE_COPY.checkoutExpired)
  // A real server verdict still clears the memo — there is nothing left to resume.
  assert.equal(storage.getItem(PENDING_SESSION_KEY), null)
  assert.equal(storage.getItem(CONTEXT_KEY), null)
})

/* ------------------------------------------------------------------------- *
 * Codex fix wave round 2 — R3: the poll never overlaps itself, a manual
 * recheck never stacks a second schedule, and a rate limit is a visible, but
 * non-terminal, notice.
 * ------------------------------------------------------------------------- */

/**
 * No test in this file ever "unmounts" its sheet, so a poll schedule an earlier test started
 * (real, zero-delay-mocked `setTimeout`s) can still be ticking when the next test begins —
 * and `verify()` looks up `globalThis.fetch` dynamically, so a leftover timer calls straight
 * into whichever test's mock is CURRENTLY assigned. Harmless for tests that only assert
 * eventual state, but fatal for the ones below that count exact calls. Draining the real
 * timer queue before mounting anything lets any such leftover fire against the mock that was
 * current when it was originally scheduled — the previous test's — not this one's.
 */
async function drainStaleTimers(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * A `completion` that never answers on its own — the test decides exactly when each call
 * resolves, via `answerNext`. `setTimeout`-based timing (real or mocked) is deliberately
 * NOT relied on to prove "no overlap": that only proves nothing races within the delays this
 * one run happened to pick. Holding a call open across several render passes and asserting
 * no SECOND call is ever made while it is still open proves the invariant directly, for any
 * timing.
 */
function deferredCompletion() {
  const waiting: Array<(response: Response) => void> = []
  let calls = 0
  return {
    completion: (): Promise<Response> =>
      new Promise<Response>((resolve) => {
        calls += 1
        waiting.push(resolve)
      }),
    get calls() {
      return calls
    },
    get outstanding() {
      return waiting.length
    },
    answerNext(body: unknown) {
      const resolve = waiting.shift()
      assert.ok(resolve, "expected a call to be outstanding")
      resolve(json(body))
    },
  }
}

test("R3: the automatic poll never fires the next attempt before the previous one settles", async () => {
  await drainStaleTimers()
  const server = deferredCompletion()
  const sheet = await mountSheet({
    completion: server.completion,
    search: `?freemium_checkout=${SESSION_ID}`,
    open: true,
    context: REMEMBERED,
  })
  // Only the very first, in-place verify call has been made — nothing has answered it yet.
  assert.equal(server.calls, 1)
  assert.equal(server.outstanding, 1)

  server.answerNext({ status: "pending" })
  // Give the poll effect a render to mount now that the phase is `pending`, and a further
  // one for its own scheduled timer to fire.
  await sheet.settle()
  await sheet.settle()
  assert.equal(server.calls, 2, "the poll's first attempt fires once the phase is pending")
  assert.equal(server.outstanding, 1)

  // The critical assertion: hold this second call open across MULTIPLE render passes. If the
  // next attempt were ever scheduled eagerly (the old bug — scheduling alongside the fetch
  // instead of after it settles), a third call would show up here on its own.
  await sheet.settle()
  await sheet.settle()
  await sheet.settle()
  assert.equal(server.calls, 2, "no further call is made while the current one is unanswered")

  server.answerNext({ status: "pending" })
  await sheet.settle()
  await sheet.settle()
  assert.equal(server.calls, 3, "and the schedule resumes once the outstanding call answers")
})

test("R3: a manual „Status prüfen“ adds exactly one call and does not restart the automatic schedule", async () => {
  // Compared against a control run with the IDENTICAL settle() cadence but no tap, instead of
  // asserting an exact call count directly: the automatic schedule's own next attempt can
  // legitimately land in the same render window as a manual tap (both are due around the
  // same time), which is not the bug R3 is about. What R3 rules out is the OLD behaviour —
  // the tap resetting the schedule's own attempt counter and arming an extra timer on top of
  // the running one. If it did, the "with tap" run would gain more than exactly one call.
  async function run(clickRecheck: boolean): Promise<number> {
    await drainStaleTimers()
    const server = deferredCompletion()
    const sheet = await mountSheet({
      completion: server.completion,
      search: `?freemium_checkout=${SESSION_ID}`,
      open: true,
      context: REMEMBERED,
    })
    server.answerNext({ status: "pending" })
    await sheet.settle()
    if (clickRecheck) {
      const recheck = byData(sheet.tree, "data-premium-sheet-recheck")[0]
      assert.ok(recheck, "a bounded poll must always leave a button to press")
      recheck.props.onClick()
    }
    await sheet.settle()
    // Drain whatever the (bounded) automatic schedule still owes, so both runs reach the
    // same, fully-settled end state before their totals are compared.
    for (let guard = 0; guard < 10 && server.outstanding > 0; guard += 1) {
      server.answerNext({ status: "pending" })
      await sheet.settle()
    }
    return server.calls
  }

  const withoutTap = await run(false)
  const withTap = await run(true)
  assert.equal(withTap, withoutTap + 1, "the tap adds exactly one call — nothing is stacked")
})

test("R3: a rate-limited poll surfaces a non-terminal notice and never fails the purchase", async () => {
  // Every answer is a 429 — the first call (from `verifying`) is never authoritative either,
  // so the purchase must settle into `pending` and stay there, with the poll's own attempts
  // (not the first call, which the effect above does not route into the notice) surfacing
  // the notice once one of them lands.
  const sheet = await mountSheet({
    completion: () =>
      new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "3" },
      }),
    search: `?freemium_checkout=${SESSION_ID}`,
    open: true,
    context: REMEMBERED,
  })
  await sheet.settle()
  await sheet.settle()

  const panel = byData(sheet.tree, "data-premium-sheet-purchase-phase")[0]
  assert.equal(
    panel?.props["data-premium-sheet-purchase-phase"],
    "pending",
    "a 429 is never an authoritative verdict",
  )
  assert.equal(sheet.toasts.length, 0)
  assert.equal(sheet.calls.includes("close"), false)
  assert.ok(
    findAll(sheet.tree, (element) => element.props["data-premium-sheet-rate-limit-notice"]).length >
      0,
    "the rate limit is surfaced, not silently swallowed",
  )
})
