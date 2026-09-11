import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { createFreeRegistrationPostHandler } from "../src/app/api/auth/free-registration/route"
import { createAuthConfirmGetHandler } from "../src/app/auth/confirm/route"
import { createFreeSnapshotService } from "../src/lib/personal-plan/persistence/free-snapshot-service"
import { createFreeSnapshotSupabaseDependencies } from "../src/lib/personal-plan/persistence/free-snapshot-supabase"
import { loadScanEvaluationContext } from "../src/lib/scan/profile-context"
import {
  buildProfileDataFromPersonalPlanCanonicalProfile,
  canLinkDirectQuizLead,
  type LinkQuizToProfileOptions,
} from "../src/lib/quiz/link-to-profile"
import { getAuthenticatedAppRedirect } from "../src/lib/auth/intake-state"
import {
  issueFreeRegistrationCapability,
  verifyFreeRegistrationCapability,
} from "../src/lib/auth/free-registration-capability"
import { loadFreeRegistrationBindEvidence } from "../src/lib/auth/free-registration-bind-evidence"
import { recoverMissingFreeSnapshot } from "../src/lib/auth/free-registration-recovery"
import type { ProvisionFreeInitialSnapshotResult } from "../src/lib/personal-plan/persistence/free-snapshot-service"
import { buildCustomerIoEmails } from "../supabase/functions/send-email/message-builder"
import { COMPLETE_V3_PLAN_ENVELOPE } from "./personal-plan/fixtures"

/**
 * T18 named journey test: quiz -> e-mail -> magic link -> /auth/confirm ->
 * /scan, with the prepared plan artifact intact (the scanner resolves without
 * `profile_missing`, and the Profil surface's `hair_profiles` row carries
 * quiz-derived content), plus the resend / correction / expired-link recovery
 * states.
 *
 * The real routes are driven end to end. Two seams are faked, both at the
 * transport boundary:
 *  - Supabase auth (`signInWithOtp` + `verifyOtp`): the "e-mail transport" the
 *    brief allows to be mocked. The fake creates the account on send, exactly
 *    like `shouldCreateUser: true`.
 *  - The database: an in-memory fake reused from the T6 acceptance test's
 *    shape, including the real idempotency rules of
 *    `personal_plan_create_or_reuse_initial_need`.
 * `linkQuizToProfile`'s own body constructs its admin client internally, so the
 * confirm route is handed a double that performs the SAME steps through the
 * fake: the real `canLinkDirectQuizLead` binding rule, the real
 * `link_personal_plan_artifact_to_user` RPC contract, and the real
 * `buildProfileDataFromPersonalPlanCanonicalProfile` projection.
 */

const ORIGIN = "https://app.test"
const CAPABILITY_SECRET = "journey-test-signing-secret-long-enough"

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

type Row = Record<string, unknown>

function createJourneyDatabase() {
  const leads: Row[] = []
  const preparedArtifacts: Row[] = []
  const hairProfiles: Row[] = []
  const personalPlans = new Map<string, Row>()
  const needVersions = new Map<string, Row>()

  function seedQuizCompletion(email: string) {
    const leadId = randomUUID()
    leads.push({ id: leadId, email, quiz_kind: "personal_plan", user_id: null, status: "new" })
    preparedArtifacts.push({
      id: randomUUID(),
      lead_id: leadId,
      user_id: null,
      status: "attached_to_lead",
      quiz_answers: COMPLETE_V3_PLAN_ENVELOPE,
      canonical_profile: CANONICAL_PROFILE,
      attached_at: new Date().toISOString(),
    })
    return leadId
  }

  function linkArtifactToUser(leadId: string, userId: string) {
    const artifact = preparedArtifacts.find((row) => row.lead_id === leadId)
    if (!artifact) return { data: null, error: new Error("no artifact for lead") }
    artifact.user_id = userId
    artifact.status = "attached"
    artifact.attached_at = new Date().toISOString()
    return { data: [{ canonical_profile: artifact.canonical_profile }], error: null }
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
      const filters: { op: "eq" | "is"; column: string; value: unknown }[] = []
      let mode: "select" | "update" = "select"
      let payload: Row = {}
      const matches = (row: Row) =>
        filters.every(({ op, column, value }) =>
          op === "is" ? (row[column] ?? null) === value : row[column] === value,
        )
      const table_rows = () => {
        if (table === "leads") return leads
        if (table === "personal_plan_prepared_artifacts") return preparedArtifacts
        if (table === "hair_profiles") return hairProfiles
        return []
      }
      const run = () => {
        if (mode === "update") {
          for (const row of table_rows().filter(matches)) Object.assign(row, payload)
          return { data: null, error: null }
        }
        return { data: table_rows().filter(matches), error: null }
      }
      const chain = {
        select: () => chain,
        update: (values: Row) => {
          mode = "update"
          payload = values
          return chain
        },
        eq: (column: string, value: unknown) => {
          filters.push({ op: "eq", column, value })
          return chain
        },
        is: (column: string, value: unknown) => {
          filters.push({ op: "is", column, value })
          return chain
        },
        order: () => chain,
        limit: () => chain,
        then: (resolve: (result: { data: unknown; error: unknown }) => void) => resolve(run()),
        maybeSingle: async () => {
          if (table === "personal_plans") {
            return { data: personalPlans.get(filters[0]?.value as string) ?? null, error: null }
          }
          if (table === "personal_plan_need_versions") {
            return { data: [...needVersions.values()].find(matches) ?? null, error: null }
          }
          // Never seeded in this journey: the free-snapshot paid-access guard's
          // legacy-profile check and moderator roster reads resolve to "none".
          if (
            table === "profiles" ||
            table === "personal_plan_test_members" ||
            table === "personal_plan_test_enrollments"
          ) {
            return { data: null, error: null }
          }
          return { data: table_rows().filter(matches)[0] ?? null, error: null }
        },
      }
      return chain
    },
    async rpc(name: string, args: Row) {
      if (name === "personal_plan_create_or_reuse_initial_need") {
        return rpcCreateOrReuseInitialNeed(args)
      }
      if (name === "link_personal_plan_artifact_to_user") {
        return linkArtifactToUser(args.p_lead_id as string, args.p_user_id as string)
      }
      if (name === "get_personal_plan_one_time_access_state") return { data: "none", error: null }
      throw new Error(`unexpected rpc ${name}`)
    },
  }

  return { admin, leads, hairProfiles, preparedArtifacts, needVersions, seedQuizCompletion }
}

type SentLink = { email: string; emailRedirectTo: string; tokenHash: string }

/**
 * The URL the recipient ACTUALLY clicks (PR6 review, finding V2).
 *
 * `emailRedirectTo` is not it: Supabase hands that string to the send-email hook
 * as `email_data.redirect_to`, and the REAL builder
 * (`supabase/functions/send-email/message-builder.ts`) wraps it inside a fresh
 * `/auth/confirm` URL carrying the token — nested under `next` for a `signup`
 * action, under `redirect_to` for a `magiclink` action. The earlier journey test
 * appended the token to `emailRedirectTo` directly and so never exercised that
 * nesting; both delivered shapes lost the free context in production.
 *
 * `shouldCreateUser: true` produces a `signup` mail for a brand-new address and
 * a `magiclink` mail for an address that already has an account, so both matter.
 */
function realEmailConfirmUrl(link: SentLink, actionType: "signup" | "magiclink"): URL {
  const [email] = buildCustomerIoEmails(
    {
      user: { id: "auth-user", email: link.email },
      email_data: {
        email_action_type: actionType,
        token: "123456",
        token_hash: link.tokenHash,
        redirect_to: link.emailRedirectTo,
        site_url: ORIGIN,
      },
    },
    { siteUrl: ORIGIN },
  )
  return new URL(email.message_data.confirmation_url)
}

function createAuthTransport() {
  const sent: SentLink[] = []
  const usersByEmail = new Map<string, { id: string; email: string }>()
  const tokens = new Map<string, string>()

  return {
    sent,
    /** `shouldCreateUser: true`: the account exists from the send onwards. */
    async sendMagicLink(input: { email: string; emailRedirectTo: string }) {
      const user = usersByEmail.get(input.email) ?? { id: randomUUID(), email: input.email }
      usersByEmail.set(input.email, user)
      const tokenHash = randomUUID().replace(/-/g, "")
      tokens.set(tokenHash, input.email)
      sent.push({ ...input, tokenHash })
      return { error: null }
    },
    consume(tokenHash: string) {
      const email = tokens.get(tokenHash)
      if (!email) return null
      tokens.delete(tokenHash)
      return usersByEmail.get(email) ?? null
    },
  }
}

function createJourney() {
  const db = createJourneyDatabase()
  const transport = createAuthTransport()
  const provisioned: { userId: string; email?: string }[] = []
  const linkCalls: {
    userId: string
    email?: string
    leadId?: string
    profileWrite?: string
  }[] = []

  const registration = createFreeRegistrationPostHandler({
    isEnabled: () => true,
    siteUrl: ORIGIN,
    checkRateLimit: async () => ({ allowed: true }),
    async loadLead(leadId) {
      const row = db.leads.find((lead) => lead.id === leadId)
      if (!row) return null
      return {
        id: row.id as string,
        email: row.email as string,
        quizKind: row.quiz_kind as "legacy" | "personal_plan",
        userId: (row.user_id as string | null) ?? null,
      }
    },
    async updateLeadEmail(leadId, email) {
      const row = db.leads.find((lead) => lead.id === leadId && lead.user_id === null)
      if (row) row.email = email
      return { updated: Boolean(row) }
    },
    // V3: the server-side provenance the confirm branch reads back.
    async markFreeRegistrationLead(leadId) {
      const row = db.leads.find((lead) => lead.id === leadId && lead.user_id === null)
      if (row) row.free_registration_requested_at = new Date().toISOString()
      return { marked: Boolean(row) }
    },
    checkEmailDeliverability: async (email) => ({ ok: true, normalized: email }),
    // The real HMAC contract, exercised end to end with a test secret.
    verifyCorrectionCapability: (token, leadId) =>
      verifyFreeRegistrationCapability(token, leadId, { secret: CAPABILITY_SECRET }),
    sendMagicLink: transport.sendMagicLink,
  })

  /**
   * Mirrors `linkQuizToProfile` for a `personal_plan` lead: the same binding
   * rule, the same RPC, the same projection helper, the same lead-linking
   * write. Only the admin-client construction is replaced.
   */
  async function linkQuizToProfile(
    userId: string,
    email?: string,
    leadId?: string,
    options?: LinkQuizToProfileOptions,
  ) {
    linkCalls.push({
      userId,
      ...(email ? { email } : {}),
      ...(leadId ? { leadId } : {}),
      ...(options?.profileWrite ? { profileWrite: options.profileWrite } : {}),
    })
    if (!leadId) return
    const lead = db.leads.find((row) => row.id === leadId)
    if (!lead || lead.quiz_kind !== "personal_plan") return
    if (
      !canLinkDirectQuizLead(
        { email: lead.email as string, userId: (lead.user_id as string | null) ?? null },
        { ...(email ? { email } : {}), userId },
      )
    ) {
      return
    }
    const { data, error } = await db.admin.rpc("link_personal_plan_artifact_to_user", {
      p_lead_id: leadId,
      p_user_id: userId,
    })
    if (error) throw error
    const result = Array.isArray(data) ? data[0] : data
    const profileData = buildProfileDataFromPersonalPlanCanonicalProfile(
      (result as { canonical_profile: unknown }).canonical_profile,
    )
    profileData.user_id = userId
    // Mirrors the real function's existing-row branch, which UPDATEs rather
    // than inserts — the write W1b exists to prevent (link-to-profile.ts:214) —
    // and its `create_only` mode, which V4 added for the free path.
    const existing = db.hairProfiles.find((row) => row.user_id === userId)
    if (existing) {
      if (options?.profileWrite === "create_only") return
      Object.assign(existing, profileData)
    } else db.hairProfiles.push(profileData)
    lead.user_id = userId
    lead.status = "linked"
  }

  const provisioningReports: { stage: string; outcome: string }[] = []
  let provisionOverride: (() => ProvisionFreeInitialSnapshotResult) | null = null

  const confirm = createAuthConfirmGetHandler({
    createClient: async () =>
      ({
        auth: {
          async exchangeCodeForSession() {
            return { error: new Error("no pkce code in this journey") }
          },
          async verifyOtp(input: { token_hash: string }) {
            currentUser = transport.consume(input.token_hash)
            return { error: currentUser ? null : new Error("otp_expired") }
          },
          async getUser() {
            return { data: { user: currentUser } }
          },
        },
      }) as never,
    linkQuizToProfile,
    loadJourneyAccess: async () => ({ kind: "legacy" }) as never,
    freemiumScannerFirstEnabled: () => flagEnabled,
    async provisionFreeSnapshot(input) {
      provisioned.push(input)
      if (provisionOverride) return provisionOverride()
      return createFreeSnapshotService(
        createFreeSnapshotSupabaseDependencies(db.admin as never),
      ).provisionFreeInitialSnapshot(input)
    },
    // The REAL bind guard (W1b) and the REAL reporting seam (W2), both driven
    // through the same in-memory database the rest of the journey uses.
    loadFreeBindEvidence: (input) =>
      loadFreeRegistrationBindEvidence({ ...input, admin: db.admin as never }),
    reportFreeProvisioning: (result, ctx) => {
      if (result.outcome !== "provisioned" && result.outcome !== "paid_user") {
        provisioningReports.push({ stage: ctx.stage, outcome: result.outcome })
      }
    },
  })

  let currentUser: { id: string; email: string } | null = null
  let flagEnabled = true

  return {
    db,
    transport,
    provisioned,
    provisioningReports,
    linkCalls,
    setFlag: (value: boolean) => {
      flagEnabled = value
    },
    failProvisioning: (result: ProvisionFreeInitialSnapshotResult | null) => {
      provisionOverride = result ? () => result : null
    },
    /** The capability the completing browser would have received. */
    capabilityFor: (leadId: string) =>
      issueFreeRegistrationCapability(leadId, { secret: CAPABILITY_SECRET }),
    async register(leadId: string, email?: string, capability?: string | null) {
      const response = await registration(
        new Request(`${ORIGIN}/api/auth/free-registration`, {
          method: "POST",
          body: JSON.stringify(
            email ? { leadId, email, ...(capability ? { capability } : {}) } : { leadId },
          ),
        }),
      )
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    },
    async openLink(link: SentLink) {
      const url = new URL(link.emailRedirectTo)
      url.searchParams.set("token_hash", link.tokenHash)
      url.searchParams.set("type", "magiclink")
      return confirm(new Request(url.toString()))
    },
    /** The link as the REAL e-mail builder renders it (finding V2). */
    async openDeliveredLink(link: SentLink, actionType: "signup" | "magiclink") {
      return confirm(new Request(realEmailConfirmUrl(link, actionType).toString()))
    },
    async openExpiredDeliveredLink(link: SentLink, actionType: "signup" | "magiclink") {
      const url = realEmailConfirmUrl({ ...link, tokenHash: "expired-token-hash" }, actionType)
      return confirm(new Request(url.toString()))
    },
    /** Drive `/auth/confirm` with a hand-built URL (tampering scenarios). */
    async openRaw(url: URL) {
      return confirm(new Request(url.toString()))
    },
    async openExpiredLink(link: SentLink) {
      const url = new URL(link.emailRedirectTo)
      url.searchParams.set("token_hash", "expired-token-hash")
      url.searchParams.set("type", "magiclink")
      return confirm(new Request(url.toString()))
    },
  }
}

// The delivered mail is a `signup` for a brand-new address and a `magiclink`
// for one that already has an account; `shouldCreateUser: true` produces both,
// and the builder nests this contract's callback differently in each.
for (const actionType of ["signup", "magiclink"] as const) {
  test(`JOURNEY (${actionType} mail): quiz -> e-mail -> magic link -> /scan with the quiz artifact intact`, async () => {
    const journey = createJourney()
    const leadId = journey.db.seedQuizCompletion("lena@example.com")

    // 1. The quiz saved the lead; the registration screen asks for the link.
    const sent = await journey.register(leadId)
    assert.equal(sent.status, 200)
    assert.deepEqual(sent.body, { ok: true, email: "lena@example.com", corrected: false })
    assert.equal(journey.transport.sent.length, 1)

    // 2. The link binds the EXACT lead and lands on the scanner — driven through
    //    the REAL builder output, which nests the callback one layer down.
    const link = journey.transport.sent[0]
    assert.equal(link.email, "lena@example.com")
    const redirect = new URL(link.emailRedirectTo)
    assert.equal(redirect.pathname, "/auth/confirm")
    assert.equal(redirect.searchParams.get("lead"), leadId)
    assert.equal(redirect.searchParams.get("next"), "/scan")

    const clicked = realEmailConfirmUrl(link, actionType)
    assert.equal(clicked.searchParams.get("lead"), null, "the outer query has no lead")
    assert.equal(clicked.searchParams.get("free"), null, "the outer query has no free marker")

    const response = await journey.openDeliveredLink(link, actionType)
    assert.equal(response.status, 307)
    assert.equal(response.headers.get("location"), `${ORIGIN}/scan`)

    // 3. The lead is claimed by the new account and its artifact came with it.
    const userId = journey.linkCalls[0].userId
    assert.equal(journey.db.leads[0].user_id, userId)
    assert.equal(journey.db.preparedArtifacts[0].user_id, userId)

    // 4. The scanner works immediately — no `profile_missing` 409.
    assert.deepEqual(journey.provisioned, [{ userId, email: "lena@example.com" }])
    const context = await loadScanEvaluationContext(journey.db.admin as never, userId)
    assert.ok(context, "expected a scan evaluation context — profile_missing must not fire")
    assert.equal(context?.snapshotSource, "initial")
  })
}

test("V2: an expired DELIVERED link recovers to /registrierung, in both mail shapes", async () => {
  for (const actionType of ["signup", "magiclink"] as const) {
    const journey = createJourney()
    const leadId = journey.db.seedQuizCompletion("lena@example.com")
    await journey.register(leadId)

    const response = await journey.openExpiredDeliveredLink(journey.transport.sent[0], actionType)
    assert.equal(
      response.headers.get("location"),
      `${ORIGIN}/registrierung?lead=${leadId}&error=link_expired`,
      `${actionType}: an expired delivered link must reach the registration screen`,
    )
    assert.deepEqual(journey.provisioned, [])
  }
})

test("JOURNEY: quiz -> e-mail -> magic link -> /scan with the quiz artifact intact", async () => {
  const journey = createJourney()
  const leadId = journey.db.seedQuizCompletion("lena@example.com")

  // 1. The quiz saved the lead; the registration screen asks for the link.
  const sent = await journey.register(leadId)
  assert.equal(sent.status, 200)
  assert.deepEqual(sent.body, { ok: true, email: "lena@example.com", corrected: false })
  assert.equal(journey.transport.sent.length, 1)

  // 2. The link binds the EXACT lead and lands on the scanner.
  const link = journey.transport.sent[0]
  assert.equal(link.email, "lena@example.com")
  const redirect = new URL(link.emailRedirectTo)
  assert.equal(redirect.pathname, "/auth/confirm")
  assert.equal(redirect.searchParams.get("lead"), leadId)
  assert.equal(redirect.searchParams.get("next"), "/scan")

  const response = await journey.openLink(link)
  assert.equal(response.status, 307)
  assert.equal(response.headers.get("location"), `${ORIGIN}/scan`)

  // 3. The lead is claimed by the new account and its artifact came with it.
  const userId = journey.linkCalls[0].userId
  assert.equal(journey.db.leads[0].user_id, userId)
  assert.equal(journey.db.preparedArtifacts[0].user_id, userId)
  assert.equal(journey.db.preparedArtifacts[0].status, "attached")

  // 4. Profil shows quiz-derived content (the projection the profile reads).
  const profile = journey.db.hairProfiles.find((row) => row.user_id === userId)
  assert.ok(profile, "expected a hair_profiles row projected from the quiz")
  assert.equal(profile?.hair_texture, "wavy")
  assert.equal(profile?.thickness, "fine")
  assert.equal(profile?.scalp_type, "dry")
  assert.deepEqual(profile?.chemical_treatment, ["colored"])

  // 5. The scanner works immediately — no `profile_missing` 409.
  assert.deepEqual(journey.provisioned, [{ userId, email: "lena@example.com" }])
  const context = await loadScanEvaluationContext(journey.db.admin as never, userId)
  assert.ok(context, "expected a scan evaluation context — profile_missing must not fire")
  assert.equal(context?.snapshotSource, "initial")

  // 6. Middleware admits the free account on /scan without an intake bounce.
  assert.equal(
    getAuthenticatedAppRedirect("/scan", "needs_onboarding", {
      freemiumScannerFirstEnabled: true,
      personalPlanRoutineAccess: {
        hasActivePersonalPlanEntitlement: false,
        pendingRoutineProposalId: null,
        activeRoutineVersionId: null,
      },
    }),
    null,
  )
})

test("RECOVERY resend: a second link works and the lead is still bound exactly once", async () => {
  const journey = createJourney()
  const leadId = journey.db.seedQuizCompletion("lena@example.com")

  await journey.register(leadId)
  const resend = await journey.register(leadId)
  assert.equal(resend.status, 200)
  assert.equal(journey.transport.sent.length, 2)
  assert.equal(journey.transport.sent[1].email, "lena@example.com")

  const response = await journey.openLink(journey.transport.sent[1])
  assert.equal(response.headers.get("location"), `${ORIGIN}/scan`)
  assert.equal(journey.db.hairProfiles.length, 1)
})

test("RECOVERY correction: a corrected address still lands on the same lead's artifact", async () => {
  const journey = createJourney()
  const leadId = journey.db.seedQuizCompletion("lena@examlpe.de")

  await journey.register(leadId)
  const corrected = await journey.register(leadId, "lena@example.de", journey.capabilityFor(leadId))
  assert.equal(corrected.status, 200)
  assert.deepEqual(corrected.body, { ok: true, email: "lena@example.de", corrected: true })

  const response = await journey.openLink(journey.transport.sent[1])
  assert.equal(response.headers.get("location"), `${ORIGIN}/scan`)

  const userId = journey.linkCalls.at(-1)!.userId
  assert.equal(journey.db.leads[0].email, "lena@example.de")
  assert.equal(journey.db.leads[0].user_id, userId)
  assert.equal(journey.db.preparedArtifacts[0].user_id, userId)
  assert.ok(await loadScanEvaluationContext(journey.db.admin as never, userId))
})

test("RECOVERY correction: without the lead rewrite the binding rule would reject the account", () => {
  // Pins WHY the correction path rewrites the lead: `canLinkDirectQuizLead`
  // only admits an account whose e-mail equals the unclaimed lead's.
  assert.equal(
    canLinkDirectQuizLead(
      { email: "lena@examlpe.de", userId: null },
      { email: "lena@example.de", userId: "user-1" },
    ),
    false,
  )
  assert.equal(
    canLinkDirectQuizLead(
      { email: "lena@example.de", userId: null },
      { email: "lena@example.de", userId: "user-1" },
    ),
    true,
  )
})

test("RECOVERY expired link: back to the registration screen, nothing provisioned", async () => {
  const journey = createJourney()
  const leadId = journey.db.seedQuizCompletion("lena@example.com")
  await journey.register(leadId)

  const response = await journey.openExpiredLink(journey.transport.sent[0])
  assert.equal(
    response.headers.get("location"),
    `${ORIGIN}/registrierung?lead=${leadId}&error=link_expired`,
  )
  assert.deepEqual(journey.provisioned, [])
  assert.equal(journey.db.hairProfiles.length, 0)

  // The recovery screen can request a fresh link for the same lead.
  const again = await journey.register(leadId)
  assert.equal(again.status, 200)
  const retry = await journey.openLink(journey.transport.sent[1])
  assert.equal(retry.headers.get("location"), `${ORIGIN}/scan`)
})

test("a lead that already belongs to an account cannot be re-registered", async () => {
  const journey = createJourney()
  const leadId = journey.db.seedQuizCompletion("lena@example.com")
  await journey.register(leadId)
  await journey.openLink(journey.transport.sent[0])

  const takeover = await journey.register(
    leadId,
    "angreifer@example.com",
    journey.capabilityFor(leadId),
  )
  assert.equal(takeover.status, 409)
  assert.equal(takeover.body.code, "lead_claimed")
  assert.equal(journey.db.leads[0].email, "lena@example.com")
  assert.equal(journey.transport.sent.length, 1)
})

test("ATTACK W1a: a stranger holding an unclaimed lead id cannot redirect it", async () => {
  const journey = createJourney()
  // `/result/<leadId>/reveal` publishes this id — possession proves nothing.
  const leadId = journey.db.seedQuizCompletion("lena@example.com")
  await journey.register(leadId)

  const bare = await journey.register(leadId, "angreifer@example.com")
  assert.equal(bare.status, 403)
  assert.equal(bare.body.code, "correction_not_authorized")

  const forged = await journey.register(
    leadId,
    "angreifer@example.com",
    issueFreeRegistrationCapability(leadId, { secret: "attackers-own-secret-long-enough" }),
  )
  assert.equal(forged.status, 403)

  // The lead still points at the victim, and the attacker was never mailed.
  assert.equal(journey.db.leads[0].email, "lena@example.com")
  assert.equal(journey.transport.sent.length, 1)
  assert.equal(journey.transport.sent[0].email, "lena@example.com")

  // The genuine completing browser's capability still works.
  const genuine = await journey.register(
    leadId,
    "lena.neu@example.com",
    journey.capabilityFor(leadId),
  )
  assert.equal(genuine.status, 200)
  assert.equal(journey.db.leads[0].email, "lena.neu@example.com")
  assert.equal(journey.transport.sent.at(-1)?.email, "lena.neu@example.com")
})

test("ATTACK V1: a capability minted for a FRESH lead cannot authorize another lead", async () => {
  // The other half of V1's containment: even where a capability legitimately
  // exists (the attacker completed their own quiz), it is scoped to exactly the
  // lead it was minted for, so it can never move the lead the dedup RPC would
  // have handed back.
  const journey = createJourney()
  const attackerLead = journey.db.seedQuizCompletion("angreifer@example.com")
  const victimLead = journey.db.seedQuizCompletion("opfer@example.com")

  const stolen = await journey.register(
    victimLead,
    "angreifer@example.com",
    journey.capabilityFor(attackerLead),
  )
  assert.equal(stolen.status, 403)
  assert.equal(stolen.body.code, "correction_not_authorized")
  assert.equal(journey.db.leads[1].email, "opfer@example.com")
  assert.equal(journey.transport.sent.length, 0, "nothing was mailed to the attacker")
})

test("ATTACK W1b: a victim's click on an attacker's lead never overwrites their profile", async () => {
  const journey = createJourney()

  // 1. The victim is an established user: their own quiz, their own account.
  const victimLead = journey.db.seedQuizCompletion("opfer@example.com")
  await journey.register(victimLead)
  await journey.openLink(journey.transport.sent[0])
  const victimId = journey.linkCalls[0].userId
  const victimProfile = journey.db.hairProfiles.find((row) => row.user_id === victimId)
  assert.ok(victimProfile)
  const victimSnapshot = { ...victimProfile }

  // 2. The attacker completes their OWN quiz and — this is the whole attack —
  //    registers it against the victim's address. `shouldCreateUser: true`
  //    against an existing account mails that account an ordinary LOGIN link.
  const attackerLead = journey.db.seedQuizCompletion("angreifer@example.com")
  journey.db.preparedArtifacts[1].canonical_profile = {
    ...CANONICAL_PROFILE,
    structure: "coily",
    thickness: "coarse",
    scalp_type: "fettig",
    treatment: ["blondiert"],
  }
  const redirected = await journey.register(
    attackerLead,
    "opfer@example.com",
    journey.capabilityFor(attackerLead),
  )
  assert.equal(redirected.status, 200, "the attacker owns their own lead's capability")

  // 3. The victim clicks the genuine-looking link.
  const response = await journey.openLink(journey.transport.sent.at(-1)!)

  // 4. Nothing of theirs moved: same profile, no adoption, no provisioning.
  const after = journey.db.hairProfiles.find((row) => row.user_id === victimId)
  assert.deepEqual(after, victimSnapshot, "the victim's hair profile must be untouched")
  assert.equal(journey.db.hairProfiles.length, 1)
  assert.equal(journey.db.leads[1].user_id, null, "the attacker's lead was not adopted")
  assert.equal(journey.db.preparedArtifacts[1].user_id, null)
  assert.equal(journey.provisioned.length, 1, "no provisioning over an established account")

  // 5. They land on /scan as their existing self, with an honest notice.
  assert.equal(response.headers.get("location"), `${ORIGIN}/scan?konto=bestehend`)
})

test("W1b: a re-click of one's OWN link still re-binds (the same-user retry survives)", async () => {
  const journey = createJourney()
  const leadId = journey.db.seedQuizCompletion("lena@example.com")
  // Two links minted before the lead was claimed (an ordinary „nochmal senden").
  await journey.register(leadId)
  await journey.register(leadId)
  await journey.openLink(journey.transport.sent[0])
  const userId = journey.linkCalls[0].userId

  // The second one, opened by the account that now OWNS the lead.
  const again = await journey.openLink(journey.transport.sent[1])

  assert.equal(again.headers.get("location"), `${ORIGIN}/scan`)
  assert.equal(journey.linkCalls.length, 2, "linkQuizToProfile ran again for the owner")
  assert.equal(journey.provisioned.length, 2)
  assert.equal(journey.db.hairProfiles.length, 1)
  assert.equal(journey.db.leads[0].user_id, userId)
})

test("W2: a typed provisioning failure is reported, and a later /scan visit recovers it", async () => {
  const journey = createJourney()
  const leadId = journey.db.seedQuizCompletion("lena@example.com")
  await journey.register(leadId)

  // The service's failures are typed non-errors, so the old `catch` never saw them.
  journey.failProvisioning({ outcome: "temporarily_unavailable" })
  const response = await journey.openLink(journey.transport.sent[0])
  assert.equal(response.headers.get("location"), `${ORIGIN}/scan`)
  const userId = journey.linkCalls[0].userId

  assert.deepEqual(journey.provisioningReports, [
    { stage: "confirm", outcome: "temporarily_unavailable" },
  ])
  // The dead end this used to be: no snapshot, and the lead is already claimed.
  assert.equal(await loadScanEvaluationContext(journey.db.admin as never, userId), null)
  const blocked = await journey.register(leadId)
  assert.equal(blocked.status, 409)

  // The retry seam: the next authenticated /scan visit provisions.
  journey.failProvisioning(null)
  const retried = await recoverMissingFreeSnapshot({
    userId,
    email: "lena@example.com",
    admin: journey.db.admin as never,
    provision: (input) =>
      createFreeSnapshotService(
        createFreeSnapshotSupabaseDependencies(journey.db.admin as never),
      ).provisionFreeInitialSnapshot(input),
    report: () => {},
  })
  assert.equal(retried, "attempted")
  const context = await loadScanEvaluationContext(journey.db.admin as never, userId)
  assert.ok(context, "the free product recovered — no permanent profile_missing")
  assert.equal(context?.snapshotSource, "initial")

  // Idempotent: a healthy account never re-enters the provisioning path.
  let provisionCalls = 0
  const second = await recoverMissingFreeSnapshot({
    userId,
    admin: journey.db.admin as never,
    provision: async () => {
      provisionCalls += 1
      return { outcome: "temporarily_unavailable" }
    },
    report: () => {},
  })
  assert.equal(second, "not_needed")
  assert.equal(provisionCalls, 0)
})

test("ATTACK W3: ?free=1 on a payment-flow link does not take the free branch", async () => {
  const journey = createJourney()
  const leadId = journey.db.seedQuizCompletion("lena@example.com")
  await journey.register(leadId)
  const link = journey.transport.sent[0]

  // A payment-activation style link — no free lead, its own destination —
  // with `?free=1` bolted on by the caller.
  const tampered = new URL(`${ORIGIN}/auth/confirm`)
  tampered.searchParams.set("free", "1")
  tampered.searchParams.set("next", "/plan-start")
  tampered.searchParams.set("token_hash", link.tokenHash)
  tampered.searchParams.set("type", "magiclink")

  const response = await journey.openRaw(tampered)
  assert.equal(response.headers.get("location"), `${ORIGIN}/plan-start`)
  // The decisive assertion: the free write — which pins
  // `enrollment_purchase_source_id = null` permanently — never ran.
  assert.deepEqual(journey.provisioned, [])

  // Same for a free lead id smuggled onto a non-/scan destination.
  const journey2 = createJourney()
  const lead2 = journey2.db.seedQuizCompletion("mara@example.com")
  await journey2.register(lead2)
  const smuggled = new URL(journey2.transport.sent[0].emailRedirectTo)
  smuggled.searchParams.set("next", "/plan-start")
  smuggled.searchParams.set("token_hash", journey2.transport.sent[0].tokenHash)
  smuggled.searchParams.set("type", "magiclink")
  await journey2.openRaw(smuggled)
  assert.deepEqual(journey2.provisioned, [])
})

test("ATTACK V3a: stripping ?free=1 does not escape the bind containment", async () => {
  // The free-vs-paid branch used to be decided by the URL, so a GENUINE
  // free-registration token with the marker removed (or `next` repointed) ran
  // `linkQuizToProfile` with no containment at all — straight over an
  // established account's hair profile.
  const journey = createJourney()

  const victimLead = journey.db.seedQuizCompletion("opfer@example.com")
  await journey.register(victimLead)
  await journey.openLink(journey.transport.sent[0])
  const victimId = journey.linkCalls[0].userId
  const victimSnapshot = { ...journey.db.hairProfiles.find((row) => row.user_id === victimId)! }

  // The attacker points their own lead at the victim's address, as in W1b.
  const attackerLead = journey.db.seedQuizCompletion("angreifer@example.com")
  journey.db.preparedArtifacts[1].canonical_profile = {
    ...CANONICAL_PROFILE,
    structure: "coily",
    thickness: "coarse",
  }
  await journey.register(attackerLead, "opfer@example.com", journey.capabilityFor(attackerLead))
  const link = journey.transport.sent.at(-1)!

  for (const tamper of [
    (url: URL) => url.searchParams.delete("free"),
    (url: URL) => url.searchParams.set("next", "/plan-start"),
  ]) {
    const url = new URL(link.emailRedirectTo)
    tamper(url)
    url.searchParams.set("token_hash", link.tokenHash)
    url.searchParams.set("type", "magiclink")
    // A fresh token for the same account — the link is single-use.
    await journey.register(attackerLead)
    const fresh = journey.transport.sent.at(-1)!
    url.searchParams.set("token_hash", fresh.tokenHash)

    const linkCallsBefore = journey.linkCalls.length
    await journey.openRaw(url)
    assert.deepEqual(
      journey.db.hairProfiles.find((row) => row.user_id === victimId),
      victimSnapshot,
      "the victim's profile must survive every parameter shape",
    )
    assert.equal(journey.db.leads[1].user_id, null, "the attacker's lead was not adopted")
    // The containment has to fire BEFORE `linkQuizToProfile`, not inside it:
    // that function attaches the prepared artifact to the account through
    // `link_personal_plan_artifact_to_user` before it ever looks at the profile,
    // so "the profile survived" is not on its own proof that nothing moved.
    assert.equal(
      journey.linkCalls.length,
      linkCallsBefore,
      "linkQuizToProfile must not run at all for a free-provenance lead that fails the bind",
    )
    assert.equal(
      journey.db.preparedArtifacts[1].user_id,
      null,
      "the attacker's artifact must not be re-attached to the victim",
    )
  }
})

test("ATTACK V3b: crafted free params on a lead the free flow never marked take no free branch", async () => {
  const journey = createJourney()
  const freeLead = journey.db.seedQuizCompletion("lena@example.com")
  await journey.register(freeLead)
  const link = journey.transport.sent[0]

  // A lead that was never registered through `/api/auth/free-registration` has
  // no provenance mark — the shape of the URL must not be able to invent one,
  // because the free write pins `enrollment_purchase_source_id = null` forever.
  const foreignLead = journey.db.seedQuizCompletion("fremd@example.com")
  assert.equal(journey.db.leads[1].free_registration_requested_at, undefined)

  const crafted = new URL(`${ORIGIN}/auth/confirm`)
  crafted.searchParams.set("free", "1")
  crafted.searchParams.set("lead", foreignLead)
  crafted.searchParams.set("next", "/scan")
  crafted.searchParams.set("token_hash", link.tokenHash)
  crafted.searchParams.set("type", "magiclink")

  await journey.openRaw(crafted)
  assert.deepEqual(journey.provisioned, [], "the free write must not run for an unmarked lead")
  assert.equal(
    journey.linkCalls.at(-1)?.profileWrite,
    undefined,
    "and the lead is linked with ordinary paid semantics, not the free create-only mode",
  )
})

test("flag off: /auth/confirm ignores the free marker entirely (byte-identical legacy behaviour)", async () => {
  const journey = createJourney()
  const leadId = journey.db.seedQuizCompletion("lena@example.com")
  await journey.register(leadId)
  journey.setFlag(false)

  // Verified link: still lands on `next`, but never provisions a free snapshot.
  const verified = await journey.openLink(journey.transport.sent[0])
  assert.equal(verified.headers.get("location"), `${ORIGIN}/scan`)
  assert.deepEqual(journey.provisioned, [])

  // Expired link: the pre-existing `/auth?error=link_expired` destination.
  const second = createJourney()
  const otherLead = second.db.seedQuizCompletion("mara@example.com")
  await second.register(otherLead)
  second.setFlag(false)
  const expired = await second.openExpiredLink(second.transport.sent[0])
  assert.equal(expired.headers.get("location"), `${ORIGIN}/auth?error=link_expired&next=%2Fscan`)
})
