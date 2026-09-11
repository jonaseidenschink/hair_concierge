import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import React from "react"

import {
  usePlanSelection,
  type PlanSelectionChange,
} from "@/components/checkout/use-plan-selection"
import type { BillingInterval } from "@/lib/stripe/intervals"
import { formatStripePlanDetail, getStripePricingPlan } from "@/lib/stripe/pricing-plans"

/**
 * T13's extraction: the offer page (`MembershipResultOfferPricing`) and the Premium sheet
 * share ONE plan-selection model. These tests pin the shared behaviour and prove the
 * offer page still drives its analytics from it — its own suites
 * (`result-offer-pricing-tracking`, `personal-plan-offer-page`, `subscription-plan-selector`)
 * stay unmodified and cover the rendered result.
 */

type ReactDispatcherInternals = { H: unknown }
type MemoRecord<T> = { deps: unknown[] | undefined; value: T }

function createHookHarness<T>(run: () => T) {
  const reactInternals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: ReactDispatcherInternals
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const hookValues: unknown[] = []
  let cursor = 0

  const dispatcher = {
    useCallback<F extends (...args: never[]) => unknown>(callback: F, deps?: unknown[]): F {
      return this.useMemo(() => callback, deps)
    },
    useMemo<V>(factory: () => V, deps?: unknown[]): V {
      const index = cursor
      cursor += 1
      const previous = hookValues[index] as MemoRecord<V> | undefined
      const changed =
        !previous?.deps ||
        !deps ||
        previous.deps.length !== deps.length ||
        deps.some((dep, position) => dep !== previous.deps![position])
      if (previous && !changed) return previous.value
      const value = factory()
      hookValues[index] = { deps, value } satisfies MemoRecord<V>
      return value
    },
    useState<V>(initialState: V | (() => V)): [V, (next: V | ((previous: V) => V)) => void] {
      const index = cursor
      cursor += 1
      if (hookValues.length <= index) {
        hookValues[index] =
          typeof initialState === "function" ? (initialState as () => V)() : initialState
      }
      return [
        hookValues[index] as V,
        (next) => {
          hookValues[index] =
            typeof next === "function" ? (next as (previous: V) => V)(hookValues[index] as V) : next
        },
      ]
    },
    useRef<V>(initialValue: V): { current: V } {
      const index = cursor
      cursor += 1
      if (hookValues.length <= index) {
        hookValues[index] = { current: initialValue }
      }
      return hookValues[index] as { current: V }
    },
  }

  return () => {
    cursor = 0
    const previousDispatcher = reactInternals.H
    reactInternals.H = dispatcher
    try {
      return run()
    } finally {
      reactInternals.H = previousDispatcher
    }
  }
}

test("selection starts on the surface's default and reports every change once", () => {
  const render = createHookHarness(() => usePlanSelection({ defaultInterval: "quarter" }))

  assert.equal(render().selectedInterval, "quarter")

  const changes: PlanSelectionChange[] = []
  changes.push(render().selectPlan("year"))
  assert.equal(render().selectedInterval, "year")
  changes.push(render().selectPlan("month"))
  assert.equal(render().selectedInterval, "month")
  // Re-selecting the same interval is still a selection event (offer-page behaviour).
  changes.push(render().selectPlan("month"))

  assert.deepEqual(changes, [
    { interval: "year", previousInterval: "quarter", isDefault: false, selectionIndex: 1 },
    { interval: "month", previousInterval: "year", isDefault: false, selectionIndex: 2 },
    { interval: "month", previousInterval: "month", isDefault: false, selectionIndex: 3 },
  ] satisfies PlanSelectionChange[])
})

test("isDefault tracks the surface's own preselection", () => {
  const sheet = createHookHarness(() => usePlanSelection({ defaultInterval: "year" }))
  assert.equal(sheet().selectedInterval, "year")
  assert.equal(sheet().selectPlan("month").isDefault, false)
  assert.equal(sheet().selectPlan("year").isDefault, true)

  // No argument = the catalog default the offer page uses.
  const offer = createHookHarness(() => usePlanSelection())
  assert.equal(offer().selectedInterval, "quarter")
  assert.equal(offer().selectPlan("quarter").isDefault, true)
})

test("the offer page drives offer_plan_selected from the shared hook", () => {
  const source = readFileSync(
    new URL("../src/components/quiz/result-offer-pricing.tsx", import.meta.url),
    "utf8",
  )

  assert.match(
    source,
    /import \{ usePlanSelection \} from "@\/components\/checkout\/use-plan-selection"/,
  )
  assert.match(source, /const \{ selectedInterval, selectPlan \} = usePlanSelection\(\{/)
  assert.match(source, /defaultInterval: DEFAULT_PRICING_INTERVAL/)
  assert.match(source, /const change = selectPlan\(interval\)/)
  assert.match(source, /isDefault: change\.isDefault/)
  assert.match(source, /previousInterval: change\.previousInterval/)
  assert.match(source, /selectionIndex: change\.selectionIndex/)
  // The lock guard still short-circuits BEFORE anything is selected or tracked.
  assert.match(
    source,
    /if \(lockRef\.current\) return\s*\n\s*const change = selectPlan\(interval\)/,
  )
  // No second copy of the selection state left behind.
  assert.doesNotMatch(source, /planSelectionIndexRef/)
  assert.doesNotMatch(source, /setSelectedInterval/)
})

test("both plan-row surfaces format the detail line from the same catalog fields", () => {
  const selector = readFileSync(
    new URL("../src/components/checkout/subscription-plan-selector.tsx", import.meta.url),
    "utf8",
  )
  assert.match(selector, /formatStripePlanDetail\(plan\)/)
  assert.doesNotMatch(selector, /function getPlanDetail/)

  const details: Record<BillingInterval, string> = {
    year: "~€8,33 / Monat · 44% sparen",
    quarter: "~€11,66 / Monat · 22% sparen",
    month: "/ Monat",
  }
  for (const [interval, expected] of Object.entries(details) as Array<[BillingInterval, string]>) {
    assert.equal(formatStripePlanDetail(getStripePricingPlan(interval, "standard")), expected)
  }
})
