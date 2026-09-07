import assert from "node:assert/strict"
import test from "node:test"
import React, { type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { CATEGORY_COPY } from "../src/components/personal-plan-products/stage3-product-copy"
import { ScanUnknownFlow, type ScanSubmissionInput } from "../src/components/scan/scan-unknown-flow"
import { PERSONAL_PLAN_PRODUCT_CATEGORIES } from "../src/lib/personal-plan/products/contracts"
import type { ScanUnknownProductResult } from "../src/lib/scan/types"

/**
 * `ScanUnknownFlow` is a "use client" component with `useState` — this repo has no
 * jsdom/testing-library, so interaction tests instead call the component function
 * directly under a hand-rolled hook dispatcher and walk the returned element tree
 * (same harness as `tests/personal-plan-stage4-interaction-ui.test.tsx`).
 */

type AnyElement = ReactElement<Record<string, any>>

type ReactDispatcherInternals = {
  H: unknown
}

function withClientHooks<T>(render: () => T): { value: T; rerender: () => T } {
  const reactInternals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: ReactDispatcherInternals
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const previousDispatcher = reactInternals.H
  const hookValues: unknown[] = []
  let cursor = 0

  const dispatcher = {
    useState<Value>(
      initialState: Value | (() => Value),
    ): [Value, (nextState: Value | ((previous: Value) => Value)) => void] {
      const stateIndex = cursor
      cursor += 1
      if (hookValues.length <= stateIndex) {
        hookValues[stateIndex] =
          typeof initialState === "function" ? (initialState as () => Value)() : initialState
      }
      return [
        hookValues[stateIndex] as Value,
        (nextState) => {
          hookValues[stateIndex] =
            typeof nextState === "function"
              ? (nextState as (previous: Value) => Value)(hookValues[stateIndex] as Value)
              : nextState
        },
      ]
    },
  }

  function run() {
    cursor = 0
    reactInternals.H = dispatcher
    try {
      return render()
    } finally {
      reactInternals.H = previousDispatcher
    }
  }

  return { value: run(), rerender: run }
}

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

function unknownResult(): ScanUnknownProductResult {
  return {
    kind: "unknown_product",
    identifier: { type: "ean", value: "4006381333931" },
    // Mirrors how `/api/scan/resolve` builds this payload (every category, in the
    // catalog's declared order).
    categories: PERSONAL_PLAN_PRODUCT_CATEGORIES.map((key) => ({
      key,
      label: CATEGORY_COPY[key].label,
    })),
  }
}

function renderFlow(props: {
  submitting: boolean
  error?: string | null
  onSubmit: (input: ScanSubmissionInput) => void
}) {
  return withClientHooks(() =>
    ScanUnknownFlow({
      unknown: unknownResult(),
      submitting: props.submitting,
      error: props.error ?? null,
      onSubmit: props.onSubmit,
    }),
  )
}

function categoryButton(tree: ReactNode, label: string): AnyElement {
  const match = findAll(
    tree,
    (element) => element.type === "button" && textContent(element) === label,
  )[0]
  assert.ok(match, `Expected a category button labeled "${label}"`)
  return match
}

test("ScanUnknownFlow: renders the signed-off headline and question verbatim", () => {
  const tree = renderFlow({ submitting: false, onSubmit: () => undefined })
  const markup = renderToStaticMarkup(tree.value)
  assert.match(markup, /Danke dir – das ist neu für uns!/)
  assert.match(markup, /Wir nehmen es auf\. Dein Ergebnis kommt in den Chat\./)
  assert.match(markup, /Wobei benutzt du es\?/)
})

/**
 * The viewfinder just said "✓ Gelesen – wird geprüft" and this sheet says the product is
 * new: without the bridge line the two read as a contradiction (Nick's phone test,
 * plan 2026-09-05). It has to sit between the headline and the existing subline.
 */
test("ScanUnknownFlow: the bridge line sits under the headline, above the subline", () => {
  const tree = renderFlow({ submitting: false, onSubmit: () => undefined })
  const markup = renderToStaticMarkup(tree.value)
  assert.match(markup, /Barcode gelesen – das Produkt fehlt noch in unserer Datenbank\./)

  const headline = markup.indexOf("Danke dir")
  const bridge = markup.indexOf("Barcode gelesen")
  const subline = markup.indexOf("Wir nehmen es auf")
  assert.ok(headline >= 0 && bridge > headline && subline > bridge, markup)
})

test("ScanUnknownFlow: renders no brand or product-name inputs (step 2 is gone)", () => {
  const tree = renderFlow({ submitting: false, onSubmit: () => undefined })
  const inputs = findAll(tree.value, (element) => element.type === "input")
  assert.deepEqual(inputs, [])
  const markup = renderToStaticMarkup(tree.value)
  assert.doesNotMatch(markup, /Marke/)
  assert.doesNotMatch(markup, /Produktname/)
  assert.doesNotMatch(markup, /Zur Prüfung einreichen/)
})

test("ScanUnknownFlow: tapping a category card submits exactly { category } once, no Absenden step", () => {
  const submissions: ScanSubmissionInput[] = []
  const tree = renderFlow({
    submitting: false,
    onSubmit: (input) => submissions.push(input),
  })

  const shampooLabel = CATEGORY_COPY.shampoo.label
  const card = categoryButton(tree.value, shampooLabel)
  assert.equal(card.props.disabled, false)
  card.props.onClick()

  assert.deepEqual(submissions, [{ category: "shampoo" }])
  // No "Weiter"/step-2 control exists to gate the submit behind a second tap.
  assert.deepEqual(
    findAll(tree.value, (element) => textContent(element) === "Weiter"),
    [],
  )
})

test("ScanUnknownFlow: cards are disabled while submitting and a second tap does not resubmit", () => {
  const submissions: ScanSubmissionInput[] = []
  const tree = renderFlow({
    submitting: true,
    onSubmit: (input) => submissions.push(input),
  })

  const conditionerLabel = CATEGORY_COPY.conditioner.label
  const card = categoryButton(tree.value, conditionerLabel)
  // Structural: the disabled attribute really is set while a request is in flight.
  assert.equal(card.props.disabled, true)

  // Behavioral: even a direct tap (bypassing the HTML `disabled` attribute) must not
  // fire a second submit — `handleTap` itself guards on the `submitting` prop.
  card.props.onClick()
  card.props.onClick()
  assert.deepEqual(submissions, [])

  // The "Weitere Produktarten" expander is disabled too.
  const expander = findAll(
    tree.value,
    (element) => element.type === "button" && textContent(element) === "Weitere Produktarten",
  )[0]
  assert.ok(expander)
  assert.equal(expander.props.disabled, true)
})

test("ScanUnknownFlow: the tapped card alone shows the submitting label while others stay put", () => {
  // `submitting` is read from a mutable box on every render so `tree.rerender()` can
  // pick up the parent's post-tap state change (mirrors `scan-flow.tsx`: `onSubmit`
  // triggers `setSubmitting(true)` one render after the tap) while the hook harness
  // keeps `tappedCategory`'s state across that rerender.
  const parentState = { submitting: false }
  const tree = withClientHooks(() =>
    ScanUnknownFlow({
      unknown: unknownResult(),
      submitting: parentState.submitting,
      error: null,
      onSubmit: () => undefined,
    }),
  )

  const maskLabel = CATEGORY_COPY.mask.label
  categoryButton(tree.value, maskLabel).props.onClick()
  parentState.submitting = true
  tree.value = tree.rerender()

  // Exactly one card swapped its label to the submitting placeholder — the tapped one.
  const submittingCards = findAll(
    tree.value,
    (element) => element.type === "button" && textContent(element) === "Wird eingereicht",
  )
  assert.equal(submittingCards.length, 1)
  assert.doesNotMatch(renderToStaticMarkup(tree.value), new RegExp(maskLabel))

  // Every other primary category still renders its own plain label, not the
  // submitting placeholder.
  for (const key of ["shampoo", "conditioner", "leave_in", "oil"] as const) {
    categoryButton(tree.value, CATEGORY_COPY[key].label)
  }
})

test("ScanUnknownFlow: a failed submission clears the in-flight highlight next to the error (F17)", () => {
  // The parent settles the request: `submitting` goes back to false and an error line
  // appears. The card the user tapped must stop claiming it is still being submitted.
  const parentState = { submitting: false, error: null as string | null }
  const tree = withClientHooks(() =>
    ScanUnknownFlow({
      unknown: unknownResult(),
      submitting: parentState.submitting,
      error: parentState.error,
      onSubmit: () => undefined,
    }),
  )

  const oilLabel = CATEGORY_COPY.oil.label
  categoryButton(tree.value, oilLabel).props.onClick()
  parentState.submitting = true
  tree.value = tree.rerender()
  assert.equal(
    findAll(tree.value, (element) => textContent(element) === "Wird eingereicht").length > 0,
    true,
  )

  parentState.submitting = false
  parentState.error = "Hat nicht geklappt – versuch's nochmal."
  tree.value = tree.rerender()

  const markup = renderToStaticMarkup(tree.value)
  assert.doesNotMatch(markup, /Wird eingereicht/)
  assert.match(markup, /Hat nicht geklappt/)
  // …and the card is no longer rendered as the selected one.
  const card = categoryButton(tree.value, oilLabel)
  assert.equal(card.props["aria-pressed"], false)
  assert.doesNotMatch(String(card.props.className), /brand-plum-ice/)
})
