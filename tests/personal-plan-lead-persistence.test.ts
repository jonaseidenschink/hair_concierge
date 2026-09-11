import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  canonicalizePersonalPlanAnswers,
  createPersonalPlanClaimCredential,
  hashPersonalPlanAnswers,
  hashPersonalPlanClaimToken,
  normalizePersonalPlanEmail,
  personalPlanLeadRequestSchema,
  personalPlanPrepareRequestSchema,
} from "../src/lib/personal-plan-quiz/persistence"
import { syncPersonalPlanLeadToCustomerIo } from "../src/lib/personal-plan-quiz/customerio"
import { createPersonalPlanLeadPostHandler } from "../src/app/api/quiz/personal-plan-lead/route"
import { recordEmailDeliverabilityOutcome } from "../src/lib/email-deliverability-observability"
import { EMAIL_DELIVERABILITY_REJECTION_MESSAGE } from "../src/lib/email-deliverability-shared"

const request = {
  email: "  PLAN@EXAMPLE.COM ",
  marketingConsent: false,
  preparedPlan: {
    artifactId: "0b670f15-faad-4eb2-a888-4ace59680bb0",
    claimToken: "v2-prepared-plan-claim-token-with-at-least-forty-characters",
  },
  answers: {
    texture: "wavy",
    thickness: "fine",
    density: "medium",
    goals: ["shine", "moisture"],
    routineClarity: "partial",
    resultReliability: "sometimes",
    adaptationConfidence: "partly",
    currentConcerns: ["low_shine", "frizz_flyaways", "breakage", "split_ends"],
    concernRecurrence: { concernId: "breakage", frequency: "often" },
    hairLength: "medium",
    hairSurface: "slightly_uneven",
    elasticResponse: "stretches_stays",
    chemicalTreatments: ["colored"],
    scalpOiliness: "balanced",
    scalpConcerns: [],
    previousAttempts: "some_steps_helped",
    blockers: ["product_fit", "conflicting_tips"],
    routineStyle: "simple_reliable",
    meaningfulMoment: "everyday",
  },
} as const

const preparationCredential = {
  preparationId: "1f83fb67-1bee-4b20-8fc2-1d53c38b2cec",
  claimToken: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
} as const

const preparePayload = (answers: unknown, extra: Record<string, unknown> = {}) => ({
  answers,
  ...preparationCredential,
  ...extra,
})

test("personal-plan preparation accepts a paired replay credential and transitional legacy requests", () => {
  assert.equal(
    personalPlanPrepareRequestSchema.safeParse({
      answers: request.answers,
      ...preparationCredential,
    }).success,
    true,
  )
  assert.equal(
    personalPlanPrepareRequestSchema.safeParse({ answers: request.answers }).success,
    true,
  )
  assert.equal(
    personalPlanPrepareRequestSchema.safeParse({
      answers: request.answers,
      preparationId: preparationCredential.preparationId,
    }).success,
    false,
  )
  assert.equal(
    personalPlanPrepareRequestSchema.safeParse({
      answers: request.answers,
      claimToken: preparationCredential.claimToken,
    }).success,
    false,
  )
  assert.equal(
    personalPlanPrepareRequestSchema.safeParse({
      answers: request.answers,
      ...preparationCredential,
      preparationId: "not-a-uuid",
    }).success,
    false,
  )
  assert.equal(
    personalPlanPrepareRequestSchema.safeParse({
      answers: request.answers,
      ...preparationCredential,
      claimToken: "too-short",
    }).success,
    false,
  )
})

test("personal-plan persistence accepts only the complete durable envelope and canonically orders selections", () => {
  const parsed = personalPlanLeadRequestSchema.parse(request)
  const envelope = canonicalizePersonalPlanAnswers(parsed.answers)

  assert.equal(normalizePersonalPlanEmail(parsed.email), "plan@example.com")
  assert.deepEqual(envelope, {
    kind: "personal_plan",
    version: 3,
    answers: {
      ...request.answers,
      goals: ["moisture", "shine"],
      currentConcerns: ["breakage", "frizz_flyaways", "low_shine", "split_ends"],
      concernRecurrence: { concernId: "breakage", frequency: "often" },
      blockers: ["conflicting_tips", "product_fit"],
    },
  })
})

test("personal-plan persistence accepts split concerns and binds recurrence to a selected concern", () => {
  assert.equal(
    personalPlanPrepareRequestSchema.safeParse(preparePayload(request.answers)).success,
    true,
  )
  assert.equal(
    personalPlanPrepareRequestSchema.safeParse(
      preparePayload({
        ...request.answers,
        concernRecurrence: { concernId: "dry_lengths", frequency: "sometimes" },
      }),
    ).success,
    false,
  )
  assert.equal(
    personalPlanPrepareRequestSchema.safeParse(
      preparePayload({
        ...request.answers,
        currentConcerns: ["breakage_or_split_ends"],
        concernRecurrence: undefined,
      }),
    ).success,
    false,
  )
})

test("personal-plan persistence canonicalizes a 50-character concern note and rejects longer text", () => {
  const note = "x".repeat(50)
  const parsed = personalPlanPrepareRequestSchema.parse(
    preparePayload({ ...request.answers, currentConcernsOtherText: `  ${note}  ` }),
  )
  assert.equal(
    canonicalizePersonalPlanAnswers(parsed.answers).answers.currentConcernsOtherText,
    note,
  )
  assert.equal(
    personalPlanPrepareRequestSchema.safeParse(
      preparePayload({ ...request.answers, currentConcernsOtherText: "x".repeat(51) }),
    ).success,
    false,
  )
  assert.equal(
    personalPlanPrepareRequestSchema.safeParse(
      preparePayload({
        ...request.answers,
        currentConcerns: [],
        concernRecurrence: undefined,
        currentConcernsOtherText: "Anderes Thema",
      }),
    ).success,
    true,
  )
  assert.equal(
    personalPlanPrepareRequestSchema.safeParse(
      preparePayload({ ...request.answers, blockersOtherText: "x".repeat(280) }),
    ).success,
    true,
  )
  const blank = personalPlanPrepareRequestSchema.parse(
    preparePayload({ ...request.answers, currentConcernsOtherText: "   " }),
  )
  assert.equal(
    canonicalizePersonalPlanAnswers(blank.answers).answers.currentConcernsOtherText,
    undefined,
  )
  assert.equal(
    Object.hasOwn(
      canonicalizePersonalPlanAnswers(blank.answers).answers,
      "currentConcernsOtherText",
    ),
    false,
  )
})

test("personal-plan persistence rejects ephemeral commitments and duplicate scalp concerns", () => {
  assert.equal(
    personalPlanLeadRequestSchema.safeParse({
      ...request,
      answers: { ...request.answers, dailyTime: "5_minutes" },
    }).success,
    false,
  )
  assert.equal(
    personalPlanLeadRequestSchema.safeParse({
      ...request,
      answers: { ...request.answers, scalpConcerns: ["irritated", "irritated"] },
    }).success,
    false,
  )
})

test("personal-plan preparation accepts durable answers without contact data or conversion answers", () => {
  assert.equal(
    personalPlanPrepareRequestSchema.safeParse(preparePayload(request.answers)).success,
    true,
  )
  assert.equal(
    personalPlanPrepareRequestSchema.safeParse(
      preparePayload({ ...request.answers, dailyTime: "5_minutes" }),
    ).success,
    false,
  )
  assert.equal(
    personalPlanPrepareRequestSchema.safeParse(
      preparePayload(request.answers, { email: request.email }),
    ).success,
    false,
  )
})

test("personal-plan claim credentials are high entropy and only their hashes are stable", () => {
  const first = createPersonalPlanClaimCredential()
  const second = createPersonalPlanClaimCredential()
  assert.notEqual(first.claimToken, second.claimToken)
  assert.equal(first.claimToken.length >= 40, true)
  assert.equal(first.claimTokenHash, hashPersonalPlanClaimToken(first.claimToken))
  assert.match(first.claimTokenHash, /^[0-9a-f]{64}$/)
  const parsed = personalPlanPrepareRequestSchema.parse(preparePayload(request.answers))
  assert.match(
    hashPersonalPlanAnswers(canonicalizePersonalPlanAnswers(parsed.answers)),
    /^[0-9a-f]{64}$/,
  )
})

test("personal-plan persistence accepts only a valid optional funnel event ID", () => {
  assert.equal(
    personalPlanLeadRequestSchema.safeParse({
      ...request,
      funnelEventId: "0b670f15-faad-4eb2-a888-4ace59680bb0",
    }).success,
    true,
  )
  assert.equal(
    personalPlanLeadRequestSchema.safeParse({
      ...request,
      funnelEventId: "retry-1",
    }).success,
    false,
  )
})

test("personal-plan lead-kind migration adds the discriminant and lookup index", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/20260728120000_add_leads_quiz_kind.sql", import.meta.url),
    "utf8",
  )

  assert.match(migration, /ADD COLUMN IF NOT EXISTS quiz_kind/)
  assert.match(migration, /CHECK \(quiz_kind IN \('legacy', 'personal_plan'\)\)/)
  assert.match(migration, /leads_quiz_kind_email_created_at_idx/)
  assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION/)
})

test("prepared-plan migration keeps claims server-only and atomically attaches the first artifact", () => {
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20260728130000_add_personal_plan_prepared_artifacts.sql",
      import.meta.url,
    ),
    "utf8",
  )

  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.personal_plan_prepared_artifacts/)
  assert.match(migration, /claim_token_hash text NOT NULL UNIQUE/)
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/)
  assert.doesNotMatch(migration, /CREATE POLICY/)
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION public\.purge_expired_personal_plan_artifacts/,
  )
  assert.match(migration, /FOR UPDATE SKIP LOCKED/)
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION public\.save_personal_plan_lead_with_artifact/,
  )
  assert.match(migration, /claimed_artifact\.answer_hash <> p_answer_hash/)
  assert.match(migration, /status = 'superseded'/)
  assert.match(migration, /superseded_by = canonical_artifact_id/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.link_personal_plan_artifact_to_user/)
  assert.match(migration, /artifact\.user_id <> p_user_id/)
  assert.match(migration, /REVOKE ALL ON TABLE[\s\S]+PUBLIC, anon, authenticated/)
  assert.match(migration, /GRANT EXECUTE[\s\S]+TO service_role/)
})

test("prepare and lead endpoints exchange only an opaque claim before the result route", () => {
  const prepareRoute = readFileSync(
    new URL("../src/app/api/quiz/personal-plan-prepare/route.ts", import.meta.url),
    "utf8",
  )
  const leadRoute = readFileSync(
    new URL("../src/app/api/quiz/personal-plan-lead/route.ts", import.meta.url),
    "utf8",
  )

  assert.match(prepareRoute, /artifactId: result\.artifactId/)
  assert.match(prepareRoute, /claimToken: credential\.claimToken/)
  assert.doesNotMatch(prepareRoute, /NextResponse\.json\(\{[\s\S]{0,200}lockedPlan/)
  assert.doesNotMatch(prepareRoute, /NextResponse\.json\(\{[\s\S]{0,200}publicOfferModel/)
  assert.match(leadRoute, /save_personal_plan_lead_with_artifact/)
  assert.match(leadRoute, /hashPersonalPlanClaimToken\(parsed\.preparedPlan\.claimToken\)/)
  assert.match(leadRoute, /resolveBrowserFunnelEventId\(body\)/)
  assert.match(leadRoute, /dispatchCustomerIoProfileSyncForLead\(supabase, leadId\)/)
  assert.doesNotMatch(leadRoute, /syncPersonalPlanLeadToCustomerIo\(/)
  assert.match(leadRoute, /enqueueMetaLead\(\{/)
  assert.match(leadRoute, /META_PERSONAL_PLAN_QUIZ_EVENT_SOURCE_URL/)
  assert.match(leadRoute, /isPreparedPlanClaimError/)
  assert.match(leadRoute, /status: isPreparedPlanClaimError\(error\) \? 409 : 500/)
  assert.doesNotMatch(leadRoute, /NextResponse\.json\(\{[\s\S]{0,200}artifact/)
})

test("lead route executes a definitive deliverability rejection before persistence", async () => {
  const previousFlag = process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED
  process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED = "true"
  let checkedEmail: string | undefined
  let recorded = false
  const handler = createPersonalPlanLeadPostHandler({
    resolveModeratorJourney: async () => ({ kind: "ordinary" }),
    checkRateLimit: async () => ({ allowed: true }),
    checkEmailDeliverability: async (email) => {
      checkedEmail = email
      return { ok: false, reason: "no_mx", suggestion: "plan@example.com" }
    },
    recordEmailDeliverabilityOutcome: () => {
      recorded = true
    },
  })

  try {
    const response = await handler(
      new Request("https://chaarlie.de/api/quiz/personal-plan-lead", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
        body: JSON.stringify(request),
      }),
    )

    assert.equal(response.status, 422)
    assert.equal(checkedEmail, "plan@example.com")
    assert.equal(recorded, true)
    assert.deepEqual(await response.json(), {
      error: EMAIL_DELIVERABILITY_REJECTION_MESSAGE,
      reason: "no_mx",
      suggestion: "plan@example.com",
    })
  } finally {
    if (previousFlag === undefined) delete process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED
    else process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED = previousFlag
  }
})

test("lead route lets an accepted address reach persistence", async (context) => {
  const previousFlag = process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED
  process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED = "true"
  const errorLog = context.mock.method(console, "error", () => {})
  let rpcCall: unknown[] | undefined
  const handler = createPersonalPlanLeadPostHandler({
    resolveModeratorJourney: async () => ({ kind: "ordinary" }),
    checkRateLimit: async () => ({ allowed: true }),
    checkEmailDeliverability: async () => ({
      ok: true,
      normalized: "canonical@example.com",
      outcome: "mx",
    }),
    recordEmailDeliverabilityOutcome: () => {},
    cookies: (async () => ({ get: () => undefined })) as typeof import("next/headers").cookies,
    createAdminClient: (() => ({
      rpc: async (...args: unknown[]) => {
        rpcCall = args
        throw new Error("stop after persistence boundary")
      },
    })) as unknown as typeof import("../src/lib/supabase/admin").createAdminClient,
  })

  try {
    const response = await handler(
      new Request("https://chaarlie.de/api/quiz/personal-plan-lead", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
        body: JSON.stringify(request),
      }),
    )

    assert.equal(response.status, 500)
    assert.equal(rpcCall?.[0], "save_personal_plan_lead_with_artifact")
    assert.equal((rpcCall?.[1] as { p_email?: unknown })?.p_email, "canonical@example.com")
    assert.equal(errorLog.mock.callCount(), 1)
  } finally {
    if (previousFlag === undefined) delete process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED
    else process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED = previousFlag
  }
})

test("lead completion issues only an HttpOnly result capability and remains successful if issuance fails", async (context) => {
  const previousQuizFlag = process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED
  const previousReturnFlag = process.env.PERSONAL_PLAN_RESULT_RETURN_ENABLED
  process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED = "true"
  process.env.PERSONAL_PLAN_RESULT_RETURN_ENABLED = "true"
  context.mock.method(console, "warn", () => {})
  let issuanceCalls = 0

  const createHandler = (issued: boolean | "throw") =>
    createPersonalPlanLeadPostHandler({
      resolveModeratorJourney: async () => ({ kind: "ordinary" }),
      checkRateLimit: async () => ({ allowed: true }),
      checkEmailDeliverability: async () => ({
        ok: true,
        normalized: "canonical@example.com",
        outcome: "mx",
      }),
      recordEmailDeliverabilityOutcome: () => {},
      cookies: (async () => ({ get: () => undefined })) as typeof import("next/headers").cookies,
      scheduleAfter: (() => undefined) as typeof import("next/server").after,
      createAdminClient: (() => ({
        rpc: async () => ({
          data: [{ lead_id: "10000000-0000-4000-8000-000000000093" }],
          error: null,
        }),
      })) as unknown as typeof import("../src/lib/supabase/admin").createAdminClient,
      issueResultReturn: async ({ response }) => {
        issuanceCalls += 1
        if (issued === "throw") throw new Error("result return unavailable")
        if (issued) {
          response.cookies.set("__Host-test-result-return", "opaque", {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            path: "/",
            maxAge: 30 * 24 * 60 * 60,
          })
        }
        return { issued: issued === true }
      },
    })

  try {
    const issuedResponse = await createHandler(true)(
      new Request("https://chaarlie.de/api/quiz/personal-plan-lead", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
        body: JSON.stringify(request),
      }),
    )
    assert.equal(issuedResponse.status, 200)
    assert.deepEqual(await issuedResponse.json(), {
      leadId: "10000000-0000-4000-8000-000000000093",
      attributionAttached: false,
    })
    assert.match(issuedResponse.headers.get("set-cookie") ?? "", /HttpOnly/i)
    assert.doesNotMatch(issuedResponse.headers.get("set-cookie") ?? "", /10000000-0000/)

    const failedResponse = await createHandler(false)(
      new Request("https://chaarlie.de/api/quiz/personal-plan-lead", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
        body: JSON.stringify(request),
      }),
    )
    assert.equal(failedResponse.status, 200)

    const thrownResponse = await createHandler("throw")(
      new Request("https://chaarlie.de/api/quiz/personal-plan-lead", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
        body: JSON.stringify(request),
      }),
    )
    assert.equal(thrownResponse.status, 200)
    assert.equal(issuanceCalls, 3)
  } finally {
    if (previousQuizFlag === undefined) delete process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED
    else process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED = previousQuizFlag
    if (previousReturnFlag === undefined) delete process.env.PERSONAL_PLAN_RESULT_RETURN_ENABLED
    else process.env.PERSONAL_PLAN_RESULT_RETURN_ENABLED = previousReturnFlag
  }
})

test("lead completion does not issue a result capability while the feature is disabled", async () => {
  const previousQuizFlag = process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED
  const previousReturnFlag = process.env.PERSONAL_PLAN_RESULT_RETURN_ENABLED
  process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED = "true"
  delete process.env.PERSONAL_PLAN_RESULT_RETURN_ENABLED
  let issuanceCalls = 0
  const handler = createPersonalPlanLeadPostHandler({
    resolveModeratorJourney: async () => ({ kind: "ordinary" }),
    checkRateLimit: async () => ({ allowed: true }),
    checkEmailDeliverability: async () => ({
      ok: true,
      normalized: "canonical@example.com",
      outcome: "mx",
    }),
    recordEmailDeliverabilityOutcome: () => {},
    cookies: (async () => ({ get: () => undefined })) as typeof import("next/headers").cookies,
    scheduleAfter: (() => undefined) as typeof import("next/server").after,
    createAdminClient: (() => ({
      rpc: async () => ({
        data: [{ lead_id: "10000000-0000-4000-8000-000000000093" }],
        error: null,
      }),
    })) as unknown as typeof import("../src/lib/supabase/admin").createAdminClient,
    issueResultReturn: async () => {
      issuanceCalls += 1
      return { issued: true }
    },
  })

  try {
    const response = await handler(
      new Request("https://chaarlie.de/api/quiz/personal-plan-lead", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
        body: JSON.stringify(request),
      }),
    )
    assert.equal(response.status, 200)
    assert.equal(issuanceCalls, 0)
    assert.equal(response.headers.get("set-cookie"), null)
  } finally {
    if (previousQuizFlag === undefined) delete process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED
    else process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED = previousQuizFlag
    if (previousReturnFlag === undefined) delete process.env.PERSONAL_PLAN_RESULT_RETURN_ENABLED
    else process.env.PERSONAL_PLAN_RESULT_RETURN_ENABLED = previousReturnFlag
  }
})

test("field-test lead binds trusted campaign context and suppresses Meta conversion", async () => {
  const previousQuizFlag = process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED
  process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED = "true"
  let metaCalls = 0
  let bindCalls = 0
  const handler = createPersonalPlanLeadPostHandler({
    resolveModeratorJourney: async () => ({ kind: "ordinary" }),
    checkRateLimit: async () => ({ allowed: true }),
    checkEmailDeliverability: async () => ({
      ok: true,
      normalized: "participant@example.com",
      outcome: "mx",
    }),
    recordEmailDeliverabilityOutcome: () => {},
    cookies: (async () => ({
      get: (name: string) => ({ value: name === "chaarlie_funnel_session" ? "funnel" : "field" }),
    })) as unknown as typeof import("next/headers").cookies,
    scheduleAfter: (() => undefined) as typeof import("next/server").after,
    createAdminClient: (() => ({
      rpc: async () => ({
        data: [{ lead_id: "10000000-0000-4000-8000-000000000093" }],
        error: null,
      }),
    })) as unknown as typeof import("../src/lib/supabase/admin").createAdminClient,
    resolveFunnelCookieContext: async () => ({
      visitorId: "20000000-0000-4000-8000-000000000001",
      sessionId: "20000000-0000-4000-8000-000000000002",
      packageKey: "meta_personal_plan_v1",
      issuedAt: Date.now(),
    }),
    resolvePendingFunnelTouchValue: async () => null,
    resolvePersonalPlanFieldTestCampaignCookie: async () => ({
      kind: "eligible",
      campaign: {
        id: "30000000-0000-4000-8000-000000000003",
        accessDurationHours: 168,
        startsAt: Date.now() - 1,
        expiresAt: Date.now() + 60_000,
      },
    }),
    recordFunnelEvent: async () => true,
    bindPersonalPlanFieldTestLead: async () => {
      bindCalls += 1
      return true
    },
    enqueueMetaLead: () => {
      metaCalls += 1
      return true
    },
  })

  try {
    const response = await handler(
      new Request("https://chaarlie.de/api/quiz/personal-plan-lead", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
        body: JSON.stringify(request),
      }),
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      leadId: "10000000-0000-4000-8000-000000000093",
      attributionAttached: true,
      fieldTestAttached: true,
    })
    assert.equal(bindCalls, 1)
    assert.equal(metaCalls, 0)
  } finally {
    if (previousQuizFlag === undefined) delete process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED
    else process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED = previousQuizFlag
  }
})

test("Sentry deliverability metrics expose only bounded outcomes and never block", (context) => {
  const calls: unknown[][] = []
  const warning = context.mock.method(console, "warn", () => {})
  const count = (...args: unknown[]) => {
    calls.push(args)
  }

  recordEmailDeliverabilityOutcome(
    "personal_plan",
    { ok: true, normalized: "private@example.com", outcome: "fail_open" },
    count,
  )
  recordEmailDeliverabilityOutcome(
    "legacy",
    { ok: false, reason: "no_mx", suggestion: "private@example.com" },
    count,
  )

  assert.deepEqual(calls, [
    [
      "quiz.email_deliverability.check",
      1,
      { attributes: { journey: "personal_plan", outcome: "fail_open" } },
    ],
    [
      "quiz.email_deliverability.check",
      1,
      {
        attributes: {
          journey: "legacy",
          outcome: "rejected",
          reason: "no_mx",
          suggestion_present: true,
        },
      },
    ],
  ])
  assert.equal(JSON.stringify(calls).includes("private@example.com"), false)
  assert.doesNotThrow(() =>
    recordEmailDeliverabilityOutcome(
      "personal_plan",
      { ok: true, normalized: "private@example.com", outcome: "known_good" },
      () => {
        throw new Error("Sentry unavailable")
      },
    ),
  )
  assert.equal(warning.mock.callCount(), 1)
})

test("personal-plan Customer.io sync identifies the approved structured profile without an event", async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.CUSTOMERIO_SERVER_WRITE_KEY
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  process.env.CUSTOMERIO_SERVER_WRITE_KEY = "server-key"
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    })
    return new Response("{}", { status: 200 })
  }) as typeof fetch

  try {
    await syncPersonalPlanLeadToCustomerIo({
      createdAt: "2026-07-28T10:00:00.000Z",
      email: "plan@example.com",
      leadId: "lead-123",
      marketingConsent: false,
      quizAnswers: canonicalizePersonalPlanAnswers(
        personalPlanLeadRequestSchema.parse(request).answers,
      ),
      profileSyncRevision: 1,
      sendCompletionEvent: false,
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://cdp-eu.customer.io/v1/identify")
    const traits = calls[0].body.traits as Record<string, unknown>
    assert.equal(traits.email, "plan@example.com")
    assert.equal(traits.lead_id, "lead-123")
    assert.equal(traits.quiz_kind, "personal_plan")
    assert.equal(traits.marketing_consent, false)
    assert.equal(traits.personal_plan_profile_version, 3)
    assert.deepEqual(traits.personal_plan_goals, ["moisture", "shine"])
    assert.equal("plan_expires_at" in traits, false)
    assert.equal("blockers_other_text" in traits, false)
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.CUSTOMERIO_SERVER_WRITE_KEY
    else process.env.CUSTOMERIO_SERVER_WRITE_KEY = originalKey
  }
})

test("moderator completion atomically binds the account and suppresses marketing and bearer-return side effects", async () => {
  const previousQuiz = process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED
  const previousReturn = process.env.PERSONAL_PLAN_RESULT_RETURN_ENABLED
  process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED = "true"
  process.env.PERSONAL_PLAN_RESULT_RETURN_ENABLED = "true"
  const campaignId = "30000000-0000-4000-8000-000000000003"
  const userId = "10000000-0000-4000-8000-000000000001"
  const funnelSessionId = "20000000-0000-4000-8000-000000000002"
  const calls: Array<[string, Record<string, unknown>]> = []
  let sideEffects = 0
  const handler = (mode: "authorized" | "unavailable", email = "plan@example.com") =>
    createPersonalPlanLeadPostHandler({
      checkRateLimit: async () => ({ allowed: true }),
      checkEmailDeliverability: async () => ({
        ok: true,
        normalized: "plan@example.com",
        outcome: "mx",
      }),
      recordEmailDeliverabilityOutcome: () => {},
      cookies: (async () => ({
        get: () => ({ value: "signed" }),
      })) as unknown as typeof import("next/headers").cookies,
      createAdminClient: (() => ({
        rpc: async (name: string, args: Record<string, unknown>) => {
          calls.push([name, args])
          return { data: [{ lead_id: "10000000-0000-4000-8000-000000000093" }], error: null }
        },
      })) as unknown as typeof import("../src/lib/supabase/admin").createAdminClient,
      resolveFunnelCookieContext: async () => ({
        visitorId: userId,
        sessionId: funnelSessionId,
        packageKey: "meta_personal_plan_v1",
        issuedAt: Date.now(),
      }),
      resolvePendingFunnelTouchValue: async () => null,
      resolvePersonalPlanFieldTestCampaignCookie: async () => ({
        kind: "eligible",
        campaign: {
          id: campaignId,
          identityMode: "email_bound",
          accessDurationHours: 2160,
          startsAt: Date.now() - 1,
          expiresAt: Date.now() + 100000,
        },
      }),
      resolveModeratorJourney: async () =>
        mode === "authorized"
          ? { kind: "authorized", campaignId, userId, funnelSessionId, email }
          : { kind: "unavailable" },
      scheduleAfter: (() => {
        sideEffects++
      }) as typeof import("next/server").after,
      enqueueMetaLead: () => {
        sideEffects++
        return true
      },
      bindPersonalPlanFieldTestLead: async () => {
        sideEffects++
        return true
      },
      issueResultReturn: async () => {
        sideEffects++
        return { issued: true }
      },
      recordFunnelEvent: async () => true,
    })
  const req = () =>
    new Request("https://chaarlie.de/api/quiz/personal-plan-lead", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    })
  try {
    assert.equal((await handler("authorized")(req())).status, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], "save_personal_plan_moderator_lead_with_artifact")
    assert.equal(calls[0][1].p_user_id, userId)
    assert.equal(calls[0][1].p_confirmed_email, "plan@example.com")
    assert.equal(calls[0][1].p_campaign_id, campaignId)
    assert.equal(calls[0][1].p_funnel_session_id, funnelSessionId)
    assert.equal(sideEffects, 0)
    assert.equal((await handler("authorized", "other@example.com")(req())).status, 403)
    assert.equal((await handler("unavailable")(req())).status, 503)
    assert.equal(calls.length, 1)
  } finally {
    if (previousQuiz === undefined) delete process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED
    else process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED = previousQuiz
    if (previousReturn === undefined) delete process.env.PERSONAL_PLAN_RESULT_RETURN_ENABLED
    else process.env.PERSONAL_PLAN_RESULT_RETURN_ENABLED = previousReturn
  }
})

// --- PR6 Codex review, finding V1 (CRITICAL) --------------------------------
//
// `save_personal_plan_lead_with_artifact` DEDUPLICATES: an identical
// (e-mail, canonical answers) submission inside 15 minutes returns the EXISTING
// lead with `reused = true` instead of inserting one (migration
// 20260728130000, "leads.created_at >= now() - interval '15 minutes'"), and so
// does a replayed artifact claim. Minting the free-registration correction
// capability on that response handed an attacker who submits a victim's address
// with matching answers the VICTIM's lead id together with authority to repoint
// that lead at the attacker's own address.
test("ATTACK V1: a REUSED lead never receives a free-registration correction capability", async () => {
  const previousQuizFlag = process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED
  const previousSecret = process.env.FUNNEL_COOKIE_SIGNING_SECRET
  process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED = "true"
  process.env.FUNNEL_COOKIE_SIGNING_SECRET = "v1-attack-test-signing-secret-long-enough"

  const VICTIM_LEAD_ID = "10000000-0000-4000-8000-000000000011"
  const createHandler = (reused: boolean | undefined) =>
    createPersonalPlanLeadPostHandler({
      resolveModeratorJourney: async () => ({ kind: "ordinary" }),
      checkRateLimit: async () => ({ allowed: true }),
      checkEmailDeliverability: async () => ({
        ok: true,
        normalized: "opfer@example.com",
        outcome: "mx",
      }),
      recordEmailDeliverabilityOutcome: () => {},
      cookies: (async () => ({ get: () => undefined })) as typeof import("next/headers").cookies,
      scheduleAfter: (() => undefined) as typeof import("next/server").after,
      enqueueMetaLead: () => true,
      isFreemiumScannerFirstEnabled: () => true,
      createAdminClient: (() => ({
        rpc: async () => ({
          data: [
            reused === undefined
              ? { lead_id: VICTIM_LEAD_ID }
              : { lead_id: VICTIM_LEAD_ID, reused },
          ],
          error: null,
        }),
      })) as unknown as typeof import("../src/lib/supabase/admin").createAdminClient,
    })

  const post = (handler: ReturnType<typeof createPersonalPlanLeadPostHandler>) =>
    handler(
      new Request("https://chaarlie.de/api/quiz/personal-plan-lead", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
        body: JSON.stringify(request),
      }),
    )

  try {
    // The attacker's replay: the RPC hands back the victim's lead.
    const reusedBody = (await (await post(createHandler(true))).json()) as Record<string, unknown>
    assert.equal(reusedBody.leadId, VICTIM_LEAD_ID)
    assert.equal(
      "freeRegistrationCapability" in reusedBody,
      false,
      "a reused lead must carry NO correction capability",
    )

    // Fail closed: a response that does not report `reused` at all is treated
    // as reused rather than as a fresh lead.
    const silentBody = (await (await post(createHandler(undefined))).json()) as Record<
      string,
      unknown
    >
    assert.equal("freeRegistrationCapability" in silentBody, false)

    // The genuine completing browser still gets one.
    const freshBody = (await (await post(createHandler(false))).json()) as Record<string, unknown>
    assert.equal(freshBody.leadId, VICTIM_LEAD_ID)
    assert.equal(typeof freshBody.freeRegistrationCapability, "string")
  } finally {
    if (previousQuizFlag === undefined) delete process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED
    else process.env.PERSONAL_PLAN_QUIZ_V1_ENABLED = previousQuizFlag
    if (previousSecret === undefined) delete process.env.FUNNEL_COOKIE_SIGNING_SECRET
    else process.env.FUNNEL_COOKIE_SIGNING_SECRET = previousSecret
  }
})
