import assert from "node:assert/strict"
import test from "node:test"

import { getAuthenticatedCheckoutSuccessRedirect } from "../src/lib/billing/checkout-success-redirect"

test("onboarded reactivation users return to their verified destination", () => {
  assert.equal(getAuthenticatedCheckoutSuccessRedirect(true, "/profile"), "/profile")
  assert.equal(getAuthenticatedCheckoutSuccessRedirect(true, "/tracker"), "/tracker")
  assert.equal(getAuthenticatedCheckoutSuccessRedirect(true), "/profile?membership=reactivated")
})

test("new and unresolved users continue through onboarding", () => {
  assert.equal(getAuthenticatedCheckoutSuccessRedirect(false), "/onboarding")
  assert.equal(getAuthenticatedCheckoutSuccessRedirect(null), "/onboarding")
  assert.equal(getAuthenticatedCheckoutSuccessRedirect(undefined), "/onboarding")
})
