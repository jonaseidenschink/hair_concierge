import assert from "node:assert/strict"
import test from "node:test"
import React, { type ReactElement, type ReactNode } from "react"

import { GatedPreview } from "../src/components/gated-preview/gated-preview"
import { PremiumSheet } from "../src/components/premium-sheet/premium-sheet"

/**
 * `GatedPreview` is a "use client" component with a single `useState` (the sheet's
 * open flag). This repo has no jsdom/testing-library, so — same harness family as
 * `tests/scan-flow-ui.test.tsx`, trimmed to the one hook this component uses — the
 * component function is called under a hand-rolled dispatcher and the returned element
 * tree is walked. `<PremiumSheet>` is never invoked, only matched by type, so no
 * portal/Radix/DOM is pulled in: the assertions read the props it is handed.
 */

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

function findByData(node: ReactNode, attribute: string): AnyElement[] {
  return findAll(node, (element) => element.props[attribute] !== undefined)
}

function requireByData(node: ReactNode, attribute: string): AnyElement {
  const matches = findByData(node, attribute)
  assert.equal(matches.length, 1, `expected exactly one [${attribute}]`)
  return matches[0]
}

// --- hook harness (useState only) -------------------------------------------

type ReactDispatcherInternals = { H: unknown }

function createStateHarness(renderComponent: () => ReactElement | null) {
  const reactInternals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: ReactDispatcherInternals
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const hookValues: unknown[] = []
  let cursor = 0

  const dispatcher = {
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

// --- fixtures ---------------------------------------------------------------

const EXAMPLE_LABEL = "Beispiel · eine Chaarlie-Routine"
const BENEFIT = "Vier geprüfte Bausteine, die zusammenpassen."
const CTA = "Routine freischalten"

function renderPreview(overrides: Partial<Parameters<typeof GatedPreview>[0]> = {}) {
  return createStateHarness(() =>
    GatedPreview({
      feature: "routine",
      source: "routine:gate",
      exampleLabel: EXAMPLE_LABEL,
      benefit: BENEFIT,
      cta: CTA,
      children: <p data-example-child="true">Beispielinhalt</p>,
      ...overrides,
    }),
  )
}

// --- tests ------------------------------------------------------------------

test("renders the frame, the Beispiel band, the benefit line and exactly one CTA", () => {
  const tree = renderPreview().render()

  const frame = requireByData(tree, "data-gated-preview-frame")
  assert.match(frame.props.className as string, /rounded-\[20px\]/)
  assert.match(frame.props.className as string, /border/)
  assert.match(frame.props.className as string, /overflow-hidden/)

  const label = requireByData(tree, "data-gated-preview-label")
  assert.equal(textContent(label), EXAMPLE_LABEL)

  const ctaBlock = requireByData(tree, "data-gated-preview-cta-block")
  assert.ok(textContent(ctaBlock).includes(BENEFIT), "benefit line renders above the CTA")

  const buttons = findAll(tree, (element) => (element.props.variant as string) === "cta")
  assert.equal(buttons.length, 1, "exactly one CTA — one job, one button")
  assert.equal(textContent(buttons[0]), CTA)

  // The whole surface is one screen: the page body must not grow with the example.
  const section = requireByData(tree, "data-gated-preview")
  assert.equal(section.props["data-gated-preview"], "routine")
  assert.match(section.props.className as string, /100dvh/)
})

test("the example content sits inside the one in-frame scroll container", () => {
  const tree = renderPreview().render()

  const scroll = requireByData(tree, "data-gated-preview-scroll")
  assert.match(scroll.props.className as string, /overflow-y-auto/)
  // Flex child that may shrink below its content — otherwise the frame grows instead.
  assert.match(scroll.props.className as string, /min-h-0/)

  // Keyboard users must be able to reach and scroll the region.
  assert.equal(scroll.props.role, "region")
  assert.equal(scroll.props["aria-label"], EXAMPLE_LABEL)
  assert.equal(scroll.props.tabIndex, 0)

  const child = findByData(scroll, "data-example-child")
  assert.equal(child.length, 1, "children render inside the scroll container, not beside it")

  // No second scroller anywhere in the tree.
  assert.equal(
    findAll(tree, (element) => /overflow-y-auto/.test(String(element.props.className ?? "")))
      .length,
    1,
  )
})

test("the CTA opens the Premium sheet with the exact page context", () => {
  const harness = renderPreview({ feature: "chat", source: "chat:gate" })

  const closed = harness.render()
  const sheetBefore = findAll(closed, (element) => element.type === PremiumSheet)
  assert.equal(sheetBefore.length, 1)
  assert.equal(sheetBefore[0].props.open, false, "sheet stays closed until the CTA is tapped")

  const cta = findAll(closed, (element) => (element.props.variant as string) === "cta")[0]
  cta.props.onClick()

  const opened = harness.render()
  const sheetAfter = findAll(opened, (element) => element.type === PremiumSheet)[0]
  assert.equal(sheetAfter.props.open, true)
  assert.deepEqual(sheetAfter.props.context, { feature: "chat", source: "chat:gate" })

  // Dismissing closes it again — no other exit path is needed.
  sheetAfter.props.onClose()
  const reclosed = harness.render()
  assert.equal(findAll(reclosed, (element) => element.type === PremiumSheet)[0].props.open, false)
})

test("every user-facing string comes from the caller — the component hard-codes no copy", () => {
  const tree = renderPreview({
    feature: "anwendung",
    source: "anwendung:gate",
    exampleLabel: "Beispiel · ein Chaarlie-Haartag",
    benefit: "Jeder Haartag begleitet, Schritt für Schritt.",
    cta: "Anwendung freischalten",
  }).render()

  const rendered = textContent(tree)
  assert.match(rendered, /Beispiel · ein Chaarlie-Haartag/)
  assert.match(rendered, /Jeder Haartag begleitet, Schritt für Schritt\./)
  assert.match(rendered, /Anwendung freischalten/)
  // Nothing from the Routine fixture leaks in as a default.
  assert.doesNotMatch(rendered, /Chaarlie-Routine/)
  assert.doesNotMatch(rendered, /Premium freischalten/)
})
