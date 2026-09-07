import assert from "node:assert/strict"
import test from "node:test"
import React, { type ReactElement, type ReactNode } from "react"

import { ScannerView, type ScannerViewProps } from "../src/components/scan/scanner-view"
import {
  SCAN_CONFIRM_LABEL,
  SCAN_HINT_DEFAULT,
  SCAN_HINT_MORE_LIGHT,
  SCAN_HINT_SPOTTED,
} from "../src/lib/scan/guidance"

/**
 * The viewfinder's visual states (plan 2026-09-05, Task 2). `ScannerView` is pure — every
 * input is a prop — so the element tree is produced by calling it directly and walked
 * here; no camera, no hook, no jsdom. The derivation that feeds these props lives in
 * `deriveViewfinderPresentation` and is covered in `tests/scan-detection-state.test.ts`.
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

function withAttribute(node: ReactNode, attribute: string): AnyElement[] {
  return findAll(node, (element) => element.props[attribute] !== undefined)
}

function classNames(node: ReactNode): string[] {
  return findAll(node, (element) => typeof element.props.className === "string").map(
    (element) => element.props.className as string,
  )
}

function hasClass(node: ReactNode, className: string): boolean {
  return classNames(node).some((value) => value.split(/\s+/).includes(className))
}

function onlyWith(node: ReactNode, attribute: string): AnyElement {
  const matches = withAttribute(node, attribute)
  assert.equal(matches.length, 1, `Expected exactly one [${attribute}]`)
  return matches[0]
}

/** The visible hint / spotted / confirm pill. */
function pill(node: ReactNode): AnyElement {
  return onlyWith(node, "data-scan-pill")
}

/** The visually-hidden polite live region. */
function announcement(node: ReactNode): AnyElement {
  return onlyWith(node, "data-scan-announcement")
}

function detectionAttribute(node: ReactNode): string {
  return onlyWith(node, "data-scan-detection").props["data-scan-detection"] as string
}

// --- rendering --------------------------------------------------------------

const RECT = { left: 40, top: 90, width: 120, height: 48 }

function view(overrides: Partial<ScannerViewProps> = {}): ReactElement {
  return ScannerView({
    visual: "searching",
    outlineBox: null,
    hint: SCAN_HINT_DEFAULT,
    confirmActive: false,
    detectionPaused: false,
    videoRef: { current: null },
    frameRef: { current: null },
    announcement: SCAN_HINT_DEFAULT,
    ...overrides,
  })
}

// --- the visual states ------------------------------------------------------

test("ScannerView: searching shows the pulsing dot, the breathing corners and the idle hint", () => {
  const tree = view()

  assert.equal(detectionAttribute(tree), "searching")
  assert.equal(textContent(pill(tree)), SCAN_HINT_DEFAULT)
  assert.equal(withAttribute(tree, "data-scan-pill-dot").length, 1)
  assert.equal(withAttribute(tree, "data-scan-outline").length, 0)
  // One breathing class per corner marker.
  assert.equal(
    classNames(tree).filter((value) => value.split(/\s+/).includes("animate-scan-breathe")).length,
    4,
  )
})

test("ScannerView: a situational hint replaces the idle text while the dot stays", () => {
  const tree = view({ hint: SCAN_HINT_MORE_LIGHT, announcement: SCAN_HINT_MORE_LIGHT })

  assert.equal(textContent(pill(tree)), SCAN_HINT_MORE_LIGHT)
  assert.equal(withAttribute(tree, "data-scan-pill-dot").length, 1)
})

test("ScannerView: a spotted barcode gets the amber outline and the hold-still pill", () => {
  const tree = view({ visual: "spotted", outlineBox: RECT, announcement: SCAN_HINT_SPOTTED })

  assert.equal(detectionAttribute(tree), "spotted")
  const outline = onlyWith(tree, "data-scan-outline")
  assert.equal(outline.props["data-scan-outline"], "spotted")
  assert.match(outline.props.className as string, /border-\[#e0a13a\]/)
  assert.equal((outline.props.style as Record<string, string>).left, "40px")

  assert.equal(textContent(pill(tree)), SCAN_HINT_SPOTTED)
  assert.match(pill(tree).props.className as string, /bg-\[#b97a17\]/)
  // The dot and the breathing corners belong to "still looking", not to "found it".
  assert.equal(withAttribute(tree, "data-scan-pill-dot").length, 0)
  assert.equal(hasClass(tree, "animate-scan-breathe"), false)
})

test("ScannerView: an accepted decode turns the outline green and the pill plum", () => {
  const tree = view({
    visual: "read",
    outlineBox: RECT,
    confirmActive: true,
    announcement: SCAN_CONFIRM_LABEL,
  })

  assert.equal(detectionAttribute(tree), "read")
  const outline = onlyWith(tree, "data-scan-outline")
  assert.equal(outline.props["data-scan-outline"], "read")
  assert.match(outline.props.className as string, /border-\[var\(--status-ok-text\)\]/)

  assert.equal(textContent(pill(tree)), `✓ ${SCAN_CONFIRM_LABEL}`)
  assert.match(pill(tree).props.className as string, /bg-\[var\(--brand-plum\)\]/)
  assert.equal(withAttribute(tree, "data-scan-pill-dot").length, 0)
})

test("ScannerView: the read confirm keeps its motion while the sheet rises over it", () => {
  const tree = view({
    visual: "read",
    outlineBox: RECT,
    confirmActive: true,
    detectionPaused: true,
    announcement: SCAN_CONFIRM_LABEL,
  })

  // Paused, but inside the confirm window: the green moment belongs to the user's decode.
  assert.equal(detectionAttribute(tree), "read")
  assert.equal(textContent(pill(tree)), `✓ ${SCAN_CONFIRM_LABEL}`)
  assert.equal(withAttribute(tree, "data-scan-outline").length, 1)
})

test("ScannerView: a sheet over the viewfinder freezes the dot and the breathing corners", () => {
  const tree = view({ detectionPaused: true })

  assert.equal(detectionAttribute(tree), "searching")
  assert.equal(withAttribute(tree, "data-scan-pill-dot").length, 0)
  assert.equal(hasClass(tree, "animate-scan-breathe"), false)
  assert.equal(hasClass(tree, "animate-scan-dot"), false)
  // The pill still says what it says; only the motion stops.
  assert.equal(textContent(pill(tree)), SCAN_HINT_DEFAULT)
})

// --- the accessible status --------------------------------------------------

test("ScannerView: only the visually-hidden sibling is a live region", () => {
  const tree = view({ visual: "spotted", outlineBox: RECT, announcement: SCAN_HINT_SPOTTED })

  // The pill flips as fast as the detector does; the live region is the debounced copy.
  assert.equal(pill(tree).props["aria-live"], undefined)
  const region = announcement(tree)
  assert.equal(region.props["aria-live"], "polite")
  assert.match(region.props.className as string, /\bsr-only\b/)
  assert.equal(textContent(region), SCAN_HINT_SPOTTED)
})

test("ScannerView: the live region can lag the pill without changing what is drawn", () => {
  // Exactly what the 1s rate limit produces: the pill is already amber while the live
  // region still holds the idle hint it announced a moment ago.
  const tree = view({ visual: "spotted", outlineBox: RECT, announcement: SCAN_HINT_DEFAULT })

  assert.equal(textContent(pill(tree)), SCAN_HINT_SPOTTED)
  assert.equal(textContent(announcement(tree)), SCAN_HINT_DEFAULT)
})
