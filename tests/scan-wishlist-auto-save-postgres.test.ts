import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { PGlite } from "@electric-sql/pglite"

import { autoSaveScanWishlistProduct } from "../src/lib/scan/saved-state"

/**
 * Postgres-level coverage for T16's auto-save write, against the REAL `scan_wishlist` +
 * `user_products` schema (harness pattern: tests/scan-move-saved-product-postgres.test.ts).
 *
 * Fix round 1 (F4): this now calls the REAL `autoSaveScanWishlistProduct`
 * (src/lib/scan/saved-state.ts) rather than a hand-written SQL statement standing in for
 * it — the previous version asserted the reviewer's/implementer's *hypothesis* about what
 * supabase-js's `.upsert(..., { onConflict, ignoreDuplicates: true })` emits, proven only
 * indirectly by the call-shape tests in tests/scan-saved-state.test.ts. `pgliteSupabaseClient`
 * below is a thin, purpose-built shim that translates the EXACT query-builder chains the
 * function under test issues (`.from("user_products").select(...).eq(...)×4` for the F2
 * ownership check, `.from("scan_wishlist").upsert(payload, options)` for the write) into
 * SQL run against PGlite — not a general supabase-js emulator, just enough surface for this
 * one function, so a drift in what supabase-js actually sends is no longer invisible to
 * this suite. Running that through the real schema, with a real `user_products` ownership
 * row already seeded, is what proves THE hazard (the move endpoint's DELETE semantics)
 * cannot leak into auto-save: the function never issues a DELETE at all, so the ownership
 * row has nothing to survive except a write that structurally cannot touch it — and (F2)
 * that an owned row makes the function skip the write outright.
 */

const ROOT = new URL("../", import.meta.url)

const MIGRATIONS = [
  // Real `user_products`, so the seeded ownership row is the real shape.
  "supabase/migrations/20260808062602_personal_plan_stage1_3_foundation.sql",
  // Real `scan_wishlist`, including its UNIQUE (user_id, product_id) — the constraint the
  // auto-save upsert's ON CONFLICT target names.
  "supabase/migrations/20260820100200_scan_wishlist.sql",
] as const

// Minimal FK targets and project-wide utilities. Column shapes only — copied from
// tests/scan-move-saved-product-postgres.test.ts.
const STUB_PREREQUISITES = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE FUNCTION extensions.digest(value bytea, algorithm text)
  RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT sha256(value) $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
-- scan_wishlist.user_id references auth.users(id); Supabase's auth schema is not
-- part of any tracked migration.
CREATE TABLE auth.users (id uuid PRIMARY KEY);

-- Copied verbatim from supabase/migrations/00001_initial_schema.sql.
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TABLE public.profiles (id uuid PRIMARY KEY);
CREATE TABLE public.product_categories (
  key text PRIMARY KEY,
  is_intake_supported boolean NOT NULL DEFAULT true
);
CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  brand text,
  category_key text REFERENCES public.product_categories(key),
  origin text NOT NULL DEFAULT 'curated',
  is_active boolean NOT NULL DEFAULT true,
  lifecycle_status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`

const USER = "11111111-1111-4111-8111-111111111111"
const OTHER_USER = "33333333-3333-4333-8333-333333333333"
const PRODUCT = "22222222-2222-4222-8222-222222222222"
const OTHER_PRODUCT = "44444444-4444-4444-8444-444444444444"

async function migratedDatabase(t: { after: (fn: () => Promise<void>) => void }): Promise<PGlite> {
  const pg = new PGlite()
  t.after(async () => {
    await pg.close()
  })
  await pg.exec(STUB_PREREQUISITES)
  for (const migration of MIGRATIONS) {
    await pg.exec(await readFile(new URL(migration, ROOT), "utf8"))
  }
  await seed(pg)
  return pg
}

async function seed(pg: PGlite) {
  await pg.exec(`
    INSERT INTO public.product_categories (key) VALUES ('shampoo');
    INSERT INTO auth.users (id) VALUES ('${USER}'), ('${OTHER_USER}');
    INSERT INTO public.profiles (id) VALUES ('${USER}'), ('${OTHER_USER}');
    INSERT INTO public.products (id, name, brand, category_key, is_active, lifecycle_status)
      VALUES
        ('${PRODUCT}', 'Repair Shampoo', 'Testbrand', 'shampoo', true, 'active'),
        ('${OTHER_PRODUCT}', 'Sanftes Shampoo', 'Testbrand', 'shampoo', true, 'active');
  `)
}

/**
 * A minimal supabase-js-shaped shim over PGlite — see the file header for why this exists
 * and its intentionally narrow scope. Only supports the two chains
 * `autoSaveScanWishlistProduct` (and the `loadOwnedRoutineRows` helper it calls) actually
 * issues:
 *   - `.from(table).select(cols).eq(col, val)...` — awaited directly (no `.maybeSingle()`),
 *     translated into `SELECT <cols> FROM public.<table> WHERE <col> = $n AND ...`.
 *   - `.from(table).upsert(payload, { onConflict, ignoreDuplicates })` — awaited directly,
 *     translated into `INSERT INTO public.<table> (...) VALUES (...) ON CONFLICT (...) DO
 *     NOTHING` (the only `ignoreDuplicates` value either call site ever passes).
 */
function pgliteSupabaseClient(pg: PGlite) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = []
      const builder = {
        select(_columns: string) {
          return builder
        },
        eq(column: string, value: unknown) {
          filters.push([column, value])
          return builder
        },
        upsert(payload: Record<string, unknown>, options: { onConflict: string }) {
          return {
            then: async (resolve: (result: { error: unknown }) => unknown) => {
              const columns = Object.keys(payload)
              const values = columns.map((column) => payload[column])
              const placeholders = columns.map((_, index) => `$${index + 1}`)
              try {
                await pg.query(
                  `INSERT INTO public.${table} (${columns.join(", ")})
                     VALUES (${placeholders.join(", ")})
                   ON CONFLICT (${options.onConflict}) DO NOTHING`,
                  values,
                )
                return resolve({ error: null })
              } catch (error) {
                return resolve({ error: { message: String(error) } })
              }
            },
          }
        },
        then: async (resolve: (result: { data: unknown; error: unknown }) => unknown) => {
          const where = filters.map(([column], index) => `${column} = $${index + 1}`).join(" AND ")
          const values = filters.map(([, value]) => value)
          try {
            const { rows } = await pg.query(`SELECT * FROM public.${table} WHERE ${where}`, values)
            return resolve({ data: rows, error: null })
          } catch (error) {
            return resolve({ data: null, error: { message: String(error) } })
          }
        },
      }
      return builder
    },
  }
}

async function insertOwnedRow(pg: PGlite, userId = USER, productId = PRODUCT) {
  await pg.query(
    `INSERT INTO public.user_products
       (user_id, category, catalog_product_id, brand_text, product_name_text,
        identity_status, ownership_status, intake_source)
     VALUES ($1, 'shampoo', $2, 'Testbrand', 'Repair Shampoo', 'matched', 'owned', 'catalog_search')
     RETURNING id`,
    [userId, productId],
  )
}

async function ownedRows(pg: PGlite, userId = USER, productId = PRODUCT) {
  const { rows } = await pg.query<{
    id: string
    ownership_status: string
    identity_status: string
    intake_source: string | null
  }>(
    `SELECT id, ownership_status, identity_status, intake_source FROM public.user_products
      WHERE user_id = $1 AND catalog_product_id = $2`,
    [userId, productId],
  )
  return rows
}

async function wishlistCount(pg: PGlite, userId = USER, productId = PRODUCT) {
  const { rows } = await pg.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM public.scan_wishlist WHERE user_id = $1 AND product_id = $2`,
    [userId, productId],
  )
  return rows[0]!.count
}

async function autoSave(pg: PGlite, userId: string, productId: string) {
  const client = pgliteSupabaseClient(pg)
  await autoSaveScanWishlistProduct(client as never, userId, productId)
}

test("auto-save: a bare scan wishlist-saves the product (round trip into the listing the Gemerkt section reads)", async (t) => {
  const pg = await migratedDatabase(t)
  await autoSave(pg, USER, PRODUCT)
  assert.equal(await wishlistCount(pg), 1)
})

test("auto-save: rescanning the same product is idempotent — exactly one row survives repeated scans", async (t) => {
  const pg = await migratedDatabase(t)
  await autoSave(pg, USER, PRODUCT)
  await autoSave(pg, USER, PRODUCT)
  await autoSave(pg, USER, PRODUCT)
  assert.equal(await wishlistCount(pg), 1)
})

test("auto-save NON-DESTRUCTIVE REGRESSION: owning a product, then rescanning + auto-saving it, leaves the ownership row untouched AND writes no wishlist row (F2)", async (t) => {
  const pg = await migratedDatabase(t)
  await insertOwnedRow(pg)
  const before = await ownedRows(pg)
  assert.equal(before.length, 1)

  // The rescan: exactly what the resolve route's auto-save call performs for a premium
  // in-catalog verdict. THE hazard this guards against is `scan_move_saved_product`
  // (migration 20260904150000) reaching this same product and DELETEing this row — this
  // function issues no DELETE at all and never writes `user_products`. Fix round 1 (F2)
  // adds a second guarantee on top: the ownership check must SKIP the wishlist write
  // entirely for an owned product, keeping the Merkliste↔Routine exclusivity the move
  // endpoint's own migration documents.
  await autoSave(pg, USER, PRODUCT)

  const after = await ownedRows(pg)
  assert.deepEqual(after, before, "the owned row must survive byte-for-byte")
  assert.equal(after[0]!.ownership_status, "owned")
  assert.equal(after[0]!.intake_source, "catalog_search")
  // F2 ruling: an owned product gets NO wishlist row from auto-save — not "harmlessly
  // present alongside ownership", but skipped outright.
  assert.equal(await wishlistCount(pg), 0)
})

test("auto-save NON-DESTRUCTIVE REGRESSION: repeated rescan+auto-save of an owned product never touches ownership nor writes a wishlist row, across multiple scans", async (t) => {
  const pg = await migratedDatabase(t)
  await insertOwnedRow(pg)
  const before = await ownedRows(pg)

  await autoSave(pg, USER, PRODUCT)
  await autoSave(pg, USER, PRODUCT)
  await autoSave(pg, USER, PRODUCT)

  assert.deepEqual(await ownedRows(pg), before)
  assert.equal(await wishlistCount(pg), 0, "still skipped on every repeat, owned row present")
})

test("auto-save: scoped to user and product — another user's or another product's rows are untouched", async (t) => {
  const pg = await migratedDatabase(t)
  await autoSave(pg, USER, PRODUCT)
  await autoSave(pg, OTHER_USER, PRODUCT)
  await autoSave(pg, USER, OTHER_PRODUCT)

  assert.equal(await wishlistCount(pg, USER, PRODUCT), 1)
  assert.equal(await wishlistCount(pg, OTHER_USER, PRODUCT), 1)
  assert.equal(await wishlistCount(pg, USER, OTHER_PRODUCT), 1)
  // Three independent rows, not one collapsed by an over-broad conflict target.
  const { rows } = await pg.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM public.scan_wishlist`,
  )
  assert.equal(rows[0]!.count, 3)
})

test("auto-save: an owned row from ANOTHER user does not block this user's rescan, and is itself untouched", async (t) => {
  const pg = await migratedDatabase(t)
  await insertOwnedRow(pg, OTHER_USER, PRODUCT)
  const before = await ownedRows(pg, OTHER_USER, PRODUCT)

  await autoSave(pg, USER, PRODUCT)

  assert.deepEqual(await ownedRows(pg, OTHER_USER, PRODUCT), before)
  assert.equal(
    await wishlistCount(pg, OTHER_USER, PRODUCT),
    0,
    "the other user gained no wishlist row",
  )
  // The ownership check is scoped per user: another user's owned row must not skip THIS
  // user's write.
  assert.equal(await wishlistCount(pg, USER, PRODUCT), 1)
})
