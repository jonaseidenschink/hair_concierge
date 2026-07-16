import assert from "node:assert/strict"
import test from "node:test"

import {
  type CadencePolicyRow,
  computeObservedCadences,
  daysSinceLastWash,
  estimateObservedWashCadencePerWeek,
} from "../src/lib/tracking/aggregation"
import type { TrackerLogDay } from "../src/lib/tracking/types"

const TARGET_BAND = {
  minFrequency: "weekly_1x",
  maxFrequency: "weekly_2x",
  preferredFrequency: "weekly_1x",
} as const

const CADENCE_POLICIES: CadencePolicyRow[] = [
  {
    category: "shampoo",
    cadencePolicy: { kind: "baseline_cleansing", shampooFrequency: "weekly_2x" },
  },
  {
    category: "conditioner",
    cadencePolicy: {
      kind: "match_shampoo_frequency",
      shampooFrequency: "weekly_2x",
      expected: "after_every_wash",
    },
  },
  {
    category: "mask",
    cadencePolicy: {
      kind: "need_based_support",
      supportNeed: "moderate",
      loadSensitive: false,
      suggestedBand: "weekly_1x",
      targetBand: TARGET_BAND,
    },
  },
  {
    category: "dry_shampoo",
    cadencePolicy: {
      kind: "bridge_between_washes",
      shampooFrequency: "weekly_2x",
      expected: "short_bridge_only",
      targetBand: TARGET_BAND,
    },
  },
  {
    category: "hairspray",
    cadencePolicy: {
      kind: "need_based_support",
      supportNeed: "low",
      loadSensitive: false,
      suggestedBand: "weekly_1x",
      targetBand: TARGET_BAND,
    },
  },
]

function washDay(date: string, categories: string[]): TrackerLogDay {
  return {
    loggedOn: date,
    dayType: "wash",
    products: categories.map((category) => ({
      category,
      productName: null,
      userProductUsageId: null,
    })),
  }
}

function noneDay(date: string): TrackerLogDay {
  return { loggedOn: date, dayType: "none", products: [] }
}

function customDay(date: string, categories: string[]): TrackerLogDay {
  return {
    loggedOn: date,
    dayType: "custom",
    customActivityName: "Sauna",
    products: categories.map((category) => ({
      category,
      productName: null,
      userProductUsageId: null,
    })),
  }
}

const DENSE_WEEKS: TrackerLogDay[] = [
  washDay("2026-06-08", ["shampoo", "mask"]),
  noneDay("2026-06-09"),
  washDay("2026-06-11", ["shampoo"]),
  noneDay("2026-06-13"),
  washDay("2026-06-15", ["shampoo"]),
  noneDay("2026-06-16"),
  washDay("2026-06-18", ["shampoo", "mask"]),
  noneDay("2026-06-20"),
]

test("observed wash cadence: 4 washes over 2 observed weeks -> 2/week", () => {
  assert.equal(estimateObservedWashCadencePerWeek(DENSE_WEEKS), 2)
})

test("observed wash cadence: null with fewer than 2 observed weeks", () => {
  assert.equal(estimateObservedWashCadencePerWeek([washDay("2026-06-10", ["shampoo"])]), null)
})

test("shampoo cadence is the measured wash rhythm, not the self-report", () => {
  const cadences = computeObservedCadences(DENSE_WEEKS, 5, CADENCE_POLICIES)
  const shampoo = cadences.find((c) => c.category === "shampoo")
  assert.ok(shampoo)
  assert.equal(shampoo.basis, "wash_rhythm")
  assert.equal(shampoo.weeklyCadence, 2)
})

test("shampoo emits no cadence when wash rhythm is unobserved (sparse logging)", () => {
  const days = [washDay("2026-06-10", ["shampoo"]), washDay("2026-06-14", ["shampoo"])]
  const cadences = computeObservedCadences(days, 2, CADENCE_POLICIES)
  assert.equal(
    cadences.find((c) => c.category === "shampoo"),
    undefined,
  )
})

test("need-based policy: mask uses observed-week cadence instead of wash share", () => {
  const cadences = computeObservedCadences(DENSE_WEEKS, null, CADENCE_POLICIES)
  const mask = cadences.find((c) => c.category === "mask")
  assert.ok(mask)
  assert.equal(mask.basis, "day_level")
  assert.equal(mask.anchorSource, null)
  assert.equal(mask.weeklyCadence, 1)
})

test("match-shampoo policy falls back to self-reported anchor for sparse loggers", () => {
  const days = [
    washDay("2026-06-10", ["shampoo", "conditioner"]),
    washDay("2026-06-14", ["shampoo"]),
    washDay("2026-06-17", ["shampoo", "conditioner"]),
    washDay("2026-06-21", ["shampoo"]),
  ]
  const cadences = computeObservedCadences(days, 2, CADENCE_POLICIES)
  const conditioner = cadences.find((c) => c.category === "conditioner")
  assert.ok(conditioner)
  assert.equal(conditioner.anchorSource, "self_reported")
  assert.equal(conditioner.weeklyCadence, 1)
})

test("match-shampoo policy without any anchor emits no cadence", () => {
  const days = [washDay("2026-06-10", ["conditioner"])]
  const cadences = computeObservedCadences(days, null, CADENCE_POLICIES)
  assert.equal(
    cadences.find((c) => c.category === "conditioner"),
    undefined,
  )
})

test("match-shampoo cadence excludes product use from partially observed weeks", () => {
  const days = [
    washDay("2026-06-08", ["shampoo", "conditioner"]),
    noneDay("2026-06-09"),
    washDay("2026-06-11", ["shampoo"]),
    noneDay("2026-06-13"),
    washDay("2026-06-15", ["shampoo", "conditioner"]),
    noneDay("2026-06-16"),
    washDay("2026-06-18", ["shampoo"]),
    noneDay("2026-06-20"),
    washDay("2026-06-22", ["shampoo", "conditioner"]),
  ]
  const conditioner = computeObservedCadences(days, null, CADENCE_POLICIES).find(
    (cadence) => cadence.category === "conditioner",
  )
  assert.ok(conditioner)
  assert.equal(conditioner.weeklyCadence, 1)
  assert.equal(conditioner.usageDays, 2)
  assert.equal(conditioner.washEventsObserved, 4)
})

test("duplicate category rows on one day count once", () => {
  const days = [
    washDay("2026-06-10", ["conditioner", "conditioner"]),
    washDay("2026-06-14", ["conditioner"]),
  ]
  const cadences = computeObservedCadences(days, 2, CADENCE_POLICIES)
  const conditioner = cadences.find((c) => c.category === "conditioner")
  assert.ok(conditioner)
  assert.equal(conditioner.usageDays, 2)
})

test("day-level: dry shampoo 4 days across 2 observed weeks -> 2/week", () => {
  const days: TrackerLogDay[] = [
    {
      loggedOn: "2026-06-08",
      dayType: "styling_only",
      products: [{ category: "dry_shampoo", productName: null, userProductUsageId: null }],
    },
    { loggedOn: "2026-06-09", dayType: "none", products: [] },
    {
      loggedOn: "2026-06-10",
      dayType: "styling_only",
      products: [{ category: "dry_shampoo", productName: null, userProductUsageId: null }],
    },
    { loggedOn: "2026-06-11", dayType: "none", products: [] },
    {
      loggedOn: "2026-06-15",
      dayType: "styling_only",
      products: [{ category: "dry_shampoo", productName: null, userProductUsageId: null }],
    },
    { loggedOn: "2026-06-16", dayType: "none", products: [] },
    {
      loggedOn: "2026-06-17",
      dayType: "styling_only",
      products: [{ category: "dry_shampoo", productName: null, userProductUsageId: null }],
    },
    { loggedOn: "2026-06-18", dayType: "none", products: [] },
  ]
  const cadences = computeObservedCadences(days, null, CADENCE_POLICIES)
  const dry = cadences.find((c) => c.category === "dry_shampoo")
  assert.ok(dry)
  assert.equal(dry.basis, "day_level")
  assert.equal(dry.weeklyCadence, 2)
})

test("heat-exposure policy uses observed-day cadence instead of wash share", () => {
  const days = DENSE_WEEKS.map((day) =>
    day.loggedOn === "2026-06-08" || day.loggedOn === "2026-06-15"
      ? {
          ...day,
          products: [
            ...day.products,
            { category: "heat_protectant", productName: null, userProductUsageId: null },
          ],
        }
      : day,
  )
  const cadences = computeObservedCadences(days, null, [
    ...CADENCE_POLICIES,
    {
      category: "heat_protectant",
      cadencePolicy: {
        kind: "match_heat_exposure",
        heatExposureTier: "moderate",
        relevantTools: ["blow_dryer"],
        expected: "with_meaningful_heat",
        targetBand: TARGET_BAND,
      },
    },
  ])
  const heatProtectant = cadences.find((cadence) => cadence.category === "heat_protectant")
  assert.ok(heatProtectant)
  assert.equal(heatProtectant.basis, "day_level")
  assert.equal(heatProtectant.anchorSource, null)
  assert.equal(heatProtectant.weeklyCadence, 1)
})

test("not-applicable policy suppresses cadence output", () => {
  const days = DENSE_WEEKS.map((day, index) =>
    index === 0
      ? {
          ...day,
          products: [
            ...day.products,
            { category: "serum", productName: null, userProductUsageId: null },
          ],
        }
      : day,
  )
  const cadences = computeObservedCadences(days, null, [
    ...CADENCE_POLICIES,
    { category: "serum", cadencePolicy: { kind: "not_applicable" } },
  ])
  assert.equal(
    cadences.find((cadence) => cadence.category === "serum"),
    undefined,
  )
})

test("day-level: weeks with fewer than 4 logged days are not observed", () => {
  const days: TrackerLogDay[] = [
    {
      loggedOn: "2026-06-08",
      dayType: "styling_only",
      products: [{ category: "hairspray", productName: null, userProductUsageId: null }],
    },
    { loggedOn: "2026-06-09", dayType: "none", products: [] },
  ]
  const cadences = computeObservedCadences(days, null, CADENCE_POLICIES)
  assert.equal(
    cadences.find((c) => c.category === "hairspray"),
    undefined,
  )
})

test("daysSinceLastWash: counts from most recent wash-like day", () => {
  const days = [
    washDay("2026-07-03", ["shampoo"]),
    { loggedOn: "2026-07-05", dayType: "none" as const, products: [] },
  ]
  assert.equal(daysSinceLastWash(days, "2026-07-07"), 4)
  assert.equal(daysSinceLastWash([], "2026-07-07"), null)
})

test("custom and unconfirmed days do not affect cadence denominators or category usage", () => {
  const withCustom = [
    ...DENSE_WEEKS,
    customDay("2026-06-12", ["mask"]),
    customDay("2026-06-19", ["mask"]),
    { ...washDay("2026-06-22", ["shampoo", "mask"]), confirmed: false },
  ]
  const cadences = computeObservedCadences(withCustom, null, CADENCE_POLICIES)
  const mask = cadences.find((cadence) => cadence.category === "mask")
  assert.ok(mask)
  assert.equal(mask.usageDays, 2)
  assert.equal(mask.weeklyCadence, 1)
  assert.equal(estimateObservedWashCadencePerWeek(withCustom), 2)
})
