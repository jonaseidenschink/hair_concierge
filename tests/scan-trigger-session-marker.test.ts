import assert from "node:assert/strict"
import test from "node:test"

import {
  createMemoryScanTriggerStorage,
  readScanFatigueBudget,
  recordScanSession,
  SCAN_FATIGUE_BUDGET_KEY,
  SCAN_SESSION_RECORD_KEY,
  writeScanFatigueBudget,
} from "../src/lib/scan/triggers/session-marker"

/**
 * The trigger layer's two storage-backed session concepts (T10; reworked in fix round 1,
 * F1/F4/F5): `recordScanSession` (localStorage, permanent, feeds Wiederkehrer's "exactly
 * session 2" rule) and the fatigue budget (sessionStorage, per browsing session, feeds the
 * one-proactive-pitch-per-session rule). Both share the same injectable-storage shape as
 * `category-capture-queue.ts`.
 */

const THIRTY_ONE_MINUTES = 31 * 60 * 1000
const TWENTY_NINE_MINUTES = 29 * 60 * 1000

// --- recordScanSession (localStorage record) ---------------------------------------

test("recordScanSession: the first call on fresh storage is session 1", () => {
  const storage = createMemoryScanTriggerStorage()
  assert.equal(recordScanSession(storage, 1_000), 1)
  assert.ok(storage.getItem(SCAN_SESSION_RECORD_KEY))
})

test("recordScanSession: a call more than 30 minutes later is session 2", () => {
  const storage = createMemoryScanTriggerStorage()
  recordScanSession(storage, 1_000)
  assert.equal(recordScanSession(storage, 1_000 + THIRTY_ONE_MINUTES), 2)
})

test("recordScanSession: a call within 30 minutes stays the SAME session (no increment)", () => {
  const storage = createMemoryScanTriggerStorage()
  recordScanSession(storage, 1_000)
  assert.equal(recordScanSession(storage, 1_000 + TWENTY_NINE_MINUTES), 1)
  // An ordinary remount seconds later is emphatically the same session.
  assert.equal(recordScanSession(storage, 1_000 + TWENTY_NINE_MINUTES + 5_000), 1)
})

test("recordScanSession: the count keeps climbing across further 30-minute gaps", () => {
  const storage = createMemoryScanTriggerStorage()
  recordScanSession(storage, 1_000)
  recordScanSession(storage, 1_000 + THIRTY_ONE_MINUTES)
  assert.equal(recordScanSession(storage, 1_000 + 2 * THIRTY_ONE_MINUTES), 3)
})

test("recordScanSession: null storage (SSR, private mode) is always session 1, never crashes", () => {
  assert.equal(recordScanSession(null), 1)
})

test("recordScanSession: a storage that throws is treated as session 1, never crashes", () => {
  const throwing = {
    getItem() {
      throw new Error("blocked")
    },
    setItem() {
      throw new Error("blocked")
    },
  }
  assert.equal(recordScanSession(throwing), 1)
})

test("recordScanSession: corrupt/garbage JSON in storage is treated as no prior record", () => {
  const storage = createMemoryScanTriggerStorage()
  storage.setItem(SCAN_SESSION_RECORD_KEY, "not json")
  assert.equal(recordScanSession(storage, 1_000), 1)
})

// --- the fatigue budget (sessionStorage) -------------------------------------------

test("readScanFatigueBudget: nothing persisted yet answers null", () => {
  const storage = createMemoryScanTriggerStorage()
  assert.equal(readScanFatigueBudget(storage), null)
})

test("writeScanFatigueBudget + readScanFatigueBudget: round-trips a persisted trigger id", () => {
  const storage = createMemoryScanTriggerStorage()
  writeScanFatigueBudget(storage, "frust_serie")
  assert.equal(readScanFatigueBudget(storage), "frust_serie")
  assert.equal(storage.getItem(SCAN_FATIGUE_BUDGET_KEY), "frust_serie")
})

test("readScanFatigueBudget: null storage (SSR) or garbage content is always a safe null", () => {
  assert.equal(readScanFatigueBudget(null), null)
  const storage = createMemoryScanTriggerStorage()
  storage.setItem(SCAN_FATIGUE_BUDGET_KEY, "not-a-real-trigger-id")
  assert.equal(readScanFatigueBudget(storage), null)
})

test("readScanFatigueBudget/writeScanFatigueBudget: a storage that throws never crashes", () => {
  const throwing = {
    getItem() {
      throw new Error("blocked")
    },
    setItem() {
      throw new Error("blocked")
    },
  }
  assert.equal(readScanFatigueBudget(throwing), null)
  assert.doesNotThrow(() => writeScanFatigueBudget(throwing, "wiederkehrer"))
})

test("F1: the fatigue budget survives being read back by a fresh storage read (simulates a remount)", () => {
  // The whole point of F1: two independent reads against the SAME underlying storage (a
  // real sessionStorage is exactly this — one object surviving a component remount).
  const storage = createMemoryScanTriggerStorage()
  writeScanFatigueBudget(storage, "kategorien_luecke")
  const freshRead = readScanFatigueBudget(storage)
  assert.equal(freshRead, "kategorien_luecke")
})
