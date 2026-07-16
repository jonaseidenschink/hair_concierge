import assert from "node:assert/strict"
import test from "node:test"

import type { ObservedCadence } from "../src/lib/tracking/aggregation"
import { computeNudges } from "../src/lib/tracking/nudges"

function cadence(category: string, weeklyCadence: number): ObservedCadence {
  return {
    category,
    weeklyCadence,
    basis: "wash_share",
    anchorSource: "observed",
    usageDays: 4,
    washEventsObserved: 8,
  }
}

const MASK_TARGET = {
  category: "mask",
  frequencyTarget: {
    minFrequency: "weekly_2x" as const,
    maxFrequency: "weekly_3_4x" as const,
    preferredFrequency: "weekly_2x" as const,
    delta: "unknown" as const,
  },
}

test("observed clearly below band -> increase nudge with German copy", () => {
  const nudges = computeNudges({
    cadences: [cadence("mask", 1)],
    targets: [MASK_TARGET],
    dismissed: [],
  })
  assert.equal(nudges.length, 1)
  assert.equal(nudges[0].direction, "increase")
  assert.equal(nudges[0].category, "mask")
  assert.ok(nudges[0].message.includes("Maske"))
  assert.ok(nudges[0].message.includes("empfohlen"))
})

test("observed inside band -> no nudge", () => {
  const nudges = computeNudges({
    cadences: [cadence("mask", 2.5)],
    targets: [MASK_TARGET],
    dismissed: [],
  })
  assert.equal(nudges.length, 0)
})

test("boundary wobble guard: less than 0.5/week outside band -> no nudge", () => {
  const nudges = computeNudges({
    cadences: [cadence("mask", 1.6)],
    targets: [MASK_TARGET],
    dismissed: [],
  })
  assert.equal(nudges.length, 0)
})

test("exactly 0.5/week outside the band fires (spec: >= margin)", () => {
  assert.equal(
    computeNudges({
      cadences: [cadence("mask", 1.5)],
      targets: [MASK_TARGET],
      dismissed: [],
    })[0]?.direction,
    "increase",
  )
  assert.equal(
    computeNudges({
      cadences: [cadence("mask", 4.5)],
      targets: [MASK_TARGET],
      dismissed: [],
    })[0]?.direction,
    "decrease",
  )
})

test("wash_rhythm nudge speaks about washing, not the shampoo product", () => {
  const nudges = computeNudges({
    cadences: [
      {
        category: "shampoo",
        weeklyCadence: 1,
        basis: "wash_rhythm",
        anchorSource: "observed",
        usageDays: 4,
        washEventsObserved: 4,
      },
    ],
    targets: [
      {
        category: "shampoo",
        frequencyTarget: {
          minFrequency: "weekly_2x",
          maxFrequency: "weekly_3_4x",
          preferredFrequency: "weekly_2x",
          delta: "unknown",
        },
      },
    ],
    dismissed: [],
  })
  assert.equal(nudges.length, 1)
  assert.ok(nudges[0].message.includes("wäschst"))
  assert.ok(!nudges[0].message.includes("Shampoo"))
})

test("observed clearly above band -> decrease nudge", () => {
  const nudges = computeNudges({
    cadences: [cadence("mask", 5)],
    targets: [MASK_TARGET],
    dismissed: [],
  })
  assert.equal(nudges.length, 1)
  assert.equal(nudges[0].direction, "decrease")
})

test("dismissed direction stays hidden; other direction still fires", () => {
  const dismissed = [{ category: "mask", direction: "increase" }]
  assert.equal(
    computeNudges({
      cadences: [cadence("mask", 1)],
      targets: [MASK_TARGET],
      dismissed,
    }).length,
    0,
  )
  assert.equal(
    computeNudges({
      cadences: [cadence("mask", 5)],
      targets: [MASK_TARGET],
      dismissed,
    }).length,
    1,
  )
})

test("no target for category -> no nudge", () => {
  const nudges = computeNudges({
    cadences: [cadence("hairspray", 5)],
    targets: [],
    dismissed: [],
  })
  assert.equal(nudges.length, 0)
})
