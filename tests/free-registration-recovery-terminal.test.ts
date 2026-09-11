import assert from "node:assert/strict"
import test from "node:test"

import { recoverMissingFreeSnapshot } from "../src/lib/auth/free-registration-recovery"
import type { ProvisionFreeInitialSnapshotResult } from "../src/lib/personal-plan/persistence/free-snapshot-service"

/**
 * T18 fix round 2, review finding N3: `no_quiz_artifact` and `invalid_source`
 * never self-heal — the underlying condition (no linked quiz artifact, or an
 * artifact `computeNeedPlan` refuses) does not change on a later attempt. Before
 * this, a permanently-stuck free account re-entered provisioning AND fired a
 * fresh Sentry `error` on EVERY `/scan` render, forever. `temporarily_unavailable`
 * is the opposite case — a real, possibly-transient outage — and must keep
 * retrying every render.
 *
 * These tests exercise `recoverMissingFreeSnapshot`'s injectable seams
 * directly (`hasInitialNeed`, `loadTerminalOutcome`, `markTerminalOutcome`,
 * `provision`, `report`), the same style `tests/free-registration-journey.test.ts`
 * uses for its W2 case, without needing a database.
 */

const USER_ID = "33333333-3333-4333-8333-333333333333"

function neverCalled(name: string) {
  return async () => {
    throw new Error(`${name} must not be called`)
  }
}

test("N3: a NOT-yet-terminal account attempts provisioning and marks a terminal outcome", async () => {
  const reports: { outcome: string; stage: string }[] = []
  const marks: { userId: string; outcome: string }[] = []

  const result = await recoverMissingFreeSnapshot({
    userId: USER_ID,
    hasInitialNeed: async () => false,
    loadTerminalOutcome: async () => null,
    markTerminalOutcome: async (userId, outcome) => {
      marks.push({ userId, outcome })
    },
    provision: async () => ({ outcome: "no_quiz_artifact" }) as ProvisionFreeInitialSnapshotResult,
    report: (res, ctx) => {
      reports.push({ outcome: res.outcome, stage: ctx.stage })
    },
  })

  assert.equal(result, "attempted")
  assert.deepEqual(reports, [{ outcome: "no_quiz_artifact", stage: "scan_retry" }])
  assert.deepEqual(marks, [{ userId: USER_ID, outcome: "no_quiz_artifact" }])
})

test("N3: invalid_source is also marked terminal", async () => {
  const marks: string[] = []
  const result = await recoverMissingFreeSnapshot({
    userId: USER_ID,
    hasInitialNeed: async () => false,
    loadTerminalOutcome: async () => null,
    markTerminalOutcome: async (_userId, outcome) => {
      marks.push(outcome)
    },
    provision: async () => ({ outcome: "invalid_source" }) as ProvisionFreeInitialSnapshotResult,
    report: () => {},
  })
  assert.equal(result, "attempted")
  assert.deepEqual(marks, ["invalid_source"])
})

test("N3: an ALREADY-terminal account short-circuits — no provision call, no report call", async () => {
  const result = await recoverMissingFreeSnapshot({
    userId: USER_ID,
    hasInitialNeed: async () => false,
    loadTerminalOutcome: async () => "no_quiz_artifact",
    provision: neverCalled("provision"),
    report: neverCalled("report") as never,
    markTerminalOutcome: neverCalled("markTerminalOutcome"),
  })
  assert.equal(result, "terminal")
})

test("N3: second render after a terminal first render fires exactly ONE Sentry report total", async () => {
  // Simulates the marker actually taking effect between two /scan renders by
  // sharing one mutable "stored outcome" across both `recoverMissingFreeSnapshot`
  // calls, the same way the `leads` row persists it in production.
  let storedOutcome: "no_quiz_artifact" | "invalid_source" | null = null
  let provisionCalls = 0
  const reports: string[] = []

  async function render() {
    return recoverMissingFreeSnapshot({
      userId: USER_ID,
      hasInitialNeed: async () => false,
      loadTerminalOutcome: async () => storedOutcome,
      markTerminalOutcome: async (_userId, outcome) => {
        storedOutcome = outcome
      },
      provision: async () => {
        provisionCalls += 1
        return { outcome: "no_quiz_artifact" } as ProvisionFreeInitialSnapshotResult
      },
      report: (res) => {
        reports.push(res.outcome)
      },
    })
  }

  const first = await render()
  const second = await render()

  assert.equal(first, "attempted")
  assert.equal(second, "terminal")
  assert.equal(provisionCalls, 1, "the second render must never retry provisioning")
  assert.deepEqual(reports, ["no_quiz_artifact"], "exactly one Sentry report total")
})

test("N3: temporarily_unavailable is never marked terminal — retry stays allowed every render", async () => {
  let storedOutcome: "no_quiz_artifact" | "invalid_source" | null = null
  let provisionCalls = 0
  const reports: string[] = []

  async function render() {
    return recoverMissingFreeSnapshot({
      userId: USER_ID,
      hasInitialNeed: async () => false,
      loadTerminalOutcome: async () => storedOutcome,
      markTerminalOutcome: async (_userId, outcome) => {
        storedOutcome = outcome
      },
      provision: async () => {
        provisionCalls += 1
        return { outcome: "temporarily_unavailable" } as ProvisionFreeInitialSnapshotResult
      },
      report: (res) => {
        reports.push(res.outcome)
      },
    })
  }

  const first = await render()
  const second = await render()
  const third = await render()

  assert.deepEqual([first, second, third], ["attempted", "attempted", "attempted"])
  assert.equal(provisionCalls, 3, "a transient outcome must keep retrying every render")
  assert.deepEqual(reports, [
    "temporarily_unavailable",
    "temporarily_unavailable",
    "temporarily_unavailable",
  ])
})

test("N3: a failed marker write is swallowed — the render still succeeds", async () => {
  const result = await recoverMissingFreeSnapshot({
    userId: USER_ID,
    hasInitialNeed: async () => false,
    loadTerminalOutcome: async () => null,
    markTerminalOutcome: async () => {
      throw new Error("db unavailable")
    },
    provision: async () => ({ outcome: "no_quiz_artifact" }) as ProvisionFreeInitialSnapshotResult,
    report: () => {},
  })
  assert.equal(result, "attempted", "a telemetry/marker failure must never break the page")
})

test("N3: a provisioned/paid_user outcome is never marked terminal", async () => {
  for (const outcome of ["provisioned", "paid_user"] as const) {
    const marks: string[] = []
    await recoverMissingFreeSnapshot({
      userId: USER_ID,
      hasInitialNeed: async () => false,
      loadTerminalOutcome: async () => null,
      markTerminalOutcome: async (_userId, o) => {
        marks.push(o)
      },
      provision: async () =>
        (outcome === "provisioned"
          ? {
              outcome: "provisioned",
              personalPlanId: "p",
              needVersionId: "n",
              outputSnapshot: {},
            }
          : { outcome: "paid_user" }) as ProvisionFreeInitialSnapshotResult,
      report: () => {},
    })
    assert.deepEqual(marks, [], outcome)
  }
})

test("N3: an already-provisioned account (hasInitialNeed) never consults the terminal marker at all", async () => {
  const result = await recoverMissingFreeSnapshot({
    userId: USER_ID,
    hasInitialNeed: async () => true,
    loadTerminalOutcome: neverCalled("loadTerminalOutcome"),
    provision: neverCalled("provision"),
    report: neverCalled("report") as never,
  })
  assert.equal(result, "not_needed")
})
