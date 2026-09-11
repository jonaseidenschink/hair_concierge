import assert from "node:assert/strict"
import test from "node:test"

import { deriveEntitlements, getEntitlements } from "../src/lib/entitlements"
import type { Entitlements } from "../src/lib/entitlements"

test("premium access grants every can* flag and ignores freeRevealAvailable", () => {
  const result = deriveEntitlements({ hasAppAccess: true, freeRevealUsed: false })

  assert.deepEqual(result, {
    tier: "premium",
    canSeeAlternatives: true,
    canSave: true,
    canChat: true,
    canEditHairCheck: true,
    freeRevealAvailable: false,
  } satisfies Entitlements)
})

test("premium access with freeRevealUsed true still reports freeRevealAvailable false", () => {
  const result = deriveEntitlements({ hasAppAccess: true, freeRevealUsed: true })

  assert.deepEqual(result, {
    tier: "premium",
    canSeeAlternatives: true,
    canSave: true,
    canChat: true,
    canEditHairCheck: true,
    freeRevealAvailable: false,
  } satisfies Entitlements)
})

test("free tier with reveal available: all can* flags false, freeRevealAvailable true", () => {
  const result = deriveEntitlements({ hasAppAccess: false, freeRevealUsed: false })

  assert.deepEqual(result, {
    tier: "free",
    canSeeAlternatives: false,
    canSave: false,
    canChat: false,
    canEditHairCheck: false,
    freeRevealAvailable: true,
  } satisfies Entitlements)
})

test("free tier with reveal used: all can* flags false, freeRevealAvailable false", () => {
  const result = deriveEntitlements({ hasAppAccess: false, freeRevealUsed: true })

  assert.deepEqual(result, {
    tier: "free",
    canSeeAlternatives: false,
    canSave: false,
    canChat: false,
    canEditHairCheck: false,
    freeRevealAvailable: false,
  } satisfies Entitlements)
})

test("getEntitlements defaults readFreeRevealUsed to false when no reader is injected", async () => {
  const result = await getEntitlements("user-1", {
    hasAppAccess: async () => false,
  })

  assert.deepEqual(result, {
    tier: "free",
    canSeeAlternatives: false,
    canSave: false,
    canChat: false,
    canEditHairCheck: false,
    freeRevealAvailable: true,
  } satisfies Entitlements)
})

test("getEntitlements uses an injected readFreeRevealUsed returning true", async () => {
  const result = await getEntitlements("user-1", {
    hasAppAccess: async () => false,
    readFreeRevealUsed: async () => true,
  })

  assert.deepEqual(result, {
    tier: "free",
    canSeeAlternatives: false,
    canSave: false,
    canChat: false,
    canEditHairCheck: false,
    freeRevealAvailable: false,
  } satisfies Entitlements)
})

test("getEntitlements uses an injected readFreeRevealUsed returning false", async () => {
  const result = await getEntitlements("user-1", {
    hasAppAccess: async () => false,
    readFreeRevealUsed: async () => false,
  })

  assert.deepEqual(result, {
    tier: "free",
    canSeeAlternatives: false,
    canSave: false,
    canChat: false,
    canEditHairCheck: false,
    freeRevealAvailable: true,
  } satisfies Entitlements)
})

test("getEntitlements resolves premium via hasAppAccess without consulting the reveal reader", async () => {
  let readerCalled = false
  const result = await getEntitlements("user-1", {
    hasAppAccess: async () => true,
    readFreeRevealUsed: async () => {
      readerCalled = true
      return true
    },
  })

  assert.deepEqual(result, {
    tier: "premium",
    canSeeAlternatives: true,
    canSave: true,
    canChat: true,
    canEditHairCheck: true,
    freeRevealAvailable: false,
  } satisfies Entitlements)
  assert.equal(readerCalled, false)
})

test("getEntitlements passes the userId through to hasAppAccess", async () => {
  let receivedUserId: string | null = null
  await getEntitlements("user-42", {
    hasAppAccess: async (userId) => {
      receivedUserId = userId
      return false
    },
  })

  assert.equal(receivedUserId, "user-42")
})
