import assert from "node:assert/strict"
import test from "node:test"
import React, { type ReactElement, type ReactNode } from "react"

import {
  ScanCategoryRepeatCard,
  ScanProactiveTriggerCard,
} from "../src/components/scan/scan-trigger-cards"
import type { ScanProactiveTriggerId } from "../src/lib/scan/triggers/trigger-rules"

/**
 * Pure-render tests for T10's two new card components, same harness family as
 * `tests/scan-free-verdict-ui.test.tsx`: both components are hook-free, so the component
 * function is called directly and the returned element tree is walked — no DOM needed.
 */

// --- element-tree helpers (mirrors scan-free-verdict-ui.test.tsx) -----------

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

function deepRender(node: ReactNode, depth = 0): ReactNode {
  if (depth > 40) return node
  if (Array.isArray(node)) return node.map((child) => deepRender(child, depth))
  if (!React.isValidElement(node)) return node
  const element = node as AnyElement
  if (typeof element.type === "function") {
    try {
      return deepRender((element.type as (props: unknown) => ReactNode)(element.props), depth + 1)
    } catch {
      return element
    }
  }
  const children = element.props.children
  if (children === undefined || children === null) return element
  const rendered = React.Children.toArray(children).map((child) => deepRender(child, depth + 1))
  return React.cloneElement(element, undefined, ...rendered)
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

/**
 * `next/link`'s `Link` needs a router context this pure-render harness does not provide,
 * so `deepRender` leaves it unexpanded (its `try/catch` swallows the missing-dispatcher
 * throw) — assert on the `href` prop directly rather than assuming it flattens to `<a>`.
 */
function findByHref(node: ReactNode): AnyElement[] {
  return findAll(node, (element) => element.props.href !== undefined)
}

// --- ScanProactiveTriggerCard ------------------------------------------------

const PROACTIVE_IDS: ScanProactiveTriggerId[] = [
  "kategorien_luecke",
  "passt_gut_moment",
  "frust_serie",
  "wiederkehrer",
]

test("ScanProactiveTriggerCard: renders a card for every proactive trigger id with its own copy", () => {
  for (const id of PROACTIVE_IDS) {
    const tree = deepRender(ScanProactiveTriggerCard({ id, onOpenSheet: () => {} }))
    const card = findByData(tree, "data-scan-trigger-card")
    assert.equal(card.length, 1)
    assert.equal(card[0].props["data-scan-trigger-card"], id)
    assert.ok(textContent(card[0]).length > 0)
    // F8: the section has an accessible name — no more anonymous region in the a11y tree.
    assert.ok(
      typeof card[0].props["aria-label"] === "string" && card[0].props["aria-label"].length > 0,
    )
    // F8: the CTA's data attribute is namespaced per trigger id, not a bare "" shared
    // across every card (a future Playwright selector on it would otherwise match many).
    const cta = findByData(tree, "data-scan-trigger-cta")
    assert.equal(cta.length, 1)
    assert.equal(cta[0].props["data-scan-trigger-cta"], id)
  }
})

test("ScanProactiveTriggerCard: kategorien_luecke links into /routine instead of opening the sheet", () => {
  let opened = 0
  const tree = deepRender(
    ScanProactiveTriggerCard({ id: "kategorien_luecke", onOpenSheet: () => (opened += 1) }),
  )
  const cta = findByHref(tree)
  assert.equal(cta.length, 1)
  assert.equal(cta[0].props.href, "/routine")
  assert.equal(findAll(tree, (element) => element.type === "button").length, 0)
  assert.equal(opened, 0)
})

test("ScanProactiveTriggerCard: passt_gut_moment/frust_serie/wiederkehrer open the sheet via a button", () => {
  for (const id of ["passt_gut_moment", "frust_serie", "wiederkehrer"] as const) {
    let opened = 0
    const tree = deepRender(ScanProactiveTriggerCard({ id, onOpenSheet: () => (opened += 1) }))
    const cta = findAll(tree, (element) => element.type === "button")
    assert.equal(cta.length, 1, `expected exactly one button for ${id}`)
    assert.equal(findAll(tree, (element) => element.type === "a").length, 0)
    cta[0].props.onClick()
    assert.equal(opened, 1)
  }
})

// --- ScanCategoryRepeatCard ---------------------------------------------------

test("ScanCategoryRepeatCard: renders its own card, names the repeated category, and opens the sheet on tap", () => {
  let opened = 0
  const tree = deepRender(
    ScanCategoryRepeatCard({ categoryLabel: "Shampoo", onOpenSheet: () => (opened += 1) }),
  )
  const card = findByData(tree, "data-scan-trigger-card")
  assert.equal(card.length, 1)
  assert.equal(card[0].props["data-scan-trigger-card"], "zwei_scans_gleiche_kategorie")
  // F3/F7: an honest, non-debug-label title that names the actual repeated category.
  assert.ok(textContent(card[0]).includes("Shampoo"))

  const cta = findAll(tree, (element) => element.type === "button")
  assert.equal(cta.length, 1)
  // F8: the CTA's data attribute is namespaced, not a bare "" shared with the other card.
  assert.equal(cta[0].props["data-scan-trigger-cta"], "zwei_scans_gleiche_kategorie")
  cta[0].props.onClick()
  assert.equal(opened, 1)
})
