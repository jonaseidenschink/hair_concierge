import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { formatBillingMembershipStatus } from "../src/lib/billing/display"

test("billing status labels canceled subscriptions with paid-through access", () => {
  const label = formatBillingMembershipStatus(
    {
      entitlement_status: "canceled",
      cancel_at_period_end: true,
      current_period_end: "2026-07-03T12:00:00.000Z",
    },
    null,
    new Date("2026-06-03T12:00:00.000Z"),
  )

  assert.equal(label, "Verlängerung gekündigt, Zugang bis 3.7.2026")
})

test("billing status translates an expired cancellation", () => {
  const label = formatBillingMembershipStatus(
    {
      entitlement_status: "canceled",
      cancel_at_period_end: true,
      current_period_end: "2026-05-03T12:00:00.000Z",
    },
    "active",
    new Date("2026-06-03T12:00:00.000Z"),
  )

  assert.equal(label, "Gekündigt")
})

test("billing status translates provider entitlement states", () => {
  assert.equal(formatBillingMembershipStatus(null, "active"), "Aktiv")
  assert.equal(formatBillingMembershipStatus(null, "past_due"), "Zahlung ausstehend")
  assert.equal(formatBillingMembershipStatus(null, "incomplete"), "Unvollständig")
})

test("manage subscription button resets loading after request failures", () => {
  const source = readFileSync("src/components/profile/manage-subscription-button.tsx", "utf8")

  assert.match(source, /try \{/)
  assert.match(source, /catch \{/)
  assert.match(source, /setLoading\(false\)/)
  assert.match(source, /Konnte Portal nicht öffnen\./)
})
