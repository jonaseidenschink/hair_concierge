import assert from "node:assert/strict"
import test from "node:test"
import React, { type ReactElement, type ReactNode } from "react"

import { BottomSheetContent } from "@/components/ui/bottom-sheet"
import { PremiumSheet } from "@/components/premium-sheet/premium-sheet"
import { PremiumSheetCheckout } from "@/components/premium-sheet/premium-sheet-checkout"
import {
  PREMIUM_FEATURES,
  type PremiumFeatureId,
  type PremiumSheetContext,
} from "@/lib/premium-sheet/context"
import { orderedBenefits } from "@/lib/premium-sheet/ordered-benefits"
import { premiumSheetPlan } from "@/lib/premium-sheet/pricing"

/**
 * `PremiumSheet` is a "use client" component whose only hooks are the plan selection's
 * `useState`/`useCallback`. This repo has no jsdom/testing-library, so — same harness
 * family as `tests/gated-preview-component.test.tsx` — the component function is called
 * under a hand-rolled dispatcher and the returned element tree is walked. `BottomSheet` /
 * `BottomSheetContent` are never invoked, only matched by type, so no portal/DOM is
 * needed.
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
  // `props.children` is an array whenever a parent renders siblings — walk into it.
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate))
  if (!React.isValidElement(node)) return []
  const element = node as AnyElement
  const matches = predicate(element) ? [element] : []
  return [...matches, ...childrenOf(element).flatMap((child) => findAll(child, predicate))]
}

function findByType(node: ReactNode, type: AnyElement["type"]): AnyElement | null {
  return findAll(node, (element) => element.type === type)[0] ?? null
}

function requireByType(node: ReactNode, type: AnyElement["type"], label: string): AnyElement {
  const found = findByType(node, type)
  assert.ok(found, `expected to find ${label}`)
  return found
}

/**
 * Body, header and footer: the latter two reach `BottomSheetContent` as props, so a plain
 * children walk would miss the headline and the CTA/escape row entirely.
 */
function sheetParts(tree: ReactNode): ReactNode[] {
  const content = requireByType(tree, BottomSheetContent, "BottomSheetContent")
  return [content.props.children, content.props.header, content.props.footer] as ReactNode[]
}

function byData(tree: ReactNode, attribute: string): AnyElement[] {
  return sheetParts(tree).flatMap((part) =>
    findAll(part, (element) => element.props[attribute] !== undefined),
  )
}

function requireOne(tree: ReactNode, attribute: string): AnyElement {
  const matches = byData(tree, attribute)
  assert.equal(matches.length, 1, `expected exactly one [${attribute}]`)
  return matches[0]
}

// --- hook harness (useState / useCallback) ----------------------------------

type ReactDispatcherInternals = { H: unknown }
type MemoRecord<T> = { deps: unknown[] | undefined; value: T }

function createStateHarness(renderComponent: () => ReactElement | null) {
  const reactInternals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: ReactDispatcherInternals
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const hookValues: unknown[] = []
  let cursor = 0

  const dispatcher = {
    useCallback<T extends (...args: never[]) => unknown>(callback: T, deps?: unknown[]): T {
      return this.useMemo(() => callback, deps)
    },
    useMemo<T>(factory: () => T, deps?: unknown[]): T {
      const index = cursor
      cursor += 1
      const previous = hookValues[index] as MemoRecord<T> | undefined
      const changed =
        !previous?.deps ||
        !deps ||
        previous.deps.length !== deps.length ||
        deps.some((dep, position) => dep !== previous.deps![position])
      if (previous && !changed) return previous.value
      const value = factory()
      hookValues[index] = { deps, value } satisfies MemoRecord<T>
      return value
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
    useRef<T>(initialValue: T): { current: T } {
      const index = cursor
      cursor += 1
      if (hookValues.length <= index) {
        hookValues[index] = { current: initialValue }
      }
      return hookValues[index] as { current: T }
    },
    // T14: the sheet now owns a purchase machine, effects and the app router.
    useReducer<S, A>(
      reducer: (state: S, action: A) => S,
      initialState: S,
    ): [S, (action: A) => void] {
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
    /**
     * Effects are deliberately NOT run: this harness renders the component function once
     * and walks the tree, so running effects would fire router refreshes and fetches with
     * no environment behind them. Every effect-driven behaviour is covered by the pure
     * reducer suite (`tests/premium-sheet-purchase-state.test.ts`) instead.
     */
    useEffect(): void {},
    /**
     * `useRouter` / `usePathname` / `useToast` all resolve through context. One stub serves
     * them: the router methods are no-ops (nothing here may navigate), the toast is a
     * no-op (the effect-level suite `premium-sheet-effects.test.tsx` owns it), and the
     * pathname falls back to the sanitizer's default, which is all these assertions need.
     */
    useContext(): unknown {
      return { refresh() {}, replace() {}, push() {}, toasts: [], toast() {}, dismiss() {} }
    },
    /** `usePathname` reads its context through `use`, not `useContext`. */
    use(): unknown {
      return "/scan"
    },
  }

  return {
    render(): ReactElement | null {
      cursor = 0
      const previousDispatcher = reactInternals.H
      reactInternals.H = dispatcher
      try {
        return renderComponent()
      } finally {
        reactInternals.H = previousDispatcher
      }
    },
  }
}

function renderSheet(props: Partial<Parameters<typeof PremiumSheet>[0]> = {}): {
  render: () => ReactElement | null
} {
  return createStateHarness(() =>
    PremiumSheet({
      open: true,
      context: { feature: "chat", source: "scan:verdict" },
      onClose: () => {},
      ...props,
    }),
  )
}

function contentOf(tree: ReactNode): AnyElement {
  return requireByType(tree, BottomSheetContent, "BottomSheetContent")
}

// --- header + benefits ------------------------------------------------------

test("header is the approved „Chaarlie Premium — Alles für dein Haar.“ line", () => {
  const content = contentOf(renderSheet().render())
  const header = textContent(content.props.header as ReactNode)

  assert.match(header, /Chaarlie Premium/)
  assert.match(header, /Alles für dein Haar\./)
})

test("every feature shows exactly three registry benefits, tapped first and plum-accented", () => {
  const features = Object.keys(PREMIUM_FEATURES) as PremiumFeatureId[]
  assert.equal(features.length, 7)

  for (const feature of features) {
    const tree = renderSheet({ context: { feature, source: "scan:verdict" } }).render()
    const benefits = byData(tree, "data-premium-sheet-benefit")

    assert.equal(benefits.length, 3, `${feature}: the sheet always shows exactly three benefits`)
    assert.deepEqual(
      benefits.map((item) => item.props["data-premium-sheet-benefit"]),
      orderedBenefits({ feature, source: "scan:verdict" }),
      `${feature}: consumes orderedBenefits verbatim`,
    )
    assert.equal(benefits[0].props["data-premium-sheet-benefit"], feature)

    // Copy comes from the registry, never rewritten in the component.
    benefits.forEach((item) => {
      const registry =
        PREMIUM_FEATURES[item.props["data-premium-sheet-benefit"] as PremiumFeatureId]
      const text = textContent(item)
      assert.ok(text.includes(registry.name), `${feature}: missing "${registry.name}"`)
      assert.ok(text.includes(registry.benefit), `${feature}: missing "${registry.benefit}"`)
    })

    // Plum accent on the tapped feature only (repo colour rule: plum = selected/accented).
    assert.equal(benefits[0].props["data-premium-sheet-benefit-accent"], "true")
    assert.match(benefits[0].props.className as string, /brand-plum/)
    for (const item of benefits.slice(1)) {
      assert.equal(item.props["data-premium-sheet-benefit-accent"], "false")
      assert.doesNotMatch(item.props.className as string, /brand-plum/)
    }
  }
})

test("a null context still shows three benefits (the core order)", () => {
  const benefits = byData(renderSheet({ context: null }).render(), "data-premium-sheet-benefit")
  assert.deepEqual(
    benefits.map((item) => item.props["data-premium-sheet-benefit"]),
    orderedBenefits(null),
  )
})

test("closing holds the last context steady through the exit animation (F1)", () => {
  // Openers (scan-flow.tsx, T10 trigger cards) null `context` the same tick they set
  // `open` to false, but BottomSheetContent keeps the panel mounted and rendering
  // through its ~200-250ms exit animation. The sheet must keep showing the context it
  // had when the user dismissed it, not flip to the default core order mid-exit.
  let open = true
  let context: PremiumSheetContext | null = { feature: "merkliste", source: "scan:verdict" }
  const harness = createStateHarness(() => PremiumSheet({ open, context, onClose: () => {} }))

  const before = harness.render()
  const benefitsBefore = byData(before, "data-premium-sheet-benefit").map(
    (item) => item.props["data-premium-sheet-benefit"],
  )
  const accentBefore = byData(before, "data-premium-sheet-benefit-accent")[0]?.props[
    "data-premium-sheet-benefit-accent"
  ]
  const dismissBefore = textContent(requireOne(before, "data-premium-sheet-dismiss"))

  open = false
  context = null
  const after = harness.render()

  assert.deepEqual(
    byData(after, "data-premium-sheet-benefit").map(
      (item) => item.props["data-premium-sheet-benefit"],
    ),
    benefitsBefore,
    "benefit order must not re-order mid-exit",
  )
  assert.equal(
    byData(after, "data-premium-sheet-benefit-accent")[0]?.props[
      "data-premium-sheet-benefit-accent"
    ],
    accentBefore,
    "the plum accent must not jump mid-exit",
  )
  assert.equal(
    textContent(requireOne(after, "data-premium-sheet-dismiss")),
    dismissBefore,
    "the escape label must not flip mid-exit",
  )
})

// --- plan rows --------------------------------------------------------------

test("plan rows are Jährlich (empfohlen, preselected) · Vierteljährlich · Monatlich", () => {
  const tree = renderSheet().render()
  const rows = byData(tree, "data-premium-sheet-plan")

  assert.deepEqual(
    rows.map((row) => row.props["data-premium-sheet-plan"]),
    ["year", "quarter", "month"],
  )
  assert.deepEqual(
    rows.map((row) => textContent(row).replace(/\s+/g, " ")),
    [
      "Jährlichempfohlen~€8,33 / Monat · 44% sparen99,99 €",
      "Vierteljährlich~€11,66 / Monat · 22% sparen34,99 €",
      // Monatlich carries no second line: „/ Monat" would only restate the row's name.
      "Monatlich14,99 €",
    ],
  )

  // Jährlich is preselected, and it is the only row carrying „empfohlen".
  assert.deepEqual(
    rows.map((row) => row.props["data-premium-sheet-plan-selected"]),
    ["true", "false", "false"],
  )
  assert.equal(rows[0].props["aria-pressed"], true)
  assert.equal(
    rows.filter((row) => textContent(row).includes("empfohlen")).length,
    1,
    "only Jährlich is marked empfohlen",
  )
})

test("tapping a plan row moves the selection and the CTA label with it", () => {
  const harness = renderSheet()
  const before = harness.render()
  assert.equal(
    requireOne(before, "data-premium-sheet-cta").props["data-premium-sheet-selected-interval"],
    "year",
  )

  const monthly = byData(before, "data-premium-sheet-plan").find(
    (row) => row.props["data-premium-sheet-plan"] === "month",
  )!
  monthly.props.onClick()

  const after = harness.render()
  const rows = byData(after, "data-premium-sheet-plan")
  assert.deepEqual(
    rows.map((row) => row.props["data-premium-sheet-plan-selected"]),
    ["false", "false", "true"],
  )
  const cta = requireOne(after, "data-premium-sheet-cta")
  assert.equal(cta.props["data-premium-sheet-selected-interval"], "month")
  assert.equal(textContent(cta), premiumSheetPlan("month").ctaLabel)
})

// --- escape hatches ---------------------------------------------------------

test("the labelled escape is context-appropriate and never degrades anything", () => {
  const scan = renderSheet({ context: { feature: "merkliste", source: "scan:verdict" } }).render()
  assert.equal(textContent(requireOne(scan, "data-premium-sheet-dismiss")), "Weiter scannen")

  const trigger = renderSheet({
    context: { feature: "routine", source: "trigger:frust-serie" },
  }).render()
  assert.equal(textContent(requireOne(trigger, "data-premium-sheet-dismiss")), "Weiter scannen")

  const gated = renderSheet({ context: { feature: "routine", source: "gated:routine" } }).render()
  assert.equal(textContent(requireOne(gated, "data-premium-sheet-dismiss")), "Später")
})

test("dismissing always escapes: the escape button and onOpenChange(false)", () => {
  let closed = 0
  const harness = renderSheet({ onClose: () => (closed += 1) })
  const tree = harness.render()

  requireOne(tree, "data-premium-sheet-dismiss").props.onClick()
  assert.equal(closed, 1, "the labelled escape closes the sheet")

  const sheet = tree as AnyElement // <BottomSheet> is the outermost element
  sheet.props.onOpenChange(false)
  assert.equal(closed, 2, "backdrop / Escape / X / drag dismiss the sheet")

  sheet.props.onOpenChange(true)
  assert.equal(closed, 2, "re-opening must not call onClose")
})

test("T14: the CTA opens checkout in place — it neither closes the sheet nor navigates", () => {
  let closed = 0
  const harness = renderSheet({ onClose: () => (closed += 1) })

  requireOne(harness.render(), "data-premium-sheet-cta").props.onClick()
  const paying = harness.render()

  assert.equal(closed, 0, "starting a payment must never close the sheet")
  // Plan rows and the CTA give way to the checkout body; the escape stays.
  assert.equal(byData(paying, "data-premium-sheet-plans").length, 0)
  assert.equal(byData(paying, "data-premium-sheet-cta").length, 0)
  assert.ok(findByType(contentOf(paying), PremiumSheetCheckout), "checkout is mounted in the body")
  assert.equal(textContent(requireOne(paying, "data-premium-sheet-dismiss")), "Plan ändern")
})

test("T14: the mid-payment escape returns to the plan rows instead of closing the sheet", () => {
  let closed = 0
  const harness = renderSheet({ onClose: () => (closed += 1) })
  requireOne(harness.render(), "data-premium-sheet-cta").props.onClick()

  requireOne(harness.render(), "data-premium-sheet-dismiss").props.onClick()
  const back = harness.render()

  assert.equal(closed, 0, "the free session is never ended by backing out of a payment")
  assert.equal(byData(back, "data-premium-sheet-plans").length, 1)
  assert.equal(findByType(contentOf(back), PremiumSheetCheckout), null)
})
