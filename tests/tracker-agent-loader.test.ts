import assert from "node:assert/strict"
import test from "node:test"

import { loadTrackerDaysForAgent } from "../src/lib/tracking/load-tracker-days"

function query(result: { data: unknown; error: unknown }) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    gte: () => builder,
    lte: () => builder,
    order: () => builder,
    then: <TResult1 = typeof result, TResult2 = never>(
      onfulfilled?: ((value: typeof result) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(result).then(onfulfilled, onrejected),
  }
  return builder
}

function createClient(results: Record<string, { data: unknown; error: unknown }>) {
  return {
    from(table: string) {
      return query(results[table])
    },
  }
}

test("loader distinguishes an empty diary from a failed load", async () => {
  const empty = await loadTrackerDaysForAgent("user-1", 28, {
    createClient: () =>
      createClient({
        routine_logs: { data: [], error: null },
        tracker_nudge_dismissals: { data: [], error: null },
      }),
    now: () => new Date("2026-07-07T12:00:00Z"),
  })
  assert.equal(empty.status, "empty")
  assert.equal(empty.reason, "no_entries")

  const failed = await loadTrackerDaysForAgent("user-1", 28, {
    createClient: () =>
      createClient({
        routine_logs: { data: null, error: { message: "offline" } },
        tracker_nudge_dismissals: { data: [], error: null },
      }),
    now: () => new Date("2026-07-07T12:00:00Z"),
  })
  assert.equal(failed.status, "unavailable")
  assert.equal(failed.reason, "query_failed")
})

test("loader returns recent diary facts and only active dismissals", async () => {
  const result = await loadTrackerDaysForAgent("user-1", 28, {
    createClient: () =>
      createClient({
        routine_logs: {
          data: [
            {
              id: "log-1",
              logged_on: "2026-07-06",
              timezone: "Europe/Berlin",
              day_type: "wash",
              custom_activity_name: null,
              routine_log_products: [
                {
                  category: "shampoo",
                  product_name: "Shampoo A",
                  user_product_usage_id: "usage-1",
                },
              ],
            },
          ],
          error: null,
        },
        tracker_nudge_dismissals: {
          data: [
            { category: "mask", direction: "increase", reappear_at: "2026-07-20T00:00:00Z" },
            { category: "oil", direction: "decrease", reappear_at: "2026-07-01T00:00:00Z" },
          ],
          error: null,
        },
      }),
    now: () => new Date("2026-07-07T12:00:00Z"),
  })

  assert.equal(result.status, "available")
  assert.equal(result.days[0].products[0].productName, "Shampoo A")
  assert.deepEqual(result.activeDismissals, [{ category: "mask", direction: "increase" }])
})

test("loader includes a local-next-day entry while UTC is still on the prior day", async () => {
  const result = await loadTrackerDaysForAgent("user-1", 28, {
    createClient: () =>
      createClient({
        routine_logs: {
          data: [
            {
              id: "log-berlin-next-day",
              logged_on: "2026-07-07",
              timezone: "Europe/Berlin",
              day_type: "wash",
              custom_activity_name: null,
              routine_log_products: [],
            },
          ],
          error: null,
        },
        tracker_nudge_dismissals: { data: [], error: null },
      }),
    now: () => new Date("2026-07-06T22:30:00Z"),
  })

  assert.equal(result.status, "available")
  assert.equal(result.referenceDate, "2026-07-07")
  assert.deepEqual(
    result.days.map((day) => day.loggedOn),
    ["2026-07-07"],
  )
})
