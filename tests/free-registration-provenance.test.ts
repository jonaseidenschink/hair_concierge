import assert from "node:assert/strict"
import test from "node:test"

import { loadFreeRegistrationBindEvidence } from "../src/lib/auth/free-registration-bind-evidence"
import { linkQuizToProfile } from "../src/lib/quiz/link-to-profile"
import { COMPLETE_V3_PLAN_ENVELOPE } from "./personal-plan/fixtures"

/**
 * PR6 Codex review, findings V3 and V4 — at the two seams the route composes.
 *
 * V3: `/auth/confirm` used to decide "free branch or paid branch" from the URL.
 * Provenance now comes from the LEAD ROW (`leads.free_registration_requested_at`,
 * migration 20260910120000), written only by `/api/auth/free-registration`.
 *
 * V4: the confirm route reads bind evidence and THEN calls `linkQuizToProfile`.
 * A profile created inside that window used to be overwritten unconditionally.
 * The free path now writes create-only, and the DB's `hair_profiles.user_id`
 * UNIQUE constraint is what adjudicates the race.
 */

const USER_ID = "20000000-0000-4000-8000-000000000001"
const LEAD_ID = "20000000-0000-4000-8000-000000000002"

const CANONICAL_PROFILE = {
  structure: "wavy",
  thickness: "fine",
  density: "low",
  hair_length: "medium",
  fingertest: "rau",
  pulltest: "snaps",
  scalp_type: "trocken",
  has_scalp_issue: false,
  treatment: ["gefaerbt"],
  concerns: ["frizz"],
  goals: ["moisture"],
}

// --- V3: the evidence read carries provenance -------------------------------

function evidenceAdmin(rows: {
  lead?: Record<string, unknown> | null
  profile?: Record<string, unknown> | null
  plan?: Record<string, unknown> | null
}) {
  const selected: string[] = []
  const admin = {
    from(table: string) {
      const query = {
        select: (columns: string) => {
          selected.push(`${table}:${columns}`)
          return query
        },
        eq: () => query,
        maybeSingle: async () => {
          if (table === "leads") return { data: rows.lead ?? null, error: null }
          if (table === "hair_profiles") return { data: rows.profile ?? null, error: null }
          return { data: rows.plan ?? null, error: null }
        },
      }
      return query
    },
  }
  return { admin: admin as never, selected }
}

test("V3: bind evidence reads the lead's free-registration provenance", async () => {
  const marked = evidenceAdmin({
    lead: { user_id: null, free_registration_requested_at: "2026-09-10T10:00:00.000Z" },
  })
  assert.deepEqual(
    await loadFreeRegistrationBindEvidence({
      userId: USER_ID,
      leadId: LEAD_ID,
      admin: marked.admin,
    }),
    { leadOwnedByAccount: false, hasEstablishedProfile: false, leadIsFreeRegistration: true },
  )
  assert.equal(
    marked.selected[0],
    "leads:user_id, free_registration_requested_at",
    "the provenance column has to be selected, not inferred",
  )

  // A paid-funnel lead was never marked — the free branch must not run for it.
  const unmarked = evidenceAdmin({ lead: { user_id: null, free_registration_requested_at: null } })
  const evidence = await loadFreeRegistrationBindEvidence({
    userId: USER_ID,
    leadId: LEAD_ID,
    admin: unmarked.admin,
  })
  assert.equal(evidence.leadIsFreeRegistration, false)

  // A missing lead row is not free provenance either.
  const missing = evidenceAdmin({ lead: null })
  assert.equal(
    (
      await loadFreeRegistrationBindEvidence({
        userId: USER_ID,
        leadId: LEAD_ID,
        admin: missing.admin,
      })
    ).leadIsFreeRegistration,
    false,
  )
})

// --- V4: the profile write is create-only for a free bind -------------------

type ProfileRow = Record<string, unknown> | null

function linkAdmin(input: {
  profile: ProfileRow
  /** Simulates a profile created between the read and the insert. */
  insertConflicts?: boolean
}) {
  const writes: { table: string; op: "update" | "insert"; values: Record<string, unknown> }[] = []
  const admin = {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        update(values: Record<string, unknown>) {
          writes.push({ table, op: "update", values })
          return chain
        },
        async insert(values: Record<string, unknown>) {
          writes.push({ table, op: "insert", values })
          if (table === "hair_profiles" && input.insertConflicts) {
            return { error: { code: "23505", message: "duplicate key value" } }
          }
          return { error: null }
        },
        async single() {
          if (table === "leads") {
            return {
              data: {
                id: LEAD_ID,
                email: "lena@example.com",
                quiz_kind: "personal_plan",
                quiz_answers: COMPLETE_V3_PLAN_ENVELOPE,
                user_id: null,
              },
              error: null,
            }
          }
          return input.profile
            ? { data: input.profile, error: null }
            : { data: null, error: { code: "PGRST116", message: "no rows" } }
        },
        then: (resolve: (result: { error: unknown }) => void) => resolve({ error: null }),
      }
      return chain
    },
    async rpc() {
      return { data: [{ canonical_profile: CANONICAL_PROFILE }], error: null }
    },
  }
  return { admin: admin as never, writes }
}

test("V4: a free bind never overwrites a profile that already exists", async () => {
  const guarded = linkAdmin({ profile: { id: "profile-1", goals: ["shine"] } })
  await linkQuizToProfile(USER_ID, "lena@example.com", LEAD_ID, {
    admin: guarded.admin,
    profileWrite: "create_only",
  })
  assert.deepEqual(
    guarded.writes.filter((write) => write.table === "hair_profiles"),
    [],
    "create_only must not write to an existing hair_profiles row at all",
  )
  assert.deepEqual(
    guarded.writes.filter((write) => write.table === "leads"),
    [],
    "and it must not claim the lead on the back of a write it did not make",
  )

  // Legacy/paid linking is untouched: it still updates the existing row.
  const legacy = linkAdmin({ profile: { id: "profile-1", goals: ["shine"] } })
  await linkQuizToProfile(USER_ID, "lena@example.com", LEAD_ID, { admin: legacy.admin })
  const legacyProfileWrites = legacy.writes.filter((write) => write.table === "hair_profiles")
  assert.equal(legacyProfileWrites.length, 1)
  assert.equal(legacyProfileWrites[0].op, "update")
  assert.equal(legacyProfileWrites[0].values.hair_texture, "wavy")
})

test("V4 RACE: a profile created between the evidence read and the insert wins", async () => {
  // The TOCTOU window itself: the read says "no profile", a concurrent paid
  // activation creates one, and this insert loses on `hair_profiles.user_id`.
  const raced = linkAdmin({ profile: null, insertConflicts: true })
  await linkQuizToProfile(USER_ID, "lena@example.com", LEAD_ID, {
    admin: raced.admin,
    profileWrite: "create_only",
  })

  const profileWrites = raced.writes.filter((write) => write.table === "hair_profiles")
  assert.equal(profileWrites.length, 1, "exactly one attempt")
  assert.equal(profileWrites[0].op, "insert", "and it must never fall back to an update")
  assert.deepEqual(
    raced.writes.filter((write) => write.table === "leads"),
    [],
    "the loser of the race claims nothing",
  )

  // Without a concurrent writer the same call creates the profile and links the
  // lead, exactly as the free journey needs.
  const clean = linkAdmin({ profile: null })
  await linkQuizToProfile(USER_ID, "lena@example.com", LEAD_ID, {
    admin: clean.admin,
    profileWrite: "create_only",
  })
  assert.equal(clean.writes.filter((write) => write.op === "insert").length, 1)
  assert.equal(clean.writes.filter((write) => write.table === "leads").length, 1)

  // A unique violation on the PAID path is still a genuine failure, not a
  // silent stand-down.
  const paidRace = linkAdmin({ profile: null, insertConflicts: true })
  await assert.rejects(
    linkQuizToProfile(USER_ID, "lena@example.com", LEAD_ID, { admin: paidRace.admin }),
    /hair_profiles insert failed/,
  )
})
