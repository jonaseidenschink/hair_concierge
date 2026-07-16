import assert from "node:assert/strict"
import test from "node:test"

import { getPricingRedirectTarget } from "../src/components/tracker/use-tracker-autosave"
import { TrackerSaveCoordinator, type TrackerSaveState } from "../src/lib/tracking/save-coordinator"

interface Payload {
  date: string
  value: string
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

test("recognizes a same-origin followed pricing redirect", () => {
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "http://localhost:3223" } },
  })
  try {
    assert.equal(
      getPricingRedirectTarget({
        redirected: true,
        url: "http://localhost:3223/pricing?reason=resubscribe",
      }),
      "/pricing?reason=resubscribe",
    )
    assert.equal(
      getPricingRedirectTarget({ redirected: true, url: "https://example.com/pricing" }),
      null,
    )
    assert.equal(
      getPricingRedirectTarget({ redirected: false, url: "http://localhost:3223/pricing" }),
      null,
    )
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test("coalesces rapid updates and never runs more than one save", async () => {
  const calls: Array<{ payload: Payload; revision: number }> = []
  const gates = [deferred(), deferred()]
  let concurrent = 0
  let maxConcurrent = 0
  const coordinator = new TrackerSaveCoordinator<Payload>({
    keyOf: (payload) => payload.date,
    debounceMs: 0,
    save: async (payload, context) => {
      calls.push({ payload, revision: context.revision })
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await gates[calls.length - 1].promise
      concurrent -= 1
    },
  })

  coordinator.queueSave({ date: "2026-07-13", value: "first" })
  await nextTurn()
  coordinator.queueSave({ date: "2026-07-13", value: "middle" })
  coordinator.queueSave({ date: "2026-07-13", value: "latest" })
  await nextTurn()
  assert.equal(calls.length, 1)

  gates[0].resolve()
  await nextTurn()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].payload.value, "latest")
  gates[1].resolve()
  await coordinator.flush()

  assert.equal(maxConcurrent, 1)
  assert.deepEqual(
    calls.map((call) => call.revision),
    [1, 3],
  )
})

test("retains updates for two dates and saves them serially", async () => {
  const calls: Payload[] = []
  const coordinator = new TrackerSaveCoordinator<Payload>({
    keyOf: (payload) => payload.date,
    debounceMs: 60_000,
    save: async (payload) => {
      calls.push(payload)
    },
  })

  coordinator.queueSave({ date: "2026-07-12", value: "a" })
  coordinator.queueSave({ date: "2026-07-13", value: "b" })
  await coordinator.flush()

  assert.deepEqual(
    calls.map((call) => call.date),
    ["2026-07-12", "2026-07-13"],
  )
})

test("an older success cannot mark a newer revision saved", async () => {
  const first = deferred()
  const states: TrackerSaveState[] = []
  let callCount = 0
  const coordinator = new TrackerSaveCoordinator<Payload>({
    keyOf: (payload) => payload.date,
    debounceMs: 0,
    onStateChange: (_key, state) => states.push(state),
    save: async () => {
      callCount += 1
      if (callCount === 1) await first.promise
    },
  })

  coordinator.queueSave({ date: "2026-07-13", value: "old" })
  await nextTurn()
  coordinator.queueSave({ date: "2026-07-13", value: "new" })
  await nextTurn()
  first.resolve()
  await coordinator.flush()

  const savedRevisions = states
    .filter((state) => state.status === "saved")
    .map((state) => state.revision)
  assert.deepEqual(savedRevisions, [2])
})

test("retries retryable failures once before surfacing an error", async () => {
  const states: TrackerSaveState[] = []
  let attempts = 0
  const coordinator = new TrackerSaveCoordinator<Payload>({
    keyOf: (payload) => payload.date,
    debounceMs: 0,
    retryDelayMs: 0,
    shouldRetry: () => true,
    onStateChange: (_key, state) => states.push(state),
    save: async () => {
      attempts += 1
      throw new Error("temporary")
    },
  })

  coordinator.queueSave({ date: "2026-07-13", value: "x" })
  await coordinator.flush()

  assert.equal(attempts, 2)
  assert.equal(states.at(-1)?.status, "error")
})

test("does not retry a non-retryable validation failure", async () => {
  let attempts = 0
  const coordinator = new TrackerSaveCoordinator<Payload>({
    keyOf: (payload) => payload.date,
    debounceMs: 0,
    shouldRetry: () => false,
    save: async () => {
      attempts += 1
      throw new Error("validation")
    },
  })

  coordinator.queueSave({ date: "2026-07-13", value: "invalid" })
  await coordinator.flush()

  assert.equal(attempts, 1)
  assert.equal(coordinator.getState("2026-07-13").status, "error")
})

test("manual retry reuses the failed revision and can recover", async () => {
  const revisions: number[] = []
  let fail = true
  const coordinator = new TrackerSaveCoordinator<Payload>({
    keyOf: (payload) => payload.date,
    debounceMs: 0,
    save: async (_payload, context) => {
      revisions.push(context.revision)
      if (fail) throw new Error("nope")
    },
  })

  coordinator.queueSave({ date: "2026-07-13", value: "x" })
  await coordinator.flush()
  assert.equal(coordinator.getState("2026-07-13").status, "error")

  fail = false
  assert.equal(coordinator.retry("2026-07-13"), true)
  await coordinator.flush()

  assert.deepEqual(revisions, [1, 1])
  assert.equal(coordinator.getState("2026-07-13").status, "saved")
})

test("flush bypasses the trailing debounce and idle fires once", async () => {
  let saves = 0
  let idleCalls = 0
  const coordinator = new TrackerSaveCoordinator<Payload>({
    keyOf: (payload) => payload.date,
    debounceMs: 60_000,
    onIdle: () => {
      idleCalls += 1
    },
    save: async () => {
      saves += 1
    },
  })

  coordinator.queueSave({ date: "2026-07-13", value: "x" })
  await coordinator.flush()

  assert.equal(saves, 1)
  assert.equal(idleCalls, 1)
})

test("dismissing an invalid custom draft restores the latest valid snapshot after an in-flight save", async () => {
  const gate = deferred()
  const calls: Array<{ payload: Payload; revision: number }> = []
  const states: string[] = []
  const coordinator = new TrackerSaveCoordinator<Payload>({
    keyOf: (payload) => payload.date,
    debounceMs: 0,
    save: async (payload, context) => {
      calls.push({ payload, revision: context.revision })
      if (calls.length === 1) await gate.promise
    },
    onStateChange: (_key, state) => states.push(state.status),
  })

  coordinator.queueSave({ date: "2026-07-07", value: "wash" })
  await nextTurn()
  coordinator.supersede("2026-07-07")
  coordinator.queueSave({ date: "2026-07-07", value: "wash" })
  gate.resolve()
  await coordinator.flush()

  assert.deepEqual(calls, [
    { payload: { date: "2026-07-07", value: "wash" }, revision: 1 },
    { payload: { date: "2026-07-07", value: "wash" }, revision: 3 },
  ])
  assert.equal(coordinator.getState("2026-07-07").status, "saved")
  assert.equal(states.at(-1), "saved")
})

test("a dispatched date can receive a higher-revision tombstone when no valid snapshot remains", async () => {
  const gate = deferred()
  const calls: Array<{ payload: Payload; revision: number }> = []
  const coordinator = new TrackerSaveCoordinator<Payload>({
    keyOf: (payload) => payload.date,
    debounceMs: 0,
    save: async (payload, context) => {
      calls.push({ payload, revision: context.revision })
      if (calls.length === 1) await gate.promise
    },
  })

  coordinator.queueSave({ date: "2026-07-07", value: "transient" })
  await nextTurn()
  assert.equal(coordinator.hasDispatched("2026-07-07"), true)
  coordinator.supersede("2026-07-07")
  coordinator.queueSave({ date: "2026-07-07", value: "delete" })
  gate.resolve()
  await coordinator.flush()

  assert.deepEqual(calls, [
    { payload: { date: "2026-07-07", value: "transient" }, revision: 1 },
    { payload: { date: "2026-07-07", value: "delete" }, revision: 3 },
  ])
})

test("superseding during retry backoff prevents the obsolete retry", async () => {
  const retryGate = deferred()
  let attempts = 0
  const coordinator = new TrackerSaveCoordinator<Payload>({
    keyOf: (payload) => payload.date,
    debounceMs: 0,
    retryDelayMs: 0,
    shouldRetry: () => true,
    setTimer: (callback, delay) => {
      if (delay === 0 && attempts > 0) {
        void retryGate.promise.then(callback)
        return 1 as unknown as ReturnType<typeof setTimeout>
      }
      return setTimeout(callback, delay)
    },
    clearTimer: (timer) => clearTimeout(timer),
    save: async () => {
      attempts += 1
      throw new Error("network")
    },
  })

  coordinator.queueSave({ date: "2026-07-07", value: "wash" })
  await nextTurn()
  coordinator.supersede("2026-07-07")
  retryGate.resolve()
  await coordinator.flush()

  assert.equal(attempts, 1)
  assert.equal(coordinator.getState("2026-07-07").status, "idle")
})
