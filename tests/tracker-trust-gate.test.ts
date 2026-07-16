import assert from "node:assert/strict"
import test from "node:test"

import { evaluateTrustGate } from "../src/lib/tracking/trust-gate"
import {
  getTrustGateQualifyingLogDates,
  hasValidTrackerDayTypeDetails,
  normalizeCustomActivityName,
  type TrackerLogDay,
} from "../src/lib/tracking/types"

test("no logs: locked, no first-log date", () => {
  const gate = evaluateTrustGate([], "2026-07-07")
  assert.equal(gate.unlocked, false)
  assert.equal(gate.firstLogDate, null)
  assert.equal(gate.daysRemaining, 14)
})

test("first log today: locked with 14 days remaining (unlock lands on day 14)", () => {
  const gate = evaluateTrustGate(["2026-07-07"], "2026-07-07")
  assert.equal(gate.unlocked, false)
  assert.equal(gate.firstLogDate, "2026-07-07")
  assert.equal(gate.daysSinceFirstLog, 0)
  assert.equal(gate.daysRemaining, 14)
})

test("14 days elapsed but only 9 logged days: still locked", () => {
  const dates = [
    "2026-06-23",
    "2026-06-24",
    "2026-06-25",
    "2026-06-26",
    "2026-06-27",
    "2026-06-28",
    "2026-06-29",
    "2026-06-30",
    "2026-07-01",
  ]
  const gate = evaluateTrustGate(dates, "2026-07-07")
  assert.equal(gate.daysSinceFirstLog, 14)
  assert.equal(gate.loggedDayCount, 9)
  assert.equal(gate.unlocked, false)
})

test("14 days elapsed and 10 logged days: unlocked", () => {
  const dates = [
    "2026-06-23",
    "2026-06-24",
    "2026-06-25",
    "2026-06-26",
    "2026-06-27",
    "2026-06-28",
    "2026-06-29",
    "2026-06-30",
    "2026-07-01",
    "2026-07-05",
  ]
  const gate = evaluateTrustGate(dates, "2026-07-07")
  assert.equal(gate.unlocked, true)
  assert.equal(gate.daysRemaining, 0)
})

test("duplicate dates count once", () => {
  const gate = evaluateTrustGate(["2026-07-01", "2026-07-01", "2026-07-02"], "2026-07-07")
  assert.equal(gate.loggedDayCount, 2)
})

test("custom activity validation trims names and requires them only for custom days", () => {
  assert.equal(normalizeCustomActivityName("  Sauna  "), "Sauna")
  assert.equal(normalizeCustomActivityName("  "), null)
  assert.equal(
    hasValidTrackerDayTypeDetails({ dayType: "custom", customActivityName: " Sauna " }),
    true,
  )
  assert.equal(hasValidTrackerDayTypeDetails({ dayType: "custom", customActivityName: " " }), false)
  assert.equal(hasValidTrackerDayTypeDetails({ dayType: "wash", customActivityName: null }), true)
  assert.equal(hasValidTrackerDayTypeDetails({ dayType: "wash", customActivityName: " " }), false)
  assert.equal(
    hasValidTrackerDayTypeDetails({ dayType: "wash", customActivityName: "Sauna" }),
    false,
  )
})

test("custom and unconfirmed days do not count toward the ten qualifying trust-gate days", () => {
  const canonicalDays: TrackerLogDay[] = Array.from({ length: 9 }, (_, index) => ({
    loggedOn: `2026-06-${String(index + 23).padStart(2, "0")}`,
    dayType: "none",
    products: [],
  }))
  const days: TrackerLogDay[] = [
    ...canonicalDays,
    { loggedOn: "2026-07-02", dayType: "custom", customActivityName: "Sauna", products: [] },
    { loggedOn: "2026-07-03", dayType: "wash", confirmed: false, products: [] },
  ]
  const gate = evaluateTrustGate(getTrustGateQualifyingLogDates(days), "2026-07-07")
  assert.equal(gate.loggedDayCount, 9)
  assert.equal(gate.unlocked, false)
})
