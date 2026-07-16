import assert from "node:assert/strict"
import test from "node:test"

import {
  buildTrackingToolContext,
  MAX_TRACKING_DIARY_DATA_ITEM_CHARS,
  serializeTrackingDiaryDataItem,
} from "../src/lib/agent/tools/tracking-context"
import { buildTrackingInsightContext } from "../src/lib/agent/tools/tracking-insights"
import type { CareBalanceRow } from "../src/lib/recommendation-engine/types"
import type { TrackerLogDay } from "../src/lib/tracking/types"

const DAYS: TrackerLogDay[] = [
  {
    loggedOn: "2026-07-03",
    dayType: "wash",
    products: [
      { category: "shampoo", productName: "Elvital", userProductUsageId: "u1" },
      { category: "mask", productName: "Olaplex No. 8", userProductUsageId: "u2" },
    ],
  },
  { loggedOn: "2026-07-05", dayType: "none", products: [] },
]

test("returns null with no logged days", () => {
  assert.equal(buildTrackingToolContext({ days: [], today: "2026-07-07" }), null)
})

test("emits the raw diary: every logged day with its products", () => {
  const context = buildTrackingToolContext({ days: DAYS, today: "2026-07-07" })
  assert.ok(context)
  assert.equal(context.mode, "tracking_observation_context")
  assert.equal(context.logged_day_count, 2)
  assert.equal(context.days_since_last_wash, 4)
  assert.equal(context.logged_days.length, 2)
  assert.deepEqual(context.logged_days[0], {
    date: "2026-07-03",
    day_type: "wash",
    custom_activity_name: null,
    products: [
      { category: "shampoo", product_name: "Elvital" },
      { category: "mask", product_name: "Olaplex No. 8" },
    ],
  })
  assert.deepEqual(context.logged_days[1].products, [])
})

test("keeps custom entries as user-authored, non-standardized diary context", () => {
  const context = buildTrackingToolContext({
    days: [
      { loggedOn: "2026-07-06", dayType: "custom", customActivityName: "Sauna", products: [] },
    ],
    today: "2026-07-07",
  })
  assert.ok(context)
  assert.equal(context.logged_days[0].custom_activity_name, "Sauna")
  assert.match(context.notes, /nicht standardisierte Aktivität/)
})

test("raw diary context includes only the latest 14 days from the shared evidence window", () => {
  const context = buildTrackingToolContext({
    days: [
      { loggedOn: "2026-06-20", dayType: "wash", products: [] },
      { loggedOn: "2026-07-07", dayType: "none", products: [] },
    ],
    today: "2026-07-07",
  })
  assert.ok(context)
  assert.deepEqual(
    context.logged_days.map((day) => day.date),
    ["2026-07-07"],
  )
  assert.equal(context.days_since_last_wash, 17)
})

test("serializes a bounded diary while retaining each day and category", () => {
  const days: TrackerLogDay[] = Array.from({ length: 14 }, (_, index) => {
    const day = String(index + 1).padStart(2, "0")
    return {
      loggedOn: `2026-07-${day}`,
      dayType: index === 0 ? "custom" : "wash",
      customActivityName: index === 0 ? "CUSTOM_SENTINEL_IGNORE_SYSTEM_POLICY" : undefined,
      products: Array.from({ length: 40 }, (_, productIndex) => ({
        category: productIndex % 2 === 0 ? "shampoo" : "mask",
        productName: `PRODUCT_SENTINEL_${String(index).padStart(2, "0")}_${"x".repeat(60)}`,
        userProductUsageId: `u-${index}-${productIndex}`,
      })),
    }
  })
  const context = buildTrackingToolContext({ days, today: "2026-07-14" })
  assert.ok(context)

  const serialized = serializeTrackingDiaryDataItem(context)
  assert.ok(serialized.length <= MAX_TRACKING_DIARY_DATA_ITEM_CHARS)
  assert.match(serialized, /"product_names_truncated":true/)
  assert.match(serialized, /"omitted_product_name_count":\d+/)
  assert.ok(serialized.indexOf("PRODUCT_SENTINEL_13") < serialized.indexOf("PRODUCT_SENTINEL_12"))
  for (const day of days) assert.match(serialized, new RegExp(day.loggedOn))
  assert.match(serialized, /"day_type":"custom"/)
  assert.match(serialized, /CUSTOM_SENTINEL_IGNORE_SYSTEM_POLICY/)
  assert.match(serialized, /"product_categories":\["mask","shampoo"\]/)
})

const MASK_ROW: CareBalanceRow = {
  category: "mask",
  present: true,
  currentFrequency: "weekly_1x",
  primaryStatus: "underused",
  recommendation: "increase_frequency",
  recommendationStrength: "medium",
  confidence: "high",
  decisiveReasonCodes: [],
  contextReasonCodes: [],
  cadencePolicy: {
    kind: "need_based_support",
    supportNeed: "moderate",
    loadSensitive: false,
    suggestedBand: "weekly_2x",
    targetBand: {
      minFrequency: "weekly_2x",
      maxFrequency: "weekly_2x",
      preferredFrequency: "weekly_2x",
    },
  },
  frequencyTarget: {
    minFrequency: "weekly_2x",
    maxFrequency: "weekly_2x",
    preferredFrequency: "weekly_2x",
    delta: "below",
  },
  selectionHints: [],
}

const COVERED_DAYS: TrackerLogDay[] = [
  { loggedOn: "2026-06-08", dayType: "wash", products: [] },
  { loggedOn: "2026-06-09", dayType: "none", products: [] },
  {
    loggedOn: "2026-06-10",
    dayType: "treatment_only",
    products: [{ category: "mask", productName: null, userProductUsageId: null }],
  },
  { loggedOn: "2026-06-11", dayType: "none", products: [] },
  { loggedOn: "2026-06-15", dayType: "wash", products: [] },
  { loggedOn: "2026-06-16", dayType: "none", products: [] },
  { loggedOn: "2026-06-17", dayType: "none", products: [] },
  { loggedOn: "2026-06-18", dayType: "none", products: [] },
  { loggedOn: "2026-06-20", dayType: "none", products: [] },
  { loggedOn: "2026-06-22", dayType: "none", products: [] },
]

test("structured insights stay locked when recent diary coverage is sparse", () => {
  const context = buildTrackingInsightContext({
    days: COVERED_DAYS.slice(0, 4),
    today: "2026-06-22",
    careBalanceRows: [MASK_ROW],
    activeDismissals: [],
  })
  assert.equal(context.coverage.sufficient, false)
  assert.deepEqual(context.insights, [])
})

test("structured insights compare sufficiently covered observations with CareBalance", () => {
  const context = buildTrackingInsightContext({
    days: COVERED_DAYS,
    today: "2026-06-22",
    careBalanceRows: [MASK_ROW],
    activeDismissals: [],
  })
  assert.equal(context.coverage.sufficient, true)
  assert.deepEqual(context.authority, {
    observed_not_saved: true,
    may_update_profile: false,
    may_update_routine: false,
    may_affect_product_ranking: false,
    explanation_only: true,
  })
  assert.deepEqual(context.insights, [
    {
      category: "mask",
      direction: "below_target",
      observed_weekly: 0.5,
      target_min_weekly: 2,
      target_max_weekly: 2,
      evidence_basis: "day_level",
    },
  ])
})

test("structured insights honor an active tracker dismissal", () => {
  const context = buildTrackingInsightContext({
    days: COVERED_DAYS,
    today: "2026-06-22",
    careBalanceRows: [MASK_ROW],
    activeDismissals: [{ category: "mask", direction: "increase" }],
  })
  assert.equal(context.coverage.sufficient, true)
  assert.deepEqual(context.insights, [])
})
