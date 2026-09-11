import assert from "node:assert/strict"
import test from "node:test"
import React, { type ReactElement, type ReactNode } from "react"

import { ScanActionFooter } from "../src/components/scan/scan-action-footer"
import { ScanResultCard } from "../src/components/scan/scan-result-card"
import { ScanWishlistTrigger } from "../src/components/scan/scan-wishlist-sheet"
import type { ScanMaskedVerdictResult } from "../src/lib/scan/masked-alternative"
import type {
  ScanAlternativePresentation,
  ScanProductHeader,
  ScanResolvedVerdictResult,
} from "../src/lib/scan/types"

/**
 * The free tier's verdict states (T9), asserted on the element trees the components
 * return. All three components under test are hook-free, so they are called directly —
 * no dispatcher harness is needed here (unlike `tests/scan-flow-ui.test.tsx`, which
 * mounts the stateful `ScanFlow`).
 *
 * Two invariants carry the whole task and are asserted in every state below:
 * - a masked verdict never renders an identity (the response carries none, so a leak
 *   would have to be invented by the UI), and
 * - a response WITHOUT the masking marker renders today's UI unchanged.
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

/**
 * Expands nested function components in place, so an assertion can reach markup the card
 * delegates to (`ScanMaskedAlternatives`, the alternatives list, `ScanLockBadge`) without
 * a DOM. Every component in these trees is hook-free; one that is not simply stays an
 * unexpanded element rather than throwing the test.
 */
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

/** Elements carrying `data-<attribute>`, whatever their value. */
function findByData(node: ReactNode, attribute: string): AnyElement[] {
  return findAll(node, (element) => element.props[attribute] !== undefined)
}

function findByClass(node: ReactNode, fragment: string): AnyElement[] {
  return findAll(
    node,
    (element) =>
      typeof element.props.className === "string" && element.props.className.includes(fragment),
  )
}

/** Every button/link in the tree, as its visible text. */
function actionLabels(node: ReactNode): string[] {
  return findAll(node, (element) => element.type === "button" || element.type === "a").map(
    (element) => textContent(element),
  )
}

// --- fixtures ---------------------------------------------------------------

const PRODUCT: ScanProductHeader = {
  productId: "p-scanned",
  name: "Lab Shampoo Alpha",
  brand: "Chaarlie Lab",
  category: "shampoo",
  categoryLabel: "Shampoo",
  imageUrl: null,
  priceLabel: "12,99 €",
  purchaseUrl: null,
}

const IN_CATALOG_BASE = {
  kind: "in_catalog" as const,
  verdict: "mismatch" as const,
  verdictLabel: "Passt nicht",
  verdictTitle: "Passt nicht zu deinem Haar",
  status: "danger" as const,
  subtitle: "1 von 3 Zielbereichen getroffen",
  evaluatedRole: null,
  evaluatedRoleLabel: null,
  dimensions: [],
  criteria: [],
  coverage: null,
  fitNarrative: null,
  product: PRODUCT,
  snapshotSource: "refined" as const,
  savedState: { state: null, managedByScan: false },
}

const FULL_ALTERNATIVE: ScanAlternativePresentation = {
  productId: "p-alternative",
  displayName: "Lab Shampoo Gamma",
  imageUrl: null,
  priceLabel: "9,99 €",
  netContentLabel: "250 ml",
  verdict: "ideal",
  verdictLabel: "Passt",
  brand: "Chaarlie Lab",
  purchaseUrl: null,
}

function maskedResult(freeRevealAvailable: boolean): ScanMaskedVerdictResult {
  return {
    ...IN_CATALOG_BASE,
    alternatives: [
      {
        verdict: "ideal",
        verdictLabel: "Passt",
        comparison: {
          rows: [
            { rowId: "care_weight", label: "Pflegegewicht", state: "match" },
            { rowId: "cleansing", label: "Reinigungsstärke", state: "match" },
            { rowId: "silicones", label: "Silikone", state: "partial" },
            { rowId: "protein", label: "Protein", state: "unknown" },
          ],
          summaryScore: 0.5,
        },
      },
    ],
    freeRevealAvailable,
  }
}

const PREMIUM_RESULT: ScanResolvedVerdictResult = {
  ...IN_CATALOG_BASE,
  alternatives: [FULL_ALTERNATIVE],
}

const noop = () => {}

function renderCard(
  overrides: Partial<Parameters<typeof ScanResultCard>[0]> & {
    result: Parameters<typeof ScanResultCard>[0]["result"]
  },
): ReactNode {
  return deepRender(
    ScanResultCard({
      onRescan: noop,
      onOpenAlternative: noop,
      onBuyAlternative: noop,
      ...overrides,
    }),
  )
}

// --- masked comparison table -------------------------------------------------

test("free verdict: the masked alternative's comparison rows are fully readable", () => {
  const tree = renderCard({ result: maskedResult(true) })
  const masked = findByData(tree, "data-scan-masked-alternatives")
  assert.equal(masked.length, 1)

  const text = textContent(masked[0])
  for (const label of ["Pflegegewicht", "Reinigungsstärke", "Silikone", "Protein"]) {
    assert.ok(text.includes(label), `expected the comparison row "${label}" to be readable`)
  }
  // The fit verdict of the alternative is readable too — only the identity is not.
  assert.ok(text.includes("Passt"))
  assert.ok(text.includes("Noch verdeckt"))
  // 2 of the 4 rows are "match".
  assert.ok(text.includes("2 von 4 Prüfpunkten im Ziel"))

  // Every row state renders its own accessible mark.
  const markLabels = findAll(masked[0], (element) => element.props.role === "img").map(
    (element) => element.props["aria-label"],
  )
  assert.deepEqual(markLabels, ["Im Ziel", "Im Ziel", "Passt mit Einschränkung", "Nicht bestätigt"])
})

test("free verdict: nothing in the masked tree names the alternative", () => {
  const tree = renderCard({ result: maskedResult(true) })
  const text = textContent(findByData(tree, "data-scan-masked-alternatives")[0])
  // The scanned product's own identity is never masked, but it is also not part of the
  // alternatives block — so no product name may appear inside it at all.
  assert.equal(text.includes("Lab Shampoo"), false)
  assert.equal(text.includes("9,99"), false)
})

// --- first reveal ------------------------------------------------------------

test('first „passt nicht": the one-lifetime reveal CTA is offered, verbatim and alone', () => {
  let revealed = 0
  const tree = renderCard({ result: maskedResult(true), onReveal: () => (revealed += 1) })

  const cta = findByData(tree, "data-scan-reveal-cta")
  assert.equal(cta.length, 1)
  assert.equal(textContent(cta[0]), "Produkt aufdecken — einmalig gratis")
  assert.equal(findByData(tree, "data-scan-premium-cta").length, 0)

  cta[0].props.onClick()
  assert.equal(revealed, 1)
})

test("first reveal: the CTA is busy-disabled while the request is in flight", () => {
  const tree = renderCard({ result: maskedResult(true), revealPending: true })
  const cta = findByData(tree, "data-scan-reveal-cta")[0]
  assert.equal(cta.props.disabled, true)
  assert.equal(cta.props["aria-busy"], true)
})

test("after the reveal: the full alternative card replaces the masked one, inside the unblur", () => {
  const tree = renderCard({
    result: maskedResult(true),
    revealedAlternatives: [FULL_ALTERNATIVE],
  })

  assert.equal(findByData(tree, "data-scan-masked-alternatives").length, 0)
  const revealed = findByData(tree, "data-scan-revealed-alternatives")
  assert.equal(revealed.length, 1)
  // The 1.2s unblur is the wrapper's own class (globals.css), so reduced motion can make
  // it inert without the component knowing.
  assert.equal(findByClass(tree, "scan-reveal-unblur").length, 1)

  const text = textContent(revealed[0])
  assert.ok(text.includes("Lab Shampoo Gamma"))
  assert.ok(text.includes("Chaarlie Lab · 9,99 €"))
  // No CTA survives the reveal: the user got what the credit bought.
  assert.equal(findByData(tree, "data-scan-reveal-cta").length, 0)
  assert.equal(findByData(tree, "data-scan-premium-cta").length, 0)
})

test("fix round 1 (F2): a silent (background) re-serve renders the same card without the unblur", () => {
  const tree = renderCard({
    result: maskedResult(true),
    revealedAlternatives: [FULL_ALTERNATIVE],
    revealAnimates: false,
  })

  const revealed = findByData(tree, "data-scan-revealed-alternatives")
  assert.equal(revealed.length, 1)
  assert.ok(textContent(revealed[0]).includes("Lab Shampoo Gamma"))
  // The only difference from an explicit tap: no unblur wrapper class.
  assert.equal(findByClass(tree, "scan-reveal-unblur").length, 0)
})

test("fix round 1 (F4): an empty revealed list falls back to the empty-alternative notice, not nothing", () => {
  const tree = renderCard({ result: maskedResult(true), revealedAlternatives: [] })

  assert.equal(findByData(tree, "data-scan-revealed-alternatives").length, 0)
  assert.equal(findByData(tree, "data-scan-masked-alternatives").length, 0)
  const notice = findByData(tree, "data-scan-reveal-empty")
  assert.equal(notice.length, 1)
  assert.equal(textContent(notice[0]), "Aktuell keine Alternative gefunden.")
})

// --- post-reveal locked state ------------------------------------------------

test('later „passt nicht": the spent credit turns the CTA into the Premium gate', () => {
  let opened = 0
  const tree = renderCard({
    result: maskedResult(false),
    onPremiumAlternatives: () => (opened += 1),
  })

  assert.equal(findByData(tree, "data-scan-reveal-cta").length, 0)
  const cta = findByData(tree, "data-scan-premium-cta")
  assert.equal(cta.length, 1)
  assert.equal(textContent(cta[0]), "Was passt stattdessen?")
  cta[0].props.onClick()
  assert.equal(opened, 1)

  // The comparison table is still fully readable — the gate is on identity, not on proof.
  assert.ok(textContent(tree).includes("Pflegegewicht"))
})

test("a 409 already_used mid-session flips the CTA even though the response said available", () => {
  const tree = renderCard({ result: maskedResult(true), revealUnavailable: true })
  assert.equal(findByData(tree, "data-scan-reveal-cta").length, 0)
  assert.equal(findByData(tree, "data-scan-premium-cta").length, 1)
})

// --- no „Warum?" entry points ------------------------------------------------

test('no free verdict state offers a „Warum?" entry point', () => {
  for (const result of [maskedResult(true), maskedResult(false)]) {
    for (const labels of [
      actionLabels(renderCard({ result })),
      actionLabels(renderCard({ result, revealedAlternatives: [FULL_ALTERNATIVE] })),
    ]) {
      assert.equal(
        labels.some((label) => label.includes("Warum")),
        false,
        `unexpected „Warum?" affordance among ${JSON.stringify(labels)}`,
      )
    }
  }
})

// --- premium / flag-off stays exactly today's UI ------------------------------

test("premium: a response without the masking marker renders today's alternatives list", () => {
  const tree = renderCard({ result: PREMIUM_RESULT })

  assert.equal(findByData(tree, "data-scan-masked-alternatives").length, 0)
  assert.equal(findByData(tree, "data-scan-revealed-alternatives").length, 0)
  assert.equal(findByData(tree, "data-scan-reveal-cta").length, 0)
  assert.equal(findByData(tree, "data-scan-premium-cta").length, 0)
  assert.equal(findByClass(tree, "scan-reveal-unblur").length, 0)

  const text = textContent(tree)
  assert.ok(text.includes("Passende Alternativen"))
  assert.ok(text.includes("Lab Shampoo Gamma"))
})

test("premium: the free-state props are inert even when a caller passes them", () => {
  // The gate is the response shape, never the props: a premium verdict handed the same
  // reveal props as a free one must still render today's list.
  const tree = renderCard({
    result: PREMIUM_RESULT,
    revealedAlternatives: [FULL_ALTERNATIVE],
    revealPending: true,
    revealUnavailable: true,
  })
  assert.equal(findByData(tree, "data-scan-revealed-alternatives").length, 0)
  assert.ok(textContent(tree).includes("Passende Alternativen"))
})

// --- Merken lock -------------------------------------------------------------

test("Merken lock: the footer save slot keeps its label and gains a corner lock", () => {
  const locked = deepRender(
    ScanActionFooter({
      kind: "in_catalog",
      verdict: "mismatch",
      product: PRODUCT,
      savedState: { state: null, managedByScan: false },
      saveLocked: true,
      onSave: noop,
      onBuy: noop,
    }),
  )

  const save = findByData(locked, "data-scan-save-locked")
  assert.equal(save.length, 1)
  // The lock marks the action, it does not replace it.
  assert.ok(textContent(save[0]).includes("Speichern"))
  assert.equal(save[0].props["aria-label"], "Speichern — Premium")
  assert.equal(findByData(locked, "data-scan-lock-badge").length, 1)
})

test("Merken lock: an unlocked footer is byte-identical to today's", () => {
  const unlocked = deepRender(
    ScanActionFooter({
      kind: "in_catalog",
      verdict: "mismatch",
      product: PRODUCT,
      savedState: { state: null, managedByScan: false },
      onSave: noop,
      onBuy: noop,
    }),
  )

  assert.equal(findByData(unlocked, "data-scan-save-locked").length, 0)
  assert.equal(findByData(unlocked, "data-scan-lock-badge").length, 0)
  assert.deepEqual(actionLabels(unlocked), ["Speichern"])
})

test("Merken lock: the bookmark symbol stays visible under its corner marker", () => {
  const triggerElement = ScanWishlistTrigger({ onClick: noop, locked: true }) as AnyElement
  assert.equal(triggerElement.props["data-scan-wishlist-locked"], "true")
  assert.equal(triggerElement.props["aria-label"], "Merkliste öffnen — Premium")
  assert.ok((triggerElement.props.className as string).includes("relative"))
  const locked = deepRender(triggerElement)
  const badge = findByData(locked, "data-scan-lock-badge")
  assert.equal(badge.length, 1)
  // Decorative marker, and the bookmark icon itself is still rendered beside it.
  assert.equal(badge[0].props["aria-hidden"], "true")
  assert.equal(childrenOf(triggerElement).length, 2)
})

test("Merken lock: an unlocked bookmark trigger is byte-identical to today's (PR2 review fix, C4)", () => {
  const open = ScanWishlistTrigger({ onClick: noop }) as AnyElement
  assert.equal(open.props["aria-label"], "Merkliste öffnen")
  // Not merely "false": the attribute and the "relative" class must be entirely absent,
  // matching this component's pre-T9 markup for every premium/flag-off render.
  assert.equal("data-scan-wishlist-locked" in open.props, false)
  assert.equal((open.props.className as string).includes("relative"), false)
  const rendered = deepRender(open)
  assert.equal(findByData(rendered, "data-scan-lock-badge").length, 0)
})
