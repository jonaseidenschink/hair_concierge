import assert from "node:assert/strict"
import test from "node:test"

import {
  isFreemiumAdmittedRoutePath,
  requiresSubscriptionPath,
  shouldRedirectToReactivation,
} from "../src/lib/supabase/middleware"

// --- isFreemiumAdmittedRoutePath --------------------------------------------

test("isFreemiumAdmittedRoutePath admits the app-shell page prefixes and /api/scan", () => {
  for (const pathname of [
    "/anwendung",
    "/anwendung/wash_day",
    "/chat",
    "/chat/verlauf",
    "/routine",
    "/routine/current",
    "/scan",
    "/scan/ergebnis",
    "/api/scan",
    "/api/scan/analyze",
    "/profile",
    "/profile/edit",
    "/tracker",
    "/tracker/entries",
  ]) {
    assert.equal(isFreemiumAdmittedRoutePath(pathname), true, pathname)
  }
})

test("isFreemiumAdmittedRoutePath does NOT admit any other /api/* prefix", () => {
  for (const pathname of [
    "/api/chat",
    "/api/profile",
    "/api/personal-plan",
    "/api/personal-plan/anything",
    "/api/routine",
    "/api/tracker",
    "/api/memory",
    "/api/product-intake",
  ]) {
    assert.equal(isFreemiumAdmittedRoutePath(pathname), false, pathname)
  }
})

test("isFreemiumAdmittedRoutePath does not admit onboarding, plan-start or unrelated routes", () => {
  assert.equal(isFreemiumAdmittedRoutePath("/onboarding"), false)
  assert.equal(isFreemiumAdmittedRoutePath("/plan-start"), false)
  assert.equal(isFreemiumAdmittedRoutePath("/auth"), false)
  assert.equal(isFreemiumAdmittedRoutePath("/quiz"), false)
  assert.equal(isFreemiumAdmittedRoutePath("/reactivate"), false)
  assert.equal(isFreemiumAdmittedRoutePath("/admin"), false)
})

test("every admitted page prefix is itself still SUB_REQUIRED (admission is a carve-out, not a removal)", () => {
  for (const pathname of [
    "/anwendung",
    "/chat",
    "/routine",
    "/scan",
    "/api/scan",
    "/profile",
    "/tracker",
  ]) {
    assert.equal(requiresSubscriptionPath(pathname), true, pathname)
  }
})

// --- shouldRedirectToReactivation -------------------------------------------

test("flag off: always redirects to reactivation, admitted or not", () => {
  assert.equal(
    shouldRedirectToReactivation({ pathname: "/scan", freemiumScannerFirstEnabled: false }),
    true,
  )
  assert.equal(
    shouldRedirectToReactivation({ pathname: "/api/scan", freemiumScannerFirstEnabled: false }),
    true,
  )
  assert.equal(
    shouldRedirectToReactivation({ pathname: "/chat", freemiumScannerFirstEnabled: false }),
    true,
  )
})

test("flag on: admitted routes are exempted from the reactivation redirect", () => {
  for (const pathname of [
    "/anwendung",
    "/chat",
    "/routine",
    "/scan",
    "/api/scan",
    "/profile",
    "/tracker",
  ]) {
    assert.equal(
      shouldRedirectToReactivation({ pathname, freemiumScannerFirstEnabled: true }),
      false,
      pathname,
    )
  }
})

test("flag on: non-admitted routes still redirect to reactivation", () => {
  for (const pathname of [
    "/onboarding",
    "/plan-start",
    "/api/chat",
    "/api/profile",
    "/api/personal-plan",
    "/api/routine",
    "/api/tracker",
    "/api/memory",
    "/api/product-intake",
  ]) {
    assert.equal(
      shouldRedirectToReactivation({ pathname, freemiumScannerFirstEnabled: true }),
      true,
      pathname,
    )
  }
})
