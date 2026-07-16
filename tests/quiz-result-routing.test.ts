import assert from "node:assert/strict"
import test from "node:test"

import { getQuizResultRedirectPath } from "../src/components/quiz/quiz-results"

test("no-access quiz results redirect to the canonical result route", () => {
  assert.equal(
    getQuizResultRedirectPath({
      leadId: "lead/with spaces",
      authLoading: false,
      isCheckingSignedInSubscription: false,
      canGoStraightToRoutine: false,
    }),
    "/result/lead%2Fwith%20spaces?entry=quiz_completion",
  )
})

test("result redirect waits for a lead and completed access checks", () => {
  assert.equal(
    getQuizResultRedirectPath({
      leadId: null,
      authLoading: false,
      isCheckingSignedInSubscription: false,
      canGoStraightToRoutine: false,
    }),
    null,
  )
  assert.equal(
    getQuizResultRedirectPath({
      leadId: "lead-1",
      authLoading: true,
      isCheckingSignedInSubscription: false,
      canGoStraightToRoutine: false,
    }),
    null,
  )
  assert.equal(
    getQuizResultRedirectPath({
      leadId: "lead-1",
      authLoading: false,
      isCheckingSignedInSubscription: true,
      canGoStraightToRoutine: false,
    }),
    null,
  )
})

test("active subscribers keep the direct routine path", () => {
  assert.equal(
    getQuizResultRedirectPath({
      leadId: "lead-1",
      authLoading: false,
      isCheckingSignedInSubscription: false,
      canGoStraightToRoutine: true,
    }),
    null,
  )
})
