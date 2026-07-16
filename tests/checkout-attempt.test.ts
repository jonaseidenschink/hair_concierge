import assert from "node:assert/strict"
import test from "node:test"

import { createCheckoutAttemptController } from "../src/lib/analytics/checkout-attempt"

test("checkout attempt identity stays correlated until close and partitions failure dedupe", () => {
  const generatedIds = ["checkout-attempt-1", "checkout-attempt-2"]
  const controller = createCheckoutAttemptController(() => {
    const nextId = generatedIds.shift()
    assert.ok(nextId)
    return nextId
  })

  const firstOpen = controller.open()
  assert.deepEqual(firstOpen, {
    checkoutAttemptId: "checkout-attempt-1",
    isNew: true,
  })
  assert.deepEqual(controller.open(), {
    checkoutAttemptId: "checkout-attempt-1",
    isNew: false,
  })
  assert.equal(controller.retry(), "checkout-attempt-1")

  assert.equal(
    controller.claimFailure(
      firstOpen.checkoutAttemptId,
      "paypal",
      "provider_session",
      "paypal_js_load_failed",
    ),
    true,
  )
  assert.equal(
    controller.claimFailure(
      firstOpen.checkoutAttemptId,
      "paypal",
      "provider_session",
      "paypal_js_load_failed",
    ),
    false,
  )

  assert.equal(controller.close(), "checkout-attempt-1")
  assert.equal(controller.retry(), null)

  const secondOpen = controller.open()
  assert.deepEqual(secondOpen, {
    checkoutAttemptId: "checkout-attempt-2",
    isNew: true,
  })
  assert.equal(
    controller.claimFailure(
      secondOpen.checkoutAttemptId,
      "paypal",
      "provider_session",
      "paypal_js_load_failed",
    ),
    true,
  )
})
