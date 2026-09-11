import assert from "node:assert/strict"
import test from "node:test"

import { FREE_REGISTRATION_HANDOFF_STORAGE_KEY } from "../src/lib/auth/free-registration"
import { readHandoff, writeHandoffEmail } from "../src/app/registrierung/free-registration-client"

/**
 * T18 fix round 2, review finding N2: `writeHandoffEmail` used to rewrite the
 * sessionStorage handoff with `capability: options.capability ?? null` on
 * EVERY successful send, including a plain resend (which never carries a
 * capability). A genuine user who resent, then reloaded within the
 * capability's 60-minute TTL, dead-ended on `correction_blocked` even though
 * their capability was still valid — the resend silently burned it.
 *
 * The fix: `capability === undefined` (a plain resend, or the auto-send on
 * mount) means "preserve whatever is already stored"; only an explicit
 * correction (which always passes its own capability, `string` or `null`)
 * updates/consumes the stored value. These tests exercise `writeHandoffEmail`
 * / `readHandoff` directly against an in-memory `sessionStorage`, the same
 * split-for-testability approach `FreeRegistrationScreen` used in fix round 1
 * (W6) for the phase machine this sits behind (`requestAnimationFrame` +
 * `fetch`, neither reachable from a plain unit test).
 */

const LEAD_ID = "11111111-1111-4111-8111-111111111111"

function createMemorySessionStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  }
}

function installWindow() {
  const storage = createMemorySessionStorage()
  ;(globalThis as unknown as { window: unknown }).window = { sessionStorage: storage }
  return storage
}

test("a plain resend (capability=undefined) preserves the existing stored capability", () => {
  const storage = installWindow()
  storage.setItem(
    FREE_REGISTRATION_HANDOFF_STORAGE_KEY,
    JSON.stringify({ leadId: LEAD_ID, email: "lena@example.com", capability: "cap-token" }),
  )

  // A plain resend calls `writeHandoffEmail` without a `capability` argument
  // — this is what `send(leadId, { notice: ... })` in the client does.
  writeHandoffEmail(LEAD_ID, "lena@example.com", undefined)

  const handoff = readHandoff()
  assert.equal(handoff?.leadId, LEAD_ID)
  assert.equal(handoff?.capability, "cap-token", "resend must not drop the stored capability")
})

test("the auto-send on mount (capability=undefined, no prior handoff) writes no capability", () => {
  installWindow()
  // Nothing stored yet — the very first send has nothing to preserve.
  writeHandoffEmail(LEAD_ID, "lena@example.com", undefined)
  const handoff = readHandoff()
  assert.equal(handoff?.email, "lena@example.com")
  assert.equal(handoff?.capability, undefined)
})

test("an explicit correction (capability passed as a string) replaces the stored capability", () => {
  const storage = installWindow()
  storage.setItem(
    FREE_REGISTRATION_HANDOFF_STORAGE_KEY,
    JSON.stringify({ leadId: LEAD_ID, email: "lena@example.com", capability: "old-cap" }),
  )

  writeHandoffEmail(LEAD_ID, "neu@example.com", "new-cap")

  const handoff = readHandoff()
  assert.equal(handoff?.email, "neu@example.com")
  assert.equal(handoff?.capability, "new-cap")
})

test("an explicit correction with no capability (capability=null) clears the stored capability", () => {
  const storage = installWindow()
  storage.setItem(
    FREE_REGISTRATION_HANDOFF_STORAGE_KEY,
    JSON.stringify({ leadId: LEAD_ID, email: "lena@example.com", capability: "old-cap" }),
  )

  writeHandoffEmail(LEAD_ID, "neu@example.com", null)

  const handoff = readHandoff()
  assert.equal(handoff?.email, "neu@example.com")
  assert.equal(handoff?.capability, undefined)
})

test("preserving on resend never leaks a DIFFERENT lead's stored capability", () => {
  const storage = installWindow()
  const otherLeadId = "22222222-2222-4222-8222-222222222222"
  storage.setItem(
    FREE_REGISTRATION_HANDOFF_STORAGE_KEY,
    JSON.stringify({ leadId: otherLeadId, email: "other@example.com", capability: "other-cap" }),
  )

  writeHandoffEmail(LEAD_ID, "lena@example.com", undefined)

  const handoff = readHandoff()
  assert.equal(handoff?.leadId, LEAD_ID)
  assert.equal(handoff?.capability, undefined, "a foreign lead's capability must never carry over")
})
