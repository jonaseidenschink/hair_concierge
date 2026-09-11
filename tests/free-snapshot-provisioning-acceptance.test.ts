import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { createFreeSnapshotService } from "../src/lib/personal-plan/persistence/free-snapshot-service"
import { createFreeSnapshotSupabaseDependencies } from "../src/lib/personal-plan/persistence/free-snapshot-supabase"
import { loadScanEvaluationContext } from "../src/lib/scan/profile-context"
import { COMPLETE_V3_PLAN_ENVELOPE } from "./personal-plan/fixtures"

/**
 * Acceptance test for T6 (free-snapshot provisioning): a signed-in user with NO
 * Personal Plan enrollment — only a linked quiz artifact — must be provisionable
 * by `free-snapshot-service`, and the resulting row must satisfy exactly the
 * read `src/lib/scan/profile-context.ts` performs (the scan resolve route 409s
 * `profile_missing` when that read comes back null).
 *
 * The fake below re-implements just enough of the
 * `personal_plan_create_or_reuse_initial_need` RPC's real idempotency semantics
 * (dedupe an `initial` row by `(personal_plan_id, input_hash)`; reject a
 * mismatched enrollment id on an existing plan) to prove the service integrates
 * correctly end-to-end without touching a real database.
 */

type Row = Record<string, unknown>

function createFakeDatabase() {
  const preparedArtifacts: Row[] = []
  const personalPlans = new Map<string, Row>()
  const needVersions = new Map<string, Row>()
  const manualAccessGrants: Row[] = []
  const moderatorMembers: Row[] = []
  const moderatorEnrollments: Row[] = []
  let moderatorMembersError: unknown = null

  function seedAttachedArtifact(userId: string, quizAnswers: unknown) {
    preparedArtifacts.push({
      id: randomUUID(),
      user_id: userId,
      status: "attached",
      quiz_answers: quizAnswers,
      attached_at: new Date().toISOString(),
    })
  }

  // Exercised by the guard's full `resolvePaidAppAccess` composite
  // (`hasCurrentAppAccess` -> `findCurrentManualAccessGrant`): an email-bound
  // grant has no `user_id` row to match, only the email lookup finds it.
  function seedEmailOnlyManualAccessGrant(email: string) {
    manualAccessGrants.push({
      id: randomUUID(),
      user_id: null,
      email,
      expires_at: null,
      revoked_at: null,
    })
  }

  // Exercised by the guard's `resolveModeratorAccess` branch: an
  // "activated" roster member with an "active" linked enrollment resolves
  // moderator access as active (see personal-plan-moderator-contract.test.ts
  // for the same fixture shape).
  function seedActiveModerator(userId: string) {
    const enrollmentId = randomUUID()
    const grantId = randomUUID()
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
    moderatorMembers.push({
      id: randomUUID(),
      campaign_id: randomUUID(),
      user_id: userId,
      normalized_email: "moderator@example.com",
      status: "activated",
      reset_receipt_ref: "reset-1",
      enrollment_id: enrollmentId,
      revoked_at: null,
    })
    moderatorEnrollments.push({
      id: enrollmentId,
      campaign_id: moderatorMembers[moderatorMembers.length - 1].campaign_id,
      user_id: userId,
      status: "active",
      activated_at: new Date().toISOString(),
      expires_at: expiresAt,
      revoked_at: null,
      manual_access_grant_id: grantId,
      manual_access_grants: {
        id: grantId,
        user_id: userId,
        reason: "tester",
        expires_at: expiresAt,
        revoked_at: null,
      },
    })
  }

  // Simulates an unreadable moderator roster (distinct from the "missing
  // table" pre-migration case, which `resolveModeratorAccess` treats as
  // "none") — the guard must fail closed, not treat this as "not paid".
  function makeModeratorLookupUnavailable() {
    moderatorMembersError = new Error("simulated moderator roster read failure")
  }

  function rpcCreateOrReuseInitialNeed(args: Row) {
    const userId = args.p_user_id as string
    const enrollmentId = (args.p_enrollment_purchase_source_id ?? null) as string | null

    let plan = personalPlans.get(userId)
    if (!plan) {
      plan = {
        id: randomUUID(),
        user_id: userId,
        enrollment_purchase_source_id: enrollmentId,
        current_initial_need_version_id: null,
        current_refined_need_version_id: null,
      }
      personalPlans.set(userId, plan)
    }
    if (plan.enrollment_purchase_source_id !== enrollmentId) {
      return { data: { outcome: "invalid_source", reasonCode: "enrollment_mismatch" }, error: null }
    }

    const inputHash = args.p_input_hash as string
    let need = [...needVersions.values()].find(
      (row) =>
        row.personal_plan_id === plan!.id && row.kind === "initial" && row.input_hash === inputHash,
    )
    if (!need) {
      need = {
        id: randomUUID(),
        user_id: userId,
        personal_plan_id: plan.id,
        kind: "initial",
        input_hash: inputHash,
        output_snapshot: args.p_output_snapshot,
      }
      needVersions.set(need.id as string, need)
    }
    plan.current_initial_need_version_id = need.id

    return {
      data: {
        outcome: "completed",
        personalPlanId: plan.id,
        needVersionId: need.id,
        outputSnapshot: need.output_snapshot,
      },
      error: null,
    }
  }

  const admin = {
    from(table: string) {
      const filters = new Map<string, unknown>()
      const matches = (row: Row) =>
        [...filters.entries()].every(([key, value]) => row[key] === value)
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters.set(column, value)
          return chain
        },
        order: () => chain,
        limit: () => chain,
        // Real Postgrest query builders are directly awaitable (no
        // `.maybeSingle()` needed for a plain array-returning select) — this
        // makes the fake chain thenable so `manual_access_grants` reads
        // (`findCurrentManualAccessGrant`, which never calls `.maybeSingle()`)
        // resolve real seeded rows instead of the "await a plain object"
        // no-op every other never-seeded table already relied on.
        then: (resolve: (result: { data: unknown; error: unknown }) => void) => {
          if (table === "manual_access_grants") {
            resolve({ data: manualAccessGrants.filter(matches), error: null })
            return
          }
          resolve({ data: [], error: null })
        },
        maybeSingle: async () => {
          if (table === "personal_plan_prepared_artifacts") {
            const rows = preparedArtifacts
              .filter(matches)
              .sort((a, b) => String(b.attached_at).localeCompare(String(a.attached_at)))
            return { data: rows[0] ?? null, error: null }
          }
          if (table === "personal_plans") {
            return {
              data: personalPlans.get(filters.get("user_id") as string) ?? null,
              error: null,
            }
          }
          if (table === "personal_plan_need_versions") {
            const row = [...needVersions.values()].find((need) => matches(need))
            return { data: row ?? null, error: null }
          }
          // Exercised by the free-snapshot service's paid-access guard
          // (`hasCurrentPaidAppAccess`'s legacy-profile-subscription check):
          // none of these acceptance-test users have a `profiles` row here.
          if (table === "profiles") {
            return { data: null, error: null }
          }
          // Exercised by the guard's `resolveModeratorAccess` branch
          // (`loadLatestMemberForUser`).
          if (table === "personal_plan_test_members") {
            if (moderatorMembersError) return { data: null, error: moderatorMembersError }
            const row = moderatorMembers.find((member) => matches(member))
            return { data: row ?? null, error: null }
          }
          // Exercised by the guard's `resolveModeratorAccess` branch
          // (`loadEnrollment`).
          if (table === "personal_plan_test_enrollments") {
            const row = moderatorEnrollments.find((enrollment) => matches(enrollment))
            return { data: row ?? null, error: null }
          }
          throw new Error(`unexpected table ${table}`)
        },
      }
      return chain
    },
    async rpc(name: string, args: Row) {
      if (name === "personal_plan_create_or_reuse_initial_need") {
        return rpcCreateOrReuseInitialNeed(args)
      }
      // Exercised by the free-snapshot service's paid-access guard
      // (`hasCurrentPaidAppAccess` -> `resolveOneTimeAccessStateForUser`):
      // none of these acceptance-test users have a one-time purchase, so the
      // real RPC would report "none" — no further table reads needed for it.
      if (name === "get_personal_plan_one_time_access_state") {
        return { data: "none", error: null }
      }
      throw new Error(`unexpected rpc ${name}`)
    },
  }

  return {
    admin,
    seedAttachedArtifact,
    seedEmailOnlyManualAccessGrant,
    seedActiveModerator,
    makeModeratorLookupUnavailable,
    needVersions,
    personalPlans,
  }
}

test("a free account with no enrollment is provisioned and then passes the scanner's profile-context read (no profile_missing)", async () => {
  const { admin, seedAttachedArtifact } = createFakeDatabase()
  const userId = "22222222-2222-4222-8222-222222222222"
  seedAttachedArtifact(userId, COMPLETE_V3_PLAN_ENVELOPE)

  // Before provisioning: this is exactly the read that makes the scan resolve
  // route return 409 profile_missing.
  assert.equal(await loadScanEvaluationContext(admin as never, userId), null)

  const service = createFreeSnapshotService(createFreeSnapshotSupabaseDependencies(admin as never))
  const result = await service.provisionFreeInitialSnapshot({ userId })
  assert.equal(result.outcome, "provisioned")

  const context = await loadScanEvaluationContext(admin as never, userId)
  assert.ok(context, "expected a scan evaluation context — profile_missing must not fire")
  assert.equal(context?.snapshotSource, "initial")
  assert.equal(context?.snapshot.profile.hair.thickness, "fine")
})

test("provisioning twice is idempotent: no duplicate need_versions row, enrollment stays null", async () => {
  const { admin, seedAttachedArtifact, needVersions, personalPlans } = createFakeDatabase()
  const userId = "33333333-3333-4333-8333-333333333333"
  seedAttachedArtifact(userId, COMPLETE_V3_PLAN_ENVELOPE)

  const service = createFreeSnapshotService(createFreeSnapshotSupabaseDependencies(admin as never))
  const first = await service.provisionFreeInitialSnapshot({ userId })
  const second = await service.provisionFreeInitialSnapshot({ userId })

  assert.equal(first.outcome, "provisioned")
  assert.equal(second.outcome, "provisioned")
  if (first.outcome === "provisioned" && second.outcome === "provisioned") {
    assert.equal(first.needVersionId, second.needVersionId)
    assert.equal(first.personalPlanId, second.personalPlanId)
  }
  assert.equal(needVersions.size, 1)
  assert.equal(personalPlans.get(userId)?.enrollment_purchase_source_id, null)
})

test("a user with no linked quiz artifact is not provisioned and the scanner still 409s profile_missing", async () => {
  const { admin } = createFakeDatabase()
  const userId = "44444444-4444-4444-8444-444444444444"

  const service = createFreeSnapshotService(createFreeSnapshotSupabaseDependencies(admin as never))
  const result = await service.provisionFreeInitialSnapshot({ userId })

  assert.deepEqual(result, { outcome: "no_quiz_artifact" })
  assert.equal(await loadScanEvaluationContext(admin as never, userId), null)
})

test("a plan already pinned to a real enrollment id fails the free service permanently with enrollment_mismatch (I1's collision, not self-healing)", async () => {
  const { admin, seedAttachedArtifact, personalPlans } = createFakeDatabase()
  const userId = "55555555-5555-4555-8555-555555555555"
  seedAttachedArtifact(userId, COMPLETE_V3_PLAN_ENVELOPE)

  // Simulate the paid path having already written this plan (e.g. the RPC
  // ran once for this user with a real enrollment id, pinning the column).
  const planId = randomUUID()
  personalPlans.set(userId, {
    id: planId,
    user_id: userId,
    enrollment_purchase_source_id: randomUUID(),
    current_initial_need_version_id: null,
    current_refined_need_version_id: null,
  })

  const service = createFreeSnapshotService(createFreeSnapshotSupabaseDependencies(admin as never))
  const result = await service.provisionFreeInitialSnapshot({ userId })

  assert.deepEqual(result, { outcome: "invalid_source", reasonCode: "enrollment_mismatch" })
})

// --- Review fix round 2: the guard must cover the FULL composite, not just
// independently-verified paid access — a moderator/field-test user gets a
// REAL non-null enrollment_purchase_source_id through the paid path, so
// missing this branch would let the free path pin `null` first and
// permanently collide with theirs. These three prove the real
// `resolvePaidAppAccess` composite (wired through
// `createFreeSnapshotSupabaseDependencies`, not a mock) reaches the
// moderator roster and the email-keyed manual-grant table, and fails closed
// when the moderator lookup can't be read.

test("an active moderator/field-test user is refused with paid_user and not provisioned", async () => {
  const { admin, seedActiveModerator } = createFakeDatabase()
  const userId = "66666666-6666-4666-8666-666666666666"
  // Deliberately no linked quiz artifact seeded: if the guard were bypassed,
  // the service would fall through to "no_quiz_artifact" instead of
  // "paid_user", so this also proves the guard runs before the artifact read.
  seedActiveModerator(userId)

  const service = createFreeSnapshotService(createFreeSnapshotSupabaseDependencies(admin as never))
  const result = await service.provisionFreeInitialSnapshot({ userId })

  assert.deepEqual(result, { outcome: "paid_user" })
  assert.equal(await loadScanEvaluationContext(admin as never, userId), null)
})

test("a user with only an email-keyed manual access grant (no user_id row) is refused with paid_user", async () => {
  const { admin, seedEmailOnlyManualAccessGrant } = createFakeDatabase()
  const userId = "77777777-7777-4777-8777-777777777777"
  const email = "friend@example.com"
  seedEmailOnlyManualAccessGrant(email)

  const service = createFreeSnapshotService(createFreeSnapshotSupabaseDependencies(admin as never))
  const result = await service.provisionFreeInitialSnapshot({ userId, email })

  assert.deepEqual(result, { outcome: "paid_user" })
  assert.equal(await loadScanEvaluationContext(admin as never, userId), null)

  // Reproduces the guard's own version of the C1 regression: without the
  // email, the manual grant is invisible and the guard would let this
  // moderator/tester holder fall through as a plain free user.
  const withoutEmail = await service.provisionFreeInitialSnapshot({ userId })
  assert.notDeepEqual(withoutEmail, { outcome: "paid_user" })
})

test("an unreadable moderator lookup with no independent paid entitlement fails closed with temporarily_unavailable, not provisioning", async () => {
  const { admin, seedAttachedArtifact, makeModeratorLookupUnavailable } = createFakeDatabase()
  const userId = "88888888-8888-4888-8888-888888888888"
  seedAttachedArtifact(userId, COMPLETE_V3_PLAN_ENVELOPE)
  makeModeratorLookupUnavailable()

  const service = createFreeSnapshotService(createFreeSnapshotSupabaseDependencies(admin as never))
  const result = await service.provisionFreeInitialSnapshot({ userId })

  assert.deepEqual(result, { outcome: "temporarily_unavailable" })
  assert.equal(await loadScanEvaluationContext(admin as never, userId), null)
})
