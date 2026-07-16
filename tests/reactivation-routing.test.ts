import assert from "node:assert/strict"
import test from "node:test"

import { getUnauthenticatedRedirectTarget } from "../src/lib/auth/unauthenticated-redirect"
import { classifyRoute } from "../src/lib/auth/route-classification"
import { requiresSubscriptionPath } from "../src/lib/supabase/middleware"

const production = { nodeEnv: "production", localDevLoginEnabled: false }

test("reactivation requires authentication but deliberately not a subscription", () => {
  assert.equal(classifyRoute("/reactivate", production), "protected")
  assert.equal(requiresSubscriptionPath("/reactivate"), false)
  assert.equal(
    getUnauthenticatedRedirectTarget("/reactivate", "?next=%2Froutine", false),
    "/auth?next=%2Freactivate%3Fnext%3D%252Froutine",
  )
})

test("all membership surfaces remain subscription gated", () => {
  for (const path of [
    "/chat",
    "/routine",
    "/tracker",
    "/profile",
    "/onboarding",
    "/api/chat",
    "/api/routine",
    "/api/tracker",
    "/api/profile",
    "/api/memory",
  ]) {
    assert.equal(requiresSubscriptionPath(path), true, path)
  }
})
