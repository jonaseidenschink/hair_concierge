import assert from "node:assert/strict"
import test from "node:test"

import { resolveSubscriptionPricingCatalog } from "@/lib/billing/pricing-catalog"
import { isPersonalPlanLaunchPricingEnabled } from "@/lib/funnel/flags"
import {
  premiumSheetPlan,
  premiumSheetPlans,
  PREMIUM_SHEET_DEFAULT_INTERVAL,
  PREMIUM_SHEET_PLAN_ORDER,
  PREMIUM_SHEET_PRICING_CATALOG,
  PREMIUM_SHEET_RECOMMENDED_BADGE,
  PREMIUM_SHEET_RECOMMENDED_INTERVAL,
} from "@/lib/premium-sheet/pricing"
import { PERSONAL_PLAN_LAUNCH_PRICING_PLANS } from "@/lib/stripe/pricing-plans"

/**
 * Plan §11 F06: the launch catalog (69,99 / 19,99 / 9,99) and the standard catalog can
 * diverge, and the offer page follows the `PERSONAL_PLAN_LAUNCH_PRICING_ENABLED` flag.
 * The Premium sheet must NOT — it sells the standard subscription at 99,99 / 34,99 /
 * 14,99, whatever the flag says. These assertions run with the flag in both states.
 */
const EXPECTED = {
  year: {
    price: "99,99 €",
    amount: 99.99,
    analyticsId: "premium_year",
    name: "Jährlich",
    detail: "~€8,33 / Monat · 44% sparen",
  },
  quarter: {
    price: "34,99 €",
    amount: 34.99,
    analyticsId: "premium_quarter",
    name: "Vierteljährlich",
    detail: "~€11,66 / Monat · 22% sparen",
  },
  month: {
    price: "14,99 €",
    amount: 14.99,
    analyticsId: "premium_month",
    name: "Monatlich",
    // No savings to compare against — the row stays a single line.
    detail: "",
  },
} as const

const LAUNCH_AMOUNTS = PERSONAL_PLAN_LAUNCH_PRICING_PLANS.map((plan) => plan.amount)

function withLaunchPricing<T>(enabled: boolean, run: () => T): T {
  const previous = process.env.PERSONAL_PLAN_LAUNCH_PRICING_ENABLED
  process.env.PERSONAL_PLAN_LAUNCH_PRICING_ENABLED = enabled ? "true" : "false"
  try {
    // Guard the guard: the flag really is live for this block.
    assert.equal(isPersonalPlanLaunchPricingEnabled(), enabled)
    return run()
  } finally {
    if (previous === undefined) delete process.env.PERSONAL_PLAN_LAUNCH_PRICING_ENABLED
    else process.env.PERSONAL_PLAN_LAUNCH_PRICING_ENABLED = previous
  }
}

for (const launchPricingEnabled of [false, true]) {
  test(`sheet plans stay on the standard catalog with launch pricing ${
    launchPricingEnabled ? "ON" : "OFF"
  }`, () => {
    withLaunchPricing(launchPricingEnabled, () => {
      // The flag-aware resolver every other subscription surface uses DOES move …
      assert.equal(
        resolveSubscriptionPricingCatalog(isPersonalPlanLaunchPricingEnabled()),
        launchPricingEnabled ? "personal_plan_launch_v1" : "standard",
      )
      // … and the sheet's pinned catalog does not.
      assert.equal(PREMIUM_SHEET_PRICING_CATALOG, "standard")

      const rows = premiumSheetPlans()
      assert.deepEqual(
        rows.map((row) => row.interval),
        ["year", "quarter", "month"],
        "Jährlich · Vierteljährlich · Monatlich, in that order",
      )
      assert.deepEqual(
        rows.map((row) => ({
          price: row.price,
          amount: row.amount,
          analyticsId: row.analyticsId,
          name: row.name,
          detail: row.detail,
        })),
        PREMIUM_SHEET_PLAN_ORDER.map((interval) => EXPECTED[interval]),
      )
      assert.deepEqual(
        rows.map((row) => row.currency),
        ["EUR", "EUR", "EUR"],
      )

      // No launch amount can reach the sheet through any field.
      for (const row of rows) {
        assert.ok(!LAUNCH_AMOUNTS.includes(row.amount), `launch amount leaked: ${row.amount}`)
        for (const value of [row.price, row.detail, row.ctaLabel]) {
          for (const launchPrice of ["69,99", "19,99", "9,99"]) {
            // Boundary-guarded: "9,99" is a substring of the legitimate "99,99".
            const leak = new RegExp(String.raw`(?<![\d,])` + launchPrice)
            assert.ok(!leak.test(value), `launch price "${launchPrice}" leaked: ${value}`)
          }
        }
      }
    })
  })
}

/**
 * Docket rework R2 (Nick's ruling A3): the favourite moved from Jährlich to
 * Vierteljährlich, and the marker took the offer page's own wording with it.
 */
test("Vierteljährlich is both the preselected and the recommended row", () => {
  assert.equal(PREMIUM_SHEET_DEFAULT_INTERVAL, "quarter")
  assert.equal(PREMIUM_SHEET_RECOMMENDED_INTERVAL, "quarter")
  assert.equal(PREMIUM_SHEET_RECOMMENDED_BADGE, "Beliebteste Wahl")
  // Row order is unchanged — only the marker and the preselection moved.
  assert.deepEqual(
    premiumSheetPlans().map((row) => row.interval),
    ["year", "quarter", "month"],
  )
  assert.deepEqual(
    premiumSheetPlans().map((row) => row.recommended),
    [false, true, false],
  )
})

test("the CTA label carries the selected plan's standard price", () => {
  assert.equal(premiumSheetPlan("year").ctaLabel, "Jetzt starten — €99,99 / Jahr")
  assert.equal(premiumSheetPlan("quarter").ctaLabel, "Jetzt starten — €34,99 im Quartal")
  assert.equal(premiumSheetPlan("month").ctaLabel, "Jetzt starten — €14,99 / Monat")
})
