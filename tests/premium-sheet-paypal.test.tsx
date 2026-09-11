import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import React, { type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { PremiumSheetCheckout } from "@/components/premium-sheet/premium-sheet-checkout"
import {
  PayPalSubscriptionIntentRequestSchema,
  resolvePayPalCheckoutPricingCatalog,
} from "@/app/api/paypal/create-subscription-intent/route"
import { StripeCheckoutSessionRequestSchema } from "@/app/api/stripe/create-checkout-session/route"
import { isPersonalPlanLaunchPricingEnabled } from "@/lib/funnel/flags"
import {
  premiumSheetCompletionBody,
  premiumSheetPayPalReference,
} from "@/lib/premium-sheet/purchase-reference"

/**
 * Docket rework R1 — the Premium sheet's native PayPal button (Nick's ruling A2).
 *
 * T14 assumed PayPal could be served through Stripe's embedded checkout; the Stripe
 * account does not have PayPal enabled, so the sheet offered none. The ruling is to reuse
 * the offer page's proven `PayPalSubscriptionButton` verbatim and diverge in exactly one
 * place — where the approval routes. These assertions pin both halves of that: the sheet
 * really mounts THAT component with the contextual completion, and the offer page's own
 * behaviour is untouched when the new prop is absent.
 */

const buttonSource = readFileSync(
  new URL("../src/components/checkout/paypal-subscription-button.tsx", import.meta.url),
  "utf8",
)
const offerMountSource = readFileSync(
  new URL("../src/components/checkout/payment-method-checkout.tsx", import.meta.url),
  "utf8",
)

// --- tree helpers (same family as tests/premium-sheet-component.test.tsx) ----

type AnyElement = ReactElement<Record<string, any>>

function childrenOf(node: ReactNode): ReactNode[] {
  if (!React.isValidElement(node)) return []
  return React.Children.toArray((node as ReactElement<{ children?: ReactNode }>).props.children)
}

function findAll(node: ReactNode, predicate: (element: AnyElement) => boolean): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate))
  if (!React.isValidElement(node)) return []
  const element = node as AnyElement
  const matches = predicate(element) ? [element] : []
  return [...matches, ...childrenOf(element).flatMap((child) => findAll(child, predicate))]
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (!React.isValidElement(node)) return ""
  return childrenOf(node)
    .map((child) => textContent(child))
    .join("")
}

/** `PremiumSheetCheckout`'s only hooks are useMemo / useCallback / useRef. */
function renderCheckout(props: Parameters<typeof PremiumSheetCheckout>[0]): ReactElement | null {
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown }
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const dispatcher = {
    useMemo<T>(factory: () => T): T {
      return factory()
    },
    useCallback<T>(callback: T): T {
      return callback
    },
    useRef<T>(initialValue: T): { current: T } {
      return { current: initialValue }
    },
  }
  const previous = internals.H
  internals.H = dispatcher
  try {
    return PremiumSheetCheckout(props)
  } finally {
    internals.H = previous
  }
}

function withPayPal<T>(enabled: boolean, run: () => T): T {
  const previous = process.env.NEXT_PUBLIC_PAYPAL_ENABLED
  process.env.NEXT_PUBLIC_PAYPAL_ENABLED = enabled ? "true" : "false"
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_PAYPAL_ENABLED
    else process.env.NEXT_PUBLIC_PAYPAL_ENABLED = previous
  }
}

function checkoutTree(
  enabled: boolean,
  overrides: Partial<Parameters<typeof PremiumSheetCheckout>[0]> = {},
) {
  return withPayPal(enabled, () =>
    renderCheckout({
      interval: "quarter",
      attemptId: "attempt-1",
      returnPath: "/scan",
      onReady: () => {},
      onFailed: () => {},
      onCompleted: () => {},
      ...overrides,
    }),
  )
}

function paypalBlock(tree: ReactNode): AnyElement | null {
  return (
    findAll(tree, (element) => element.props["data-premium-sheet-paypal"] !== undefined)[0] ?? null
  )
}

/** The dynamically-imported button is the one element carrying `source`. */
function paypalButton(tree: ReactNode): AnyElement {
  const found = findAll(tree, (element) => element.props.source !== undefined)
  assert.equal(found.length, 1, "expected exactly one PayPal button in the payment step")
  return found[0]
}

// --- the mount --------------------------------------------------------------

test("R1: the sheet's payment step mounts the PayPal button below the card form", () => {
  const tree = checkoutTree(true)
  const block = paypalBlock(tree)
  assert.ok(block, "the PayPal block is rendered")

  // Below the Stripe form, not inside it, and visually its own (Nick: an extra button).
  const parts = childrenOf(tree)
  assert.equal(parts.length, 2, "the card form and the PayPal block are siblings")
  assert.ok(
    findAll(parts[0], (element) => element.props["data-premium-sheet-paypal"] !== undefined)
      .length === 0,
    "PayPal is not nested inside the Stripe checkout container",
  )
  assert.match(textContent(block), /oder/, "the offer page's „oder“ divider separates them")
})

test("R1: with PayPal disabled the payment step is byte-for-byte the card form it was", () => {
  assert.equal(paypalBlock(checkoutTree(false)), null)
})

test("R1: the button is configured for the sheet — premium_sheet source, selected interval", () => {
  const button = paypalButton(checkoutTree(true, { interval: "year", attemptId: "attempt-9" }))
  assert.equal(
    button.props.source,
    "premium_sheet",
    "the sheet's own checkout source — what pins its PayPal plan to the standard catalog",
  )
  assert.equal(button.props.interval, "year", "the row the buyer selected, not a default")
  assert.equal(button.props.checkoutAttemptId, "attempt-9")
})

test("R1: an approval finishes IN the sheet — the reference is handed back, nothing navigates", () => {
  const completed: [string, string][] = []
  const button = paypalButton(
    checkoutTree(true, {
      onCompleted: (reference, attemptId) => completed.push([reference, attemptId]),
    }),
  )

  assert.equal(typeof button.props.onApproved, "function", "the completion override is passed")
  button.props.onApproved("intent-token-abc")

  assert.deepEqual(completed, [["paypal:intent-token-abc", "attempt-1"]])
})

test("R1: a PayPal failure never replaces the live card form with a failure screen", () => {
  // The button surfaces its own errors inline, exactly as on the offer page. Wiring them
  // into the sheet's purchase machine would let a missing PayPal client id kill a card
  // payment that is already in progress.
  const button = paypalButton(checkoutTree(true))
  assert.equal(button.props.onCheckoutFailed, undefined)
})

test("R1: the payment step renders for real, with the PayPal button's own placeholder", () => {
  // Not the hand-rolled dispatcher above: a real React render, so a hook-order or render
  // crash in the new branch cannot hide behind the harness. `ssr: false` means what is
  // rendered here is the dynamic import's loading placeholder — the same one the offer
  // page shows while the PayPal SDK loads.
  const html = withPayPal(true, () =>
    renderToStaticMarkup(
      <PremiumSheetCheckout
        interval="quarter"
        attemptId="attempt-1"
        returnPath="/scan"
        onReady={() => {}}
        onFailed={() => {}}
        onCompleted={() => {}}
      />,
    ),
  )
  assert.match(html, /data-premium-sheet-paypal="true"/)
  assert.match(html, />PayPal</)
  assert.match(html, /PayPal öffnet sich zur Bestätigung/)

  const withoutPayPal = withPayPal(false, () =>
    renderToStaticMarkup(
      <PremiumSheetCheckout
        interval="quarter"
        attemptId="attempt-1"
        returnPath="/scan"
        onReady={() => {}}
        onFailed={() => {}}
        onCompleted={() => {}}
      />,
    ),
  )
  assert.doesNotMatch(withoutPayPal, /PayPal/)
})

// --- the offer page is untouched --------------------------------------------

test("R1: without the override the button still navigates to /welcome, as it always did", () => {
  assert.match(
    buttonSource,
    /if \(onApproved\) onApproved\(token\)\s*\n\s*else window\.location\.assign\(buildPayPalWelcomeUrl\(token\)\)/,
    "the historical navigation is the else branch, not a rewrite",
  )
  // Exactly one completion site: the approval cannot route two ways by accident.
  assert.equal(buttonSource.match(/buildPayPalWelcomeUrl\(token\)/g)?.length, 1)
})

test("R1: the offer page's mount passes no completion override", () => {
  const mount = offerMountSource.slice(
    offerMountSource.indexOf("<DynamicPayPalSubscriptionButton"),
    offerMountSource.indexOf("</PaymentOptionExposure>"),
  )
  assert.ok(mount.length > 0, "found the offer page's PayPal mount")
  assert.doesNotMatch(mount, /onApproved/, "the offer page keeps the /welcome navigation")
})

// --- the reference ----------------------------------------------------------

test("R1: the purchase reference names its provider, and Stripe's stays untagged", () => {
  assert.equal(premiumSheetPayPalReference("tok-1"), "paypal:tok-1")
  assert.deepEqual(premiumSheetCompletionBody("paypal:tok-1"), { paypalToken: "tok-1" })
  // A Stripe reference is the Session id exactly as before — a purchase persisted by an
  // earlier deploy still resumes through the same request shape.
  assert.deepEqual(premiumSheetCompletionBody("cs_test_1"), { sessionId: "cs_test_1" })
})

// --- the price the PayPal lane actually charges ------------------------------

test("R1: the sheet's PayPal plan is pinned to the standard catalog, whatever the launch flag says", () => {
  for (const launchPricingEnabled of [false, true]) {
    const previous = process.env.PERSONAL_PLAN_LAUNCH_PRICING_ENABLED
    process.env.PERSONAL_PLAN_LAUNCH_PRICING_ENABLED = launchPricingEnabled ? "true" : "false"
    try {
      assert.equal(isPersonalPlanLaunchPricingEnabled(), launchPricingEnabled)
      assert.equal(
        resolvePayPalCheckoutPricingCatalog("premium_sheet"),
        "standard",
        `premium_sheet must never follow the launch catalog (flag: ${launchPricingEnabled})`,
      )
      // Every other entry point keeps following the flag, exactly as before.
      for (const source of ["pricing_page", "quiz_result_offer"] as const) {
        assert.equal(
          resolvePayPalCheckoutPricingCatalog(source),
          launchPricingEnabled ? "personal_plan_launch_v1" : "standard",
        )
      }
    } finally {
      if (previous === undefined) delete process.env.PERSONAL_PLAN_LAUNCH_PRICING_ENABLED
      else process.env.PERSONAL_PLAN_LAUNCH_PRICING_ENABLED = previous
    }
  }
})

// --- intent contract alignment (cleanup batch) -------------------------------

const paypalSheetRequest = {
  interval: "year" as const,
  source: "premium_sheet" as const,
  checkoutAttemptId: "9f2a8ad0-2b23-4f2f-9e9f-2b64bd4a1d20",
  funnelEventId: "9f2a8ad0-2b23-4f2f-9e9f-2b64bd4a1d24",
}

const stripeSheetRequest = {
  interval: "year" as const,
  source: "premium_sheet" as const,
  checkoutAttemptId: paypalSheetRequest.checkoutAttemptId,
  returnPath: "/scan",
}

test("PayPal's premium_sheet contract now refuses what Stripe's has always refused", () => {
  assert.equal(PayPalSubscriptionIntentRequestSchema.safeParse(paypalSheetRequest).success, true)
  assert.equal(StripeCheckoutSessionRequestSchema.safeParse(stripeSheetRequest).success, true)

  const extraFields: Record<string, unknown>[] = [
    { leadId: "9f2a8ad0-2b23-4f2f-9e9f-2b64bd4a1d22" },
    { checkoutContext: "membership_reactivation" },
    { returnDestination: "/profile" },
  ]
  for (const extra of extraFields) {
    assert.equal(
      PayPalSubscriptionIntentRequestSchema.safeParse({ ...paypalSheetRequest, ...extra }).success,
      false,
      `PayPal premium_sheet must refuse ${JSON.stringify(extra)}, same as Stripe's route`,
    )
    // The mirrored direction: Stripe's own schema already refuses the equivalent shape —
    // this is not a new restriction invented here, only PayPal catching up to it.
    assert.equal(
      StripeCheckoutSessionRequestSchema.safeParse({ ...stripeSheetRequest, ...extra }).success,
      false,
      "Stripe's contract is the one being mirrored — it must still refuse the same shape",
    )
  }
})

test("funnelEventId and checkoutAttemptId stay allowed for premium_sheet on both routes", () => {
  assert.equal(PayPalSubscriptionIntentRequestSchema.safeParse(paypalSheetRequest).success, true)
  assert.equal(
    StripeCheckoutSessionRequestSchema.safeParse({
      interval: "year",
      source: "premium_sheet",
      checkoutAttemptId: paypalSheetRequest.checkoutAttemptId,
      returnPath: "/scan",
    }).success,
    true,
  )
})
