import assert from "node:assert/strict"
import test from "node:test"
import React, { type ReactElement, type ReactNode } from "react"

import { BottomSheetContent } from "@/components/ui/bottom-sheet"
import { PremiumSheet } from "@/components/premium-sheet/premium-sheet"
import { PREMIUM_FEATURES } from "@/lib/premium-sheet/context"

/**
 * `PremiumSheet` is a "use client" stub with no hooks of its own (the ordering is a pure
 * function call), so — same harness family as `tests/scan-flow-ui.test.tsx` — it can be
 * invoked directly as a plain function and its returned element tree walked. `BottomSheet`
 * / `BottomSheetContent` are never invoked, only matched by type, so no portal/DOM/jsdom
 * is needed.
 */

type AnyElement = ReactElement<Record<string, any>>

function childrenOf(node: ReactNode): ReactNode[] {
  if (!React.isValidElement(node)) return []
  return React.Children.toArray((node as ReactElement<{ children?: ReactNode }>).props.children)
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (!React.isValidElement(node)) return ""
  const element = node as AnyElement
  // `BottomSheetTitle`/`BottomSheetDescription` are never invoked either, but their text
  // still lives in `props.children`, same as any host element.
  return childrenOf(element)
    .map((child) => textContent(child))
    .join("")
}

function findByType(node: ReactNode, type: AnyElement["type"]): AnyElement | null {
  if (!React.isValidElement(node)) return null
  const element = node as AnyElement
  if (element.type === type) return element
  for (const child of childrenOf(element)) {
    const found = findByType(child, type)
    if (found) return found
  }
  return null
}

function requireByType(node: ReactNode, type: AnyElement["type"], label: string): AnyElement {
  const found = findByType(node, type)
  assert.ok(found, `expected to find ${label}`)
  return found
}

test("renders kicker, headline and the tapped feature's three ordered benefits, first accented", () => {
  const tree = PremiumSheet({
    open: true,
    context: { feature: "chat", source: "test" },
    onClose: () => {},
  })

  const content = requireByType(tree, BottomSheetContent, "BottomSheetContent")
  const header = content.props.header as ReactNode
  const footer = content.props.footer as ReactNode
  const body = content.props.children as ReactNode

  assert.match(textContent(header), /Chaarlie Premium/)
  assert.match(textContent(header), /Alles für dein Haar\./)

  // Benefit order for the "chat" context: chat, routine, empfehlungen (T5 algorithm).
  const expectedOrder = ["chat", "routine", "empfehlungen"] as const
  const items = childrenOf(body)
  assert.equal(items.length, expectedOrder.length)

  items.forEach((item, index) => {
    const featureId = expectedOrder[index]
    const feature = PREMIUM_FEATURES[featureId]
    const text = textContent(item)
    assert.match(text, new RegExp(feature.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    assert.match(text, new RegExp(feature.benefit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  })

  // First benefit is visually accented (plum), the rest aren't.
  const firstClassName = (items[0] as AnyElement).props.className as string
  const secondClassName = (items[1] as AnyElement).props.className as string
  assert.match(firstClassName, /brand-plum/)
  assert.doesNotMatch(secondClassName, /brand-plum/)

  assert.match(textContent(footer), /Weiter/)
})

test("falls back to the default three benefits when context is null", () => {
  const tree = PremiumSheet({ open: true, context: null, onClose: () => {} })
  const content = requireByType(tree, BottomSheetContent, "BottomSheetContent")
  const items = childrenOf(content.props.children as ReactNode)

  assert.equal(items.length, 3)
  assert.match(textContent(items[0]), new RegExp(PREMIUM_FEATURES.routine.name))
  assert.match(textContent(items[1]), new RegExp(PREMIUM_FEATURES.empfehlungen.name))
  assert.match(textContent(items[2]), new RegExp(PREMIUM_FEATURES.chat.name))
})

test("onClose fires from the placeholder Weiter button and the sheet's onOpenChange(false)", () => {
  let closed = false
  const tree = PremiumSheet({
    open: true,
    context: { feature: "routine", source: "test" },
    onClose: () => {
      closed = true
    },
  })

  const content = requireByType(tree, BottomSheetContent, "BottomSheetContent")
  const footer = content.props.footer as AnyElement
  footer.props.onClick()
  assert.equal(closed, true, "Weiter should call onClose")

  closed = false
  const sheet = tree as AnyElement // <BottomSheet> is the outermost element
  sheet.props.onOpenChange(false)
  assert.equal(closed, true, "dismissing the sheet (backdrop/escape/x) should call onClose")

  closed = false
  sheet.props.onOpenChange(true)
  assert.equal(closed, false, "re-opening must not call onClose")
})
