import assert from "node:assert/strict"
import test from "node:test"

import { createTrackerApiHandlers } from "../src/lib/tracking/api-handlers"

type Row = Record<string, unknown>

interface FakeState {
  user: { id: string; email?: string } | null
  tables: Record<string, Row[]>
  writes: Array<{ table: string; op: string; payload: unknown }>
  errors?: Record<string, string>
  rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }>
  access?: "paid" | "manual" | "legacy" | "expired" | "error"
  authCalls?: number
  adminCalls?: number
}

function createFakeClient(state: FakeState) {
  function builder(table: string) {
    const filters: Array<(row: Row) => boolean> = []
    const self: Record<string, unknown> = {
      select: () => self,
      eq: (col: string, val: unknown) => {
        filters.push((row) => row[col] === val)
        return self
      },
      gte: (col: string, val: string) => {
        filters.push((row) => String(row[col]) >= val)
        return self
      },
      lte: (col: string, val: string) => {
        filters.push((row) => String(row[col]) <= val)
        return self
      },
      is: (col: string, val: unknown) => {
        filters.push((row) => (val === null ? row[col] == null : row[col] === val))
        return self
      },
      order: () => self,
      in: (col: string, vals: unknown[]) => {
        filters.push((row) => vals.includes(row[col]))
        return self
      },
      upsert: (payload: Row) => {
        state.writes.push({ table, op: "upsert", payload })
        const withId = { id: `${table}-new`, ...payload }
        state.tables[table] = [
          ...(state.tables[table] ?? []).filter(
            (row) => !(row.user_id === payload.user_id && row.logged_on === payload.logged_on),
          ),
          withId,
        ]
        return {
          select: () => ({
            single: async () => ({ data: withId, error: null }),
          }),
          then: (resolve: (value: { error: null }) => void) => resolve({ error: null }),
        }
      },
      insert: async (payload: unknown) => {
        state.writes.push({ table, op: "insert", payload })
        return { error: null }
      },
      delete: () => ({
        eq: async (col: string, val: unknown) => {
          state.writes.push({ table, op: "delete", payload: { [col]: val } })
          return { error: null }
        },
      }),
      then: (resolve: (value: { data: Row[]; error: null }) => void) => {
        if (state.errors?.[table]) {
          resolve({
            data: [],
            error: { message: state.errors[table] } as never,
          })
          return
        }
        const rows = (state.tables[table] ?? []).filter((row) =>
          filters.every((filter) => filter(row)),
        )
        resolve({ data: rows, error: null })
      },
    }
    return self
  }
  return {
    auth: {
      getUser: async () => {
        state.authCalls = (state.authCalls ?? 0) + 1
        return { data: { user: state.user }, error: null }
      },
    },
    from: (table: string) => builder(table),
    rpc: async (functionName: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ functionName, args })
      if (state.errors?.[functionName])
        return { data: null, error: { message: state.errors[functionName] } }
      const foreignProduct = (
        args.p_products as
          | Array<{ category: string; user_product_usage_id: string | null }>
          | undefined
      )?.find(
        (product) =>
          product.user_product_usage_id &&
          !(state.tables.user_product_usage ?? []).some(
            (row) =>
              row.id === product.user_product_usage_id &&
              row.user_id === state.user?.id &&
              row.category === product.category,
          ),
      )
      if (foreignProduct)
        return {
          data: { ok: false, code: "foreign_product", error: "Ungültige Produktreferenz." },
          error: null,
        }
      const logs = state.tables.routine_logs ?? []
      const existing = logs.find(
        (row) => row.logged_on === args.p_logged_on && row.user_id === state.user?.id,
      )
      const stale =
        existing &&
        existing.client_session_id === args.p_client_session_id &&
        Number(existing.client_revision) >= Number(args.p_client_revision)
      if (!stale) {
        const row = existing ?? {
          id: `log-${logs.length}`,
          user_id: state.user?.id,
          logged_on: args.p_logged_on,
        }
        Object.assign(row, {
          client_session_id: args.p_client_session_id,
          client_revision: args.p_client_revision,
          deleted_at: functionName === "delete_routine_log" ? "2026-07-07T12:00:00.000Z" : null,
          day_type: args.p_day_type ?? row.day_type ?? "wash",
          custom_activity_name: args.p_custom_activity_name ?? null,
        })
        if (!existing) logs.push(row)
        state.tables.routine_logs = logs
      }
      const persisted =
        existing ?? state.tables.routine_logs.find((row) => row.logged_on === args.p_logged_on)!
      return {
        data: {
          ok: true,
          code: stale
            ? "stale_revision"
            : functionName === "delete_routine_log"
              ? "deleted"
              : "saved",
          day: {
            loggedOn: args.p_logged_on,
            dayType: persisted.day_type,
            customActivityName: persisted.custom_activity_name,
            deletedAt: persisted.deleted_at,
            products: args.p_products ?? [],
          },
        },
        error: null,
      }
    },
  }
}

function makeDeps(state: FakeState) {
  return {
    createAuthClient: async () => createFakeClient(state) as never,
    createAdminClient: () => {
      state.adminCalls = (state.adminCalls ?? 0) + 1
      return createFakeClient(state) as never
    },
    hasCurrentAppAccess: async (
      _client: unknown,
      lookup: { userId: string; email?: string | null },
    ) => {
      assert.equal(lookup.userId, state.user?.id)
      if (state.access === "error") throw new Error("access unavailable")
      if (state.access === "manual") assert.equal(lookup.email, state.user?.email)
      return state.access !== "expired"
    },
    loadRoutineArtifactData: async () =>
      ({
        runtime: {
          careBalance: {
            rows: [
              {
                category: "mask",
                cadencePolicy: {
                  kind: "need_based_support",
                  supportNeed: "moderate",
                  loadSensitive: false,
                  suggestedBand: "weekly_2x",
                  targetBand: {
                    minFrequency: "weekly_2x",
                    maxFrequency: "weekly_3_4x",
                    preferredFrequency: "weekly_2x",
                  },
                },
                frequencyTarget: {
                  minFrequency: "weekly_2x",
                  maxFrequency: "weekly_3_4x",
                  preferredFrequency: "weekly_2x",
                  delta: "unknown",
                },
              },
              {
                category: "shampoo",
                cadencePolicy: {
                  kind: "baseline_cleansing",
                  shampooFrequency: "weekly_2x",
                },
                frequencyTarget: {
                  minFrequency: "weekly_2x",
                  maxFrequency: "weekly_3_4x",
                  preferredFrequency: "weekly_2x",
                  delta: "unknown",
                },
              },
            ],
          },
        },
        usageRows: [
          {
            id: UPU_SHAMPOO_ID,
            product: { image_url: "https://cdn.example.test/elvital.jpg" },
          },
          {
            id: UPU_MASK_ID,
            product: { image_url: null },
          },
        ],
      }) as never,
    now: () => new Date("2026-07-07T12:00:00Z"),
  }
}

const UPU_SHAMPOO_ID = "11111111-1111-4111-8111-111111111111"
const UPU_MASK_ID = "22222222-2222-4222-8222-222222222222"
const CLIENT_SESSION_ID = "44444444-4444-4444-8444-444444444444"

function baseState(): FakeState {
  return {
    user: { id: "user-1", email: "user@example.test" },
    tables: {
      routine_logs: [],
      routine_log_products: [],
      tracker_nudge_dismissals: [],
      user_product_usage: [
        {
          id: UPU_SHAMPOO_ID,
          user_id: "user-1",
          category: "shampoo",
          product_name: "Elvital",
          frequency_range: "weekly_2x",
        },
        {
          id: UPU_MASK_ID,
          user_id: "user-1",
          category: "mask",
          product_name: "Olaplex No. 8",
          frequency_range: "weekly_2x",
        },
      ],
    },
    writes: [],
    rpcCalls: [],
  }
}

test("getTracker: 401 without user", async () => {
  const state = baseState()
  state.user = null
  const handlers = createTrackerApiHandlers(makeDeps(state))
  const result = await handlers.getTracker({ tz: "Europe/Berlin" })
  assert.equal(result.status, 401)
})

for (const access of ["paid", "manual", "legacy"] as const) {
  test(`getTracker: permits current ${access} access`, async () => {
    const state = baseState()
    state.access = access
    const result = await createTrackerApiHandlers(makeDeps(state)).getTracker({
      tz: "Europe/Berlin",
    })
    assert.equal(result.status, 200)
    assert.equal(state.authCalls, 1)
    assert.equal(state.adminCalls, 1)
  })
}

test("tracker handlers fail closed for expired or unavailable access", async () => {
  const expired = baseState()
  expired.access = "expired"
  assert.equal(
    (await createTrackerApiHandlers(makeDeps(expired)).getTracker({ tz: "Europe/Berlin" })).status,
    403,
  )

  const unavailable = baseState()
  unavailable.access = "error"
  assert.equal(
    (await createTrackerApiHandlers(makeDeps(unavailable)).getTracker({ tz: "Europe/Berlin" }))
      .status,
    503,
  )
})

test("getTracker: rejects an invalid IANA timezone with 400", async () => {
  const state = baseState()
  const handlers = createTrackerApiHandlers(makeDeps(state))

  const result = await handlers.getTracker({ tz: "Not/A_Timezone" })

  assert.equal(result.status, 400)
  assert.deepEqual(result.body, { error: "Ungültige Zeitzone." })
})

test("getTracker: returns shelf image URLs from artifact usage rows with null fallbacks", async () => {
  const state = baseState()
  state.tables.user_product_usage.push({
    id: "33333333-3333-4333-8333-333333333333",
    user_id: "user-1",
    category: "oil",
    product_name: "Unmatched oil",
    frequency_range: null,
  })
  const handlers = createTrackerApiHandlers(makeDeps(state))
  const result = await handlers.getTracker({ tz: "Europe/Berlin" })
  assert.equal(result.status, 200)
  const body = result.body as {
    gate: { unlocked: boolean }
    nudges: unknown[]
    shelf: Array<{ usageId: string; imageUrl: string | null }>
    today: string
  }
  assert.equal(body.gate.unlocked, false)
  assert.equal(body.nudges.length, 0)
  assert.deepEqual(
    body.shelf.map(({ usageId, imageUrl }) => ({ usageId, imageUrl })),
    [
      { usageId: UPU_SHAMPOO_ID, imageUrl: "https://cdn.example.test/elvital.jpg" },
      { usageId: UPU_MASK_ID, imageUrl: null },
      { usageId: "33333333-3333-4333-8333-333333333333", imageUrl: null },
    ],
  )
  assert.equal(body.today, "2026-07-07")
})

test("getTracker: returns 500 instead of empty diary when log read fails", async () => {
  const state = baseState()
  state.errors = { routine_logs: "relation does not exist" }
  const handlers = createTrackerApiHandlers(makeDeps(state))
  const result = await handlers.getTracker({ tz: "Europe/Berlin" })
  assert.equal(result.status, 500)
})

test("getTracker: excludes deleted and custom rows from trust and rhythm history", async () => {
  const state = baseState()
  state.tables.routine_logs = [
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `custom-${index}`,
      user_id: "user-1",
      logged_on: `2026-07-${String(index + 1).padStart(2, "0")}`,
      day_type: "custom",
      deleted_at: null,
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `deleted-${index}`,
      user_id: "user-1",
      logged_on: `2026-06-${String(index + 1).padStart(2, "0")}`,
      day_type: "wash",
      deleted_at: "2026-07-07T00:00:00.000Z",
    })),
  ]
  const result = await createTrackerApiHandlers(makeDeps(state)).getTracker({ tz: "Europe/Berlin" })
  assert.equal(result.status, 200)
  const body = result.body as { gate: { unlocked: boolean }; rhythmHistory: unknown[] }
  assert.equal(body.gate.unlocked, false)
  assert.deepEqual(body.rhythmHistory, [])
})

test("getTracker: returns the full shampoo target and only 63 calendar days of rhythm history", async () => {
  const state = baseState()
  state.tables.routine_logs = [
    { id: "old", user_id: "user-1", logged_on: "2026-05-05", day_type: "wash", deleted_at: null },
    { id: "edge", user_id: "user-1", logged_on: "2026-05-06", day_type: "wash", deleted_at: null },
    {
      id: "recent",
      user_id: "user-1",
      logged_on: "2026-07-07",
      day_type: "clarifying",
      deleted_at: null,
    },
  ]
  const result = await createTrackerApiHandlers(makeDeps(state)).getTracker({ tz: "Europe/Berlin" })
  assert.equal(result.status, 200)
  const body = result.body as {
    rhythm: {
      frequencyTarget: { minFrequency: string; maxFrequency: string; preferredFrequency: string }
    }
    rhythmHistory: Array<{ loggedOn: string; dayType: string }>
  }
  assert.deepEqual(body.rhythmHistory, [
    { loggedOn: "2026-05-06", dayType: "wash" },
    { loggedOn: "2026-07-07", dayType: "clarifying" },
  ])
  assert.deepEqual(body.rhythm.frequencyTarget, {
    minFrequency: "weekly_2x",
    maxFrequency: "weekly_3_4x",
    preferredFrequency: "weekly_2x",
    delta: "unknown",
  })
})

test("putLog: valid wash day upserts log and replaces products", async () => {
  const state = baseState()
  const handlers = createTrackerApiHandlers(makeDeps(state))
  const result = await handlers.putLog({
    loggedOn: "2026-07-07",
    timezone: "Europe/Berlin",
    clientSessionId: CLIENT_SESSION_ID,
    clientRevision: 1,
    dayType: "wash",
    products: [
      {
        category: "shampoo",
        productName: "Elvital",
        userProductUsageId: UPU_SHAMPOO_ID,
      },
    ],
  })
  assert.equal(result.status, 200)
  assert.equal(state.rpcCalls.length, 1)
  assert.equal(state.rpcCalls[0].functionName, "replace_routine_log")
  assert.equal(state.rpcCalls[0].args.p_user_id, "user-1")
  assert.deepEqual(result.body.day, {
    loggedOn: "2026-07-07",
    dayType: "wash",
    customActivityName: null,
    deletedAt: null,
    products: [
      { category: "shampoo", product_name: "Elvital", user_product_usage_id: UPU_SHAMPOO_ID },
    ],
  })
})

test("putLog: rejects future date and stale backfill", async () => {
  const handlers = createTrackerApiHandlers(makeDeps(baseState()))
  const future = await handlers.putLog({
    loggedOn: "2026-07-08",
    timezone: "Europe/Berlin",
    clientSessionId: CLIENT_SESSION_ID,
    clientRevision: 1,
    dayType: "wash",
    products: [],
  })
  assert.equal(future.status, 400)
  const tooOld = await handlers.putLog({
    loggedOn: "2026-06-29",
    timezone: "Europe/Berlin",
    clientSessionId: CLIENT_SESSION_ID,
    clientRevision: 1,
    dayType: "wash",
    products: [],
  })
  assert.equal(tooOld.status, 400)
})

test("putLog: rejects unknown day type", async () => {
  const handlers = createTrackerApiHandlers(makeDeps(baseState()))
  const result = await handlers.putLog({
    loggedOn: "2026-07-07",
    timezone: "Europe/Berlin",
    clientSessionId: CLIENT_SESSION_ID,
    clientRevision: 1,
    dayType: "party",
    products: [],
  })
  assert.equal(result.status, 400)
})

test("putLog: rejects unknown product category with 400", async () => {
  const handlers = createTrackerApiHandlers(makeDeps(baseState()))
  const result = await handlers.putLog({
    loggedOn: "2026-07-07",
    timezone: "Europe/Berlin",
    clientSessionId: CLIENT_SESSION_ID,
    clientRevision: 1,
    dayType: "wash",
    products: [{ category: "toothpaste", productName: null, userProductUsageId: null }],
  })
  assert.equal(result.status, 400)
})

test("putLog: rejects a userProductUsageId owned by another user", async () => {
  const state = baseState()
  state.tables.user_product_usage.push({
    id: "33333333-3333-4333-8333-333333333333",
    user_id: "user-2",
    category: "oil",
    product_name: "Fremdes Öl",
    frequency_range: null,
  })
  const handlers = createTrackerApiHandlers(makeDeps(state))
  const result = await handlers.putLog({
    loggedOn: "2026-07-07",
    timezone: "Europe/Berlin",
    clientSessionId: CLIENT_SESSION_ID,
    clientRevision: 1,
    dayType: "wash",
    products: [
      {
        category: "oil",
        productName: "Fremdes Öl",
        userProductUsageId: "33333333-3333-4333-8333-333333333333",
      },
    ],
  })
  assert.equal(result.status, 400)
})

test("putLog: rejects a linked product whose category does not match", async () => {
  const handlers = createTrackerApiHandlers(makeDeps(baseState()))
  const result = await handlers.putLog({
    loggedOn: "2026-07-07",
    timezone: "Europe/Berlin",
    clientSessionId: CLIENT_SESSION_ID,
    clientRevision: 1,
    dayType: "treatment_only",
    products: [
      {
        category: "mask",
        productName: "Falsch verknüpft",
        userProductUsageId: UPU_SHAMPOO_ID,
      },
    ],
  })
  assert.equal(result.status, 400)
})

test("putLog: an RPC error is never reported as a successful save", async () => {
  const state = baseState()
  state.errors = { replace_routine_log: "transaction rolled back" }
  const result = await createTrackerApiHandlers(makeDeps(state)).putLog({
    loggedOn: "2026-07-07",
    timezone: "Europe/Berlin",
    clientSessionId: CLIENT_SESSION_ID,
    clientRevision: 1,
    dayType: "wash",
    products: [],
  })
  assert.equal(result.status, 500)
  assert.equal(result.body.ok, undefined)
  assert.equal(state.tables.routine_logs.length, 0)
})

test("putLog: rejects an invalid IANA timezone with 400", async () => {
  const handlers = createTrackerApiHandlers(makeDeps(baseState()))
  const result = await handlers.putLog({
    loggedOn: "2026-07-07",
    timezone: "Not/AZone",
    clientSessionId: CLIENT_SESSION_ID,
    clientRevision: 1,
    dayType: "wash",
    products: [],
  })
  assert.equal(result.status, 400)
})

test("putLog: validates custom names and rejects products for none", async () => {
  const handlers = createTrackerApiHandlers(makeDeps(baseState()))
  const invalidCustom = await handlers.putLog({
    loggedOn: "2026-07-07",
    timezone: "Europe/Berlin",
    dayType: "custom",
    customActivityName: " ",
    products: [],
    clientSessionId: CLIENT_SESSION_ID,
    clientRevision: 1,
  })
  const noneWithProduct = await handlers.putLog({
    loggedOn: "2026-07-07",
    timezone: "Europe/Berlin",
    dayType: "none",
    products: [{ category: "shampoo", productName: null, userProductUsageId: null }],
    clientSessionId: CLIENT_SESSION_ID,
    clientRevision: 1,
  })
  assert.equal(invalidCustom.status, 400)
  assert.equal(noneWithProduct.status, 400)
})

test("tracker RPC contract: stale save after delete cannot resurrect; another session remains last-write-wins", async () => {
  const state = baseState()
  const handlers = createTrackerApiHandlers(makeDeps(state))
  const base = {
    loggedOn: "2026-07-07",
    timezone: "Europe/Berlin",
    dayType: "custom",
    customActivityName: "Sauna",
    products: [],
  }
  await handlers.putLog({ ...base, clientSessionId: CLIENT_SESSION_ID, clientRevision: 2 })
  const deleted = await handlers.deleteLog({
    loggedOn: base.loggedOn,
    timezone: base.timezone,
    clientSessionId: CLIENT_SESSION_ID,
    clientRevision: 3,
  })
  const staleSave = await handlers.putLog({
    ...base,
    clientSessionId: CLIENT_SESSION_ID,
    clientRevision: 2,
  })
  const otherSessionSave = await handlers.putLog({
    ...base,
    dayType: "wash",
    customActivityName: null,
    clientSessionId: "55555555-5555-4555-8555-555555555555",
    clientRevision: 1,
  })
  assert.equal((deleted.body.day as { deletedAt: string }).deletedAt !== null, true)
  assert.equal((staleSave.body.day as { deletedAt: string }).deletedAt !== null, true)
  assert.equal((otherSessionSave.body.day as { deletedAt: string | null }).deletedAt, null)
  assert.deepEqual(
    state.rpcCalls.map((call) => call.functionName),
    ["replace_routine_log", "delete_routine_log", "replace_routine_log", "replace_routine_log"],
  )
})

test("dismissNudge: upserts dismissal with 30-day cooldown", async () => {
  const state = baseState()
  const handlers = createTrackerApiHandlers(makeDeps(state))
  const result = await handlers.dismissNudge({
    category: "mask",
    direction: "increase",
  })
  assert.equal(result.status, 200)
  const write = state.writes.find((candidate) => candidate.table === "tracker_nudge_dismissals")
  assert.ok(write)
  assert.equal(write.op, "upsert")
  const payload = write.payload as { reappear_at: string }
  assert.equal(payload.reappear_at, "2026-08-06T12:00:00.000Z")
  assert.equal(state.adminCalls, 1)
})

test("tracker admin reads remain scoped to the authenticated user", async () => {
  const state = baseState()
  state.tables.routine_logs = [
    { id: "owned", user_id: "user-1", logged_on: "2026-07-07", day_type: "wash", deleted_at: null },
    {
      id: "foreign",
      user_id: "user-2",
      logged_on: "2026-07-07",
      day_type: "wash",
      deleted_at: null,
    },
  ]
  const result = await createTrackerApiHandlers(makeDeps(state)).getTracker({ tz: "Europe/Berlin" })
  assert.equal(result.status, 200)
  assert.deepEqual(
    (result.body.days as Array<{ loggedOn: string }>).map((day) => day.loggedOn),
    ["2026-07-07"],
  )
})

test("getTracker: unlocked gate computes nudges from logs", async () => {
  const state = baseState()
  const dates = [
    "2026-06-20",
    "2026-06-22",
    "2026-06-24",
    "2026-06-26",
    "2026-06-28",
    "2026-06-30",
    "2026-07-02",
    "2026-07-04",
    "2026-07-05",
    "2026-07-06",
  ]
  state.tables.routine_logs = dates.map((date, index) => ({
    id: `log-${index}`,
    user_id: "user-1",
    logged_on: date,
    day_type: "wash",
  }))
  state.tables.routine_log_products = [
    ...dates.map((_, index) => ({
      id: `p-${index}`,
      routine_log_id: `log-${index}`,
      category: "shampoo",
      product_name: "Elvital",
      user_product_usage_id: UPU_SHAMPOO_ID,
    })),
    {
      id: "pm",
      routine_log_id: "log-1",
      category: "mask",
      product_name: "Olaplex No. 8",
      user_product_usage_id: UPU_MASK_ID,
    },
  ]
  const handlers = createTrackerApiHandlers(makeDeps(state))
  const result = await handlers.getTracker({ tz: "Europe/Berlin" })
  const body = result.body as {
    gate: { unlocked: boolean }
    nudges: Array<{ category: string; direction: string }>
  }
  assert.equal(body.gate.unlocked, true)
  const mask = body.nudges.find((nudge) => nudge.category === "mask")
  assert.ok(mask)
  assert.equal(mask.direction, "increase")
})
