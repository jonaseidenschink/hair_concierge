import assert from "node:assert/strict"
import test from "node:test"

import {
  orderTrackerShelfForActivity,
  sortTrackerShelf,
  TRACKER_ACTIVITY_PRESENTATION_DE,
  TRACKER_PREFILL_SOURCE_COPY_DE,
  TRACKER_PROFILE_DISCLAIMER_DE,
} from "../src/lib/tracking/presentation"

test("activity presentation defines all six German labels and descriptions", () => {
  assert.deepEqual(TRACKER_ACTIVITY_PRESENTATION_DE, {
    wash: { label: "Haare gewaschen", description: "Mit Shampoo oder Co-Wash" },
    clarifying: { label: "Klärwäsche", description: "Mit klärendem Shampoo" },
    treatment_only: { label: "Pflege ohne Wäsche", description: "Maske, Kur oder Öl" },
    styling_only: { label: "Styling aufgefrischt", description: "Mit Wasser oder Stylingprodukt" },
    none: { label: "Keine Haarpflege", description: "Keine Produkte verwendet" },
    custom: { label: "Eigene Aktivität", description: "Für alles, was sonst nicht passt" },
  })
})

test("shelf order is category, normalized product name, then stable usage id", () => {
  const shelf = [
    { usageId: "2", category: "mask", productName: "Öl-Kur" },
    { usageId: "b", category: "shampoo", productName: "B Shampoo" },
    { usageId: "a", category: "shampoo", productName: "Ä Shampoo" },
    { usageId: "c", category: "shampoo", productName: "Ä Shampoo" },
  ]
  assert.deepEqual(
    sortTrackerShelf(shelf).map((item) => item.usageId),
    ["a", "c", "b", "2"],
  )
})

test("activity ordering surfaces likely categories without hiding the stable remaining shelf", () => {
  const shelf = [
    { usageId: "1", category: "mask", productName: "Maske" },
    { usageId: "2", category: "shampoo", productName: "Shampoo" },
    { usageId: "3", category: "conditioner", productName: "Conditioner" },
  ]
  const ordered = orderTrackerShelfForActivity("wash", shelf)
  assert.deepEqual(
    ordered.likely.map((item) => item.category),
    ["shampoo", "conditioner"],
  )
  assert.deepEqual(
    ordered.remaining.map((item) => item.category),
    ["mask"],
  )
  assert.deepEqual(orderTrackerShelfForActivity("custom", shelf).likely, [])
})

test("presentation copy names prefill source and profile ownership without retired progress language", () => {
  assert.equal(TRACKER_PREFILL_SOURCE_COPY_DE, "Wie bei deinem letzten ähnlichen Eintrag.")
  assert.equal(TRACKER_PROFILE_DISCLAIMER_DE, "Produkte kannst du in deinem Profil verwalten.")
  assert.doesNotMatch(TRACKER_PREFILL_SOURCE_COPY_DE, /Wochen aktiv|Log-Tage|Muster & Hinweise/i)
})
