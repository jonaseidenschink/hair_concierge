import assert from "node:assert/strict"
import test from "node:test"

import {
  autoSaveScanWishlistProduct,
  loadScanSavedState,
  moveScanSavedProduct,
  removeScanRoutineProduct,
  removeScanWishlistProduct,
} from "../src/lib/scan/saved-state"

type TableHandlers = Record<
  string,
  {
    select?: (calls: { filters: Map<string, unknown> }) => { data: unknown; error: unknown }
    /** For a `.select().eq()...` chain awaited directly (list read, no `maybeSingle`). */
    selectList?: (calls: { filters: Map<string, unknown> }) => { data: unknown; error: unknown }
    insert?: (payload: unknown) => { error: unknown }
    upsert?: (payload: unknown, options: unknown) => { error: unknown }
    delete?: (calls: { filters: Map<string, unknown> }) => { error: unknown }
  }
>

function stubClient(handlers: TableHandlers) {
  const inserts: Array<{ table: string; payload: unknown }> = []
  const upserts: Array<{ table: string; payload: unknown; options: unknown }> = []
  const deletes: Array<{ table: string; filters: Map<string, unknown> }> = []

  const client = {
    from(table: string) {
      const handler = handlers[table]
      if (!handler) throw new Error(`unexpected table ${table}`)
      const filters = new Map<string, unknown>()
      const selectChain = {
        select: () => selectChain,
        eq: (column: string, value: unknown) => {
          filters.set(column, value)
          return selectChain
        },
        maybeSingle: async () => {
          if (!handler.select) throw new Error(`no select handler for ${table}`)
          return handler.select({ filters })
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (!handler.selectList) throw new Error(`no selectList handler for ${table}`)
          return resolve(handler.selectList({ filters }))
        },
      }
      const deleteChain = {
        eq: (column: string, value: unknown) => {
          filters.set(column, value)
          return deleteChain
        },
        then: (resolve: (value: unknown) => unknown) => {
          deletes.push({ table, filters })
          if (!handler.delete) throw new Error(`no delete handler for ${table}`)
          return resolve(handler.delete({ filters }))
        },
      }
      return {
        select: selectChain.select,
        insert: (payload: unknown) => {
          inserts.push({ table, payload })
          if (!handler.insert) throw new Error(`no insert handler for ${table}`)
          return handler.insert(payload)
        },
        upsert: (payload: unknown, options: unknown) => {
          upserts.push({ table, payload, options })
          if (!handler.upsert) throw new Error(`no upsert handler for ${table}`)
          return handler.upsert(payload, options)
        },
        delete: () => deleteChain,
      }
    },
  }
  return { client, inserts, upserts, deletes }
}

test("loadScanSavedState: wishlist row present returns merkliste before checking user_products", async () => {
  const { client } = stubClient({
    scan_wishlist: { select: () => ({ data: { id: "wish-1" }, error: null }) },
    // user_products deliberately has no select handler: must not be reached.
  })
  const result = await loadScanSavedState(client as never, "user-1", "prod-1")
  // A scan_wishlist row can only have come from this surface, so it is always removable.
  assert.deepEqual(result, { state: "merkliste", managedByScan: true })
})

test("loadScanSavedState: a scan-created owned row is routine and removable from here", async () => {
  const seen: Array<Map<string, unknown>> = []
  const { client } = stubClient({
    scan_wishlist: { select: () => ({ data: null, error: null }) },
    user_products: {
      selectList: ({ filters }) => {
        seen.push(filters)
        return { data: [{ id: "up-1", intake_source: "scan" }], error: null }
      },
    },
  })
  const result = await loadScanSavedState(client as never, "user-1", "prod-1")
  assert.deepEqual(result, { state: "routine", managedByScan: true })
  // Deliberately NOT filtered by intake_source: the query asks "does the user own this
  // product at all", and `managedByScan` answers the separate "may scan remove it" question.
  assert.equal(seen[0].has("intake_source"), false)
  assert.equal(seen[0].get("identity_status"), "matched")
  assert.equal(seen[0].get("ownership_status"), "owned")
  assert.equal(seen[0].get("user_id"), "user-1")
  assert.equal(seen[0].get("catalog_product_id"), "prod-1")
})

test("loadScanSavedState: a Stage-3-claimed routine product is reported truthfully, not removable", async () => {
  const { client } = stubClient({
    scan_wishlist: { select: () => ({ data: null, error: null }) },
    user_products: {
      selectList: () => ({ data: [{ id: "up-1", intake_source: "catalog_search" }], error: null }),
    },
  })
  const result = await loadScanSavedState(client as never, "user-1", "prod-1")
  // The footer must say "✓ In deiner Routine" — the product really is in the routine —
  // while the change sheet refuses to remove a row another surface owns.
  assert.deepEqual(result, { state: "routine", managedByScan: false })
})

test("loadScanSavedState: one scan row among foreign rows keeps the product removable", async () => {
  const { client } = stubClient({
    scan_wishlist: { select: () => ({ data: null, error: null }) },
    user_products: {
      selectList: () => ({
        data: [
          { id: "up-1", intake_source: "catalog_search" },
          { id: "up-2", intake_source: "scan" },
        ],
        error: null,
      }),
    },
  })
  const result = await loadScanSavedState(client as never, "user-1", "prod-1")
  assert.deepEqual(result, { state: "routine", managedByScan: true })
})

test("loadScanSavedState: neither present returns the not-saved payload", async () => {
  const { client } = stubClient({
    scan_wishlist: { select: () => ({ data: null, error: null }) },
    user_products: { selectList: () => ({ data: [], error: null }) },
  })
  const result = await loadScanSavedState(client as never, "user-1", "prod-1")
  assert.deepEqual(result, { state: null, managedByScan: false })
})

test("loadScanSavedState: a lookup error throws a stable error", async () => {
  const { client } = stubClient({
    scan_wishlist: { select: () => ({ data: null, error: { message: "boom" } }) },
  })
  await assert.rejects(
    () => loadScanSavedState(client as never, "user-1", "prod-1"),
    /scan_saved_state_lookup_failed/,
  )
})

test("removeScanWishlistProduct: deletes scoped to user and product, no-op if absent", async () => {
  const { client, deletes } = stubClient({
    scan_wishlist: { delete: () => ({ error: null }) },
  })
  const result = await removeScanWishlistProduct(client as never, "user-1", "prod-1")
  assert.deepEqual(result, { outcome: "removed" })
  assert.equal(deletes.length, 1)
  assert.equal(deletes[0].filters.get("user_id"), "user-1")
  assert.equal(deletes[0].filters.get("product_id"), "prod-1")
})

test("removeScanRoutineProduct: only deletes rows this helper's own intake_source created", async () => {
  const { client, deletes } = stubClient({
    user_products: {
      selectList: () => ({ data: [{ id: "up-1", intake_source: "scan" }], error: null }),
      delete: () => ({ error: null }),
    },
  })
  const result = await removeScanRoutineProduct(client as never, "user-1", "prod-1")
  assert.deepEqual(result, { outcome: "removed" })
  assert.equal(deletes.length, 1)
  assert.equal(deletes[0].filters.get("intake_source"), "scan")
  assert.equal(deletes[0].filters.get("ownership_status"), "owned")
  assert.equal(deletes[0].filters.get("catalog_product_id"), "prod-1")
})

test("removeScanRoutineProduct: refuses a row another surface owns instead of no-op success", async () => {
  const { client, deletes } = stubClient({
    user_products: {
      selectList: () => ({ data: [{ id: "up-1", intake_source: "catalog_search" }], error: null }),
      // No delete handler: the delete must never be attempted.
    },
  })
  const result = await removeScanRoutineProduct(client as never, "user-1", "prod-1")
  assert.deepEqual(result, { outcome: "not_removable_here" })
  assert.deepEqual(deletes, [])
})

test("removeScanRoutineProduct: nothing owned at all is a plain idempotent success", async () => {
  const { client } = stubClient({
    user_products: {
      selectList: () => ({ data: [], error: null }),
      delete: () => ({ error: null }),
    },
  })
  const result = await removeScanRoutineProduct(client as never, "user-1", "prod-1")
  assert.deepEqual(result, { outcome: "removed" })
})

/**
 * T16: `autoSaveScanWishlistProduct` is the ONLY write auto-save ever performs. These
 * tests prove its shape — insert-only, into `scan_wishlist` alone, `ON CONFLICT (user_id,
 * product_id) DO NOTHING` — at the JS-call level. The real Postgres semantics of that
 * upsert (including the named non-destructive regression against a seeded `user_products`
 * ownership row) are covered separately in tests/scan-wishlist-auto-save-postgres.test.ts.
 *
 * Fix round 1 (F2): the function now does one `user_products` READ (ownership check)
 * before the `scan_wishlist` write, so every test below has to wire a `user_products`
 * `selectList` handler too — an empty result models "not owned".
 */
const NOT_OWNED = { user_products: { selectList: () => ({ data: [], error: null }) } }

test("autoSaveScanWishlistProduct: upserts user_id + product_id into scan_wishlist with ON CONFLICT DO NOTHING semantics", async () => {
  const { client, upserts } = stubClient({
    scan_wishlist: { upsert: () => ({ error: null }) },
    ...NOT_OWNED,
  })
  await autoSaveScanWishlistProduct(client as never, "user-1", "prod-1")
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0].table, "scan_wishlist")
  assert.deepEqual(upserts[0].payload, { user_id: "user-1", product_id: "prod-1" })
  assert.deepEqual(upserts[0].options, { onConflict: "user_id,product_id", ignoreDuplicates: true })
})

test("autoSaveScanWishlistProduct: the F2 ownership check only READS user_products — never writes to any table but scan_wishlist", async () => {
  // `user_products` has a selectList handler (the ownership lookup) but deliberately no
  // insert/upsert/delete handler: an attempted write against it would throw "no <op>
  // handler for user_products" from `stubClient` — this is THE hazard's regression at the
  // call-shape level, mirroring `loadScanSavedState`'s wishlist-first test above.
  const { client } = stubClient({
    scan_wishlist: { upsert: () => ({ error: null }) },
    ...NOT_OWNED,
  })
  await assert.doesNotReject(() => autoSaveScanWishlistProduct(client as never, "user-1", "prod-1"))
})

test("autoSaveScanWishlistProduct: an owned product is skipped — no scan_wishlist write, exclusivity intact (F2 ruling)", async () => {
  const { client, upserts } = stubClient({
    // No upsert handler on scan_wishlist: reaching it at all would throw and fail the test.
    scan_wishlist: {},
    user_products: {
      selectList: () => ({ data: [{ id: "up-1", intake_source: "catalog_search" }], error: null }),
    },
  })
  await assert.doesNotReject(() => autoSaveScanWishlistProduct(client as never, "user-1", "prod-1"))
  assert.deepEqual(upserts, [])
})

test("autoSaveScanWishlistProduct: rescanning the same product upserts again — idempotency is ON CONFLICT's job", async () => {
  const { client, upserts } = stubClient({
    scan_wishlist: { upsert: () => ({ error: null }) },
    ...NOT_OWNED,
  })
  await autoSaveScanWishlistProduct(client as never, "user-1", "prod-1")
  await autoSaveScanWishlistProduct(client as never, "user-1", "prod-1")
  assert.equal(upserts.length, 2)
  assert.deepEqual(upserts[0].payload, upserts[1].payload)
})

test("autoSaveScanWishlistProduct: an upsert error throws a stable error", async () => {
  const { client } = stubClient({
    scan_wishlist: { upsert: () => ({ error: { message: "boom" } }) },
    ...NOT_OWNED,
  })
  await assert.rejects(
    () => autoSaveScanWishlistProduct(client as never, "user-1", "prod-1"),
    /scan_wishlist_auto_save_failed/,
  )
})

test("autoSaveScanWishlistProduct: an ownership-lookup error throws a stable error, before any write", async () => {
  const { client, upserts } = stubClient({
    scan_wishlist: {},
    user_products: { selectList: () => ({ data: null, error: { message: "boom" } }) },
  })
  await assert.rejects(
    () => autoSaveScanWishlistProduct(client as never, "user-1", "prod-1"),
    /scan_saved_state_lookup_failed/,
  )
  assert.deepEqual(upserts, [])
})

/**
 * `moveScanSavedProduct` owns no logic beyond the RPC call and the shape check — the
 * move itself (eligibility, both writes, the post-write state read) lives in
 * `scan_move_saved_product` and is covered against real Postgres in
 * tests/scan-move-saved-product-postgres.test.ts.
 */
function rpcClient(response: { data: unknown; error: unknown }) {
  const calls: Array<{ name: string; args: unknown }> = []
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args })
      return response
    },
  }
  return { client, calls }
}

test("moveScanSavedProduct: passes user, product and kind to the RPC", async () => {
  const { client, calls } = rpcClient({
    data: { outcome: "saved", savedState: { state: "routine", managedByScan: true } },
    error: null,
  })
  const result = await moveScanSavedProduct(client as never, "user-1", "prod-1", "routine")
  assert.deepEqual(result, {
    outcome: "saved",
    savedState: { state: "routine", managedByScan: true },
  })
  assert.deepEqual(calls, [
    {
      name: "scan_move_saved_product",
      args: { p_user_id: "user-1", p_product_id: "prod-1", p_kind: "routine" },
    },
  ])
})

test("moveScanSavedProduct: reports the RPC's refusal outcomes unchanged", async () => {
  for (const outcome of ["product_not_found", "product_not_saveable"] as const) {
    const { client } = rpcClient({ data: { outcome }, error: null })
    const result = await moveScanSavedProduct(client as never, "user-1", "prod-1", "merkliste")
    assert.deepEqual(result, { outcome })
  }
})

test("moveScanSavedProduct: a not-saved end state is carried through, not rewritten", async () => {
  const { client } = rpcClient({
    data: { outcome: "saved", savedState: { state: null, managedByScan: false } },
    error: null,
  })
  const result = await moveScanSavedProduct(client as never, "user-1", "prod-1", "merkliste")
  assert.deepEqual(result, {
    outcome: "saved",
    savedState: { state: null, managedByScan: false },
  })
})

test("moveScanSavedProduct: an RPC error throws a stable error", async () => {
  const { client } = rpcClient({ data: null, error: { message: "boom" } })
  await assert.rejects(
    () => moveScanSavedProduct(client as never, "user-1", "prod-1", "routine"),
    /scan_move_failed/,
  )
})

test("moveScanSavedProduct: a malformed payload throws instead of being reported as saved", async () => {
  const malformed = [
    null,
    { outcome: "who_knows" },
    { outcome: "saved" },
    { outcome: "saved", savedState: { state: "wunschliste", managedByScan: true } },
    { outcome: "saved", savedState: { state: "routine", managedByScan: "yes" } },
  ]
  for (const data of malformed) {
    const { client } = rpcClient({ data, error: null })
    await assert.rejects(
      () => moveScanSavedProduct(client as never, "user-1", "prod-1", "routine"),
      /scan_move_failed/,
    )
  }
})
