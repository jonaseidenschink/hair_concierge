import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  isAuthenticatedAppRoutePath,
  requiresSubscriptionPath,
} from "../src/lib/supabase/middleware"

function read(path: string) {
  return readFileSync(path, "utf8")
}

test("header exposes Routine navigation on desktop and mobile", () => {
  const source = read("src/components/layout/header.tsx")

  assert.equal((source.match(/href="\/routine"/g) ?? []).length, 2)
  assert.equal((source.match(/>\s*Routine\s*</g) ?? []).length, 2)
})

test("middleware app-route helper matches chat, routine, and tracker paths by route segment", () => {
  assert.equal(isAuthenticatedAppRoutePath("/chat"), true)
  assert.equal(isAuthenticatedAppRoutePath("/chat/history"), true)
  assert.equal(isAuthenticatedAppRoutePath("/routine"), true)
  assert.equal(isAuthenticatedAppRoutePath("/routine/current"), true)
  assert.equal(isAuthenticatedAppRoutePath("/tracker"), true)
  assert.equal(isAuthenticatedAppRoutePath("/tracker/history"), true)

  assert.equal(isAuthenticatedAppRoutePath("/routine-ish"), false)
  assert.equal(isAuthenticatedAppRoutePath("/tracker-ish"), false)
  assert.equal(isAuthenticatedAppRoutePath("/api/chat"), false)
  assert.equal(isAuthenticatedAppRoutePath("/api/routine"), false)
})

test("middleware subscription helper matches chat, profile, routine, tracker, memory, and their API paths", () => {
  assert.equal(requiresSubscriptionPath("/chat"), true)
  assert.equal(requiresSubscriptionPath("/api/chat"), true)
  assert.equal(requiresSubscriptionPath("/api/chat/messages"), true)
  assert.equal(requiresSubscriptionPath("/routine"), true)
  assert.equal(requiresSubscriptionPath("/routine/current"), true)
  assert.equal(requiresSubscriptionPath("/api/routine"), true)
  assert.equal(requiresSubscriptionPath("/api/routine/current"), true)
  assert.equal(requiresSubscriptionPath("/tracker"), true)
  assert.equal(requiresSubscriptionPath("/tracker/history"), true)
  assert.equal(requiresSubscriptionPath("/api/tracker"), true)
  assert.equal(requiresSubscriptionPath("/api/tracker/log"), true)
  assert.equal(requiresSubscriptionPath("/profile"), true)
  assert.equal(requiresSubscriptionPath("/profile/edit/goals"), true)
  assert.equal(requiresSubscriptionPath("/api/profile"), true)
  assert.equal(requiresSubscriptionPath("/api/profile/update"), true)
  assert.equal(requiresSubscriptionPath("/api/memory"), true)
  assert.equal(requiresSubscriptionPath("/api/memory/entries"), true)

  assert.equal(requiresSubscriptionPath("/routine-ish"), false)
  assert.equal(requiresSubscriptionPath("/api/routine-ish"), false)
  assert.equal(requiresSubscriptionPath("/tracker-ish"), false)
  assert.equal(requiresSubscriptionPath("/api/tracker-ish"), false)
  assert.equal(requiresSubscriptionPath("/profile-ish"), false)
  assert.equal(requiresSubscriptionPath("/api/memory-ish"), false)
})

test("chat conversation selection navigates instead of mutating hidden local selection state", () => {
  const source = read("src/components/chat/chat-container.tsx")

  assert.match(source, /router\.push\(`\/chat\/\$\{conversationId\}`\)/)
  assert.match(source, /router\.push\("\/chat"\)/)
  assert.doesNotMatch(source, /onSelect=\{loadConversation\}/)
})
