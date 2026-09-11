import assert from "node:assert/strict"
import test from "node:test"
import { NextRequest } from "next/server"

import { createUpdateSession, type UpdateSessionDependencies } from "../src/lib/supabase/middleware"

const completeQuizProfile = {
  hair_texture: "wavy",
  thickness: "normal",
  density: "medium",
  cuticle_condition: "slightly_rough",
  protein_moisture_balance: "balanced",
  scalp_type: "normal",
  scalp_condition: null,
  chemical_treatment: ["none"],
  concerns: [],
}
const fieldTestUserId = "00000000-0000-4000-8000-000000000001"

type RoutinePlanResult =
  | {
      data: { pending_routine_proposal_id: string | null; active_routine_version_id: string | null }
      error: null
    }
  | { data: null; error: { message: string } }

function createMiddleware({
  currentAccess = true,
  paidAccess = false,
  frontierResult = { data: { eligible: false, source_ready: false, plan: null }, error: null },
  planResult = {
    data: { pending_routine_proposal_id: "proposal-1", active_routine_version_id: null },
    error: null,
  },
  throwsOnPlanLookup = false,
  useDefaultFrontier = false,
  userAppMetadata = { access_kind: "field_test" },
  moderatorAccess = "none",
  oneTimeAccessState = "none",
  hairProfile = completeQuizProfile as Record<string, unknown> | null,
  observedTables,
  frontierCalls,
}: {
  currentAccess?: boolean
  paidAccess?: boolean
  frontierResult?: {
    data: {
      eligible: boolean
      source_ready: boolean
      plan: null | {
        current_initial_need_version_id: string | null
        current_refined_need_version_id: string | null
        pending_routine_proposal_id: string | null
        active_routine_version_id: string | null
      }
    } | null
    error: null | { message: string }
  }
  planResult?: RoutinePlanResult
  throwsOnPlanLookup?: boolean
  useDefaultFrontier?: boolean
  userAppMetadata?: Record<string, unknown>
  moderatorAccess?: "active" | "ended" | "none" | "unavailable"
  oneTimeAccessState?: "none" | "paid_pending" | "active" | "revoked"
  hairProfile?: Record<string, unknown> | null
  observedTables?: string[]
  frontierCalls?: { count: number }
} = {}) {
  const fakeSupabase = {
    auth: {
      getUser: async () => ({
        data: {
          user: {
            id: fieldTestUserId,
            email: "field-test@example.com",
            app_metadata: userAppMetadata,
          },
        },
      }),
      admin: {
        async getUserById() {
          return { data: { user: null }, error: { status: 403, message: "forbidden" } }
        },
      },
    },
    rpc: async () => ({
      data: {
        qualified_at: "2026-08-12T12:00:00.000Z",
        quiz_source_kind: "personal_plan",
        plan: {
          current_initial_need_version_id: "initial-1",
          current_refined_need_version_id: null,
          pending_routine_proposal_id: null,
          active_routine_version_id: null,
        },
      },
      error: null,
    }),
    from(table: string) {
      observedTables?.push(table)
      return {
        select(columns?: string) {
          return {
            eq() {
              if (table === "personal_plan_test_enrollments") {
                return {
                  eq() {
                    return {
                      maybeSingle: async () => ({ data: null, error: null }),
                    }
                  },
                }
              }
              return {
                maybeSingle: async () => {
                  if (table === "profiles") {
                    return {
                      data:
                        columns === "is_admin"
                          ? { is_admin: false }
                          : { onboarding_completed: false },
                    }
                  }
                  if (table === "hair_profiles") {
                    return { data: hairProfile }
                  }
                  if (table === "personal_plans") {
                    if (throwsOnPlanLookup) throw new Error("personal plan lookup unavailable")
                    return planResult
                  }
                  throw new Error(`unexpected table: ${table}`)
                },
              }
            },
          }
        },
      }
    },
  }

  const dependencies: UpdateSessionDependencies = {
    createServerClient: (() =>
      fakeSupabase) as unknown as UpdateSessionDependencies["createServerClient"],
    hasCurrentAppAccess: (async () =>
      currentAccess) as UpdateSessionDependencies["hasCurrentAppAccess"],
    hasCurrentPaidAppAccess: (async () =>
      paidAccess) as UpdateSessionDependencies["hasCurrentPaidAppAccess"],
    resolveOneTimeAccessState: (async () =>
      oneTimeAccessState) as UpdateSessionDependencies["resolveOneTimeAccessState"],
    resolveModeratorAccess: (async () =>
      moderatorAccess) as UpdateSessionDependencies["resolveModeratorAccess"],
    getRouteEnvironment: () => ({ nodeEnv: "test", localDevLoginEnabled: false }),
    ...(useDefaultFrontier
      ? {}
      : {
          loadPersonalPlanRoutingFrontier: async () => {
            if (frontierCalls) frontierCalls.count += 1
            if (frontierResult.error) throw frontierResult.error
            const data = frontierResult.data
            if (!data?.eligible) return { kind: "legacy" }
            if (!data.source_ready) return { kind: "recovery", nextHref: "/plan-bereit" }
            if (!data.plan)
              return { kind: "personal_plan", frontier: "stage1", nextHref: "/plan-start" }
            if (data.plan.active_routine_version_id) {
              return { kind: "personal_plan", frontier: "stage5", nextHref: "/anwendung" }
            }
            if (data.plan.pending_routine_proposal_id) {
              return { kind: "personal_plan", frontier: "stage4", nextHref: "/routine" }
            }
            return { kind: "personal_plan", frontier: "stage3", nextHref: "/plan-start" }
          },
        }),
  }

  return createUpdateSession(dependencies)
}

test("released routing ignores obsolete internal rollout environment", async () => {
  const originalFetch = globalThis.fetch
  const environment = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "PERSONAL_PLAN_APP_V1_ENABLED",
    "PERSONAL_PLAN_APP_V1_ROLLOUT",
    "PERSONAL_PLAN_APP_V1_INTERNAL_EMAILS",
    "PERSONAL_PLAN_APP_V1_NEW_BUYER_CUTOFF",
  ] as const
  const previous = new Map(environment.map((key) => [key, process.env[key]]))
  const requests: Array<{ url: string; authorization: string | null }> = []

  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key"
  process.env.PERSONAL_PLAN_APP_V1_ENABLED = "false"
  process.env.PERSONAL_PLAN_APP_V1_ROLLOUT = "internal"
  process.env.PERSONAL_PLAN_APP_V1_INTERNAL_EMAILS = "field-test@example.com"
  process.env.PERSONAL_PLAN_APP_V1_NEW_BUYER_CUTOFF = "2026-08-12T12:00:00.000Z"
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, authorization: new Headers(init?.headers).get("Authorization") })
    if (url.includes("/rest/v1/profiles")) {
      return Response.json([{ is_admin: false }])
    }
    if (url.includes("/rest/v1/personal_plan_test_enrollments")) {
      return Response.json([])
    }
    if (url.includes(`/auth/v1/admin/users/${fieldTestUserId}`)) {
      return Response.json({
        user: {
          id: fieldTestUserId,
          email: "field-test@example.com",
          email_confirmed_at: "2026-08-12T12:00:00.000Z",
        },
      })
    }
    throw new Error(`unexpected server eligibility request: ${url}`)
  }) as typeof fetch

  try {
    const response = await createMiddleware({ useDefaultFrontier: true })(
      new NextRequest("https://chaarlie.de/routine"),
    )

    assert.equal(response.status, 307)
    assert.equal(response.headers.get("location"), "https://chaarlie.de/plan-start")
    assert.ok(requests.every(({ url }) => !url.includes(`/auth/v1/admin/users/${fieldTestUserId}`)))
    assert.ok(requests.every(({ url }) => !url.includes("/rest/v1/profiles")))
    assert.ok(
      requests.every(({ authorization }) => authorization === "Bearer test-service-role-key"),
    )
  } finally {
    globalThis.fetch = originalFetch
    for (const key of environment) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("field-test user with current access and a pending proposal reaches /routine", async () => {
  const observedTables: string[] = []
  const response = await createMiddleware({ observedTables })(
    new NextRequest("https://chaarlie.de/routine"),
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get("location"), null)
  assert.ok(observedTables.includes("profiles"))
  assert.ok(observedTables.includes("hair_profiles"))
})

test("tracker skips proxy intake and Personal Plan frontier reads", async () => {
  const observedTables: string[] = []
  const frontierCalls = { count: 0 }
  const response = await createMiddleware({ observedTables, frontierCalls })(
    new NextRequest("https://chaarlie.de/tracker"),
  )

  assert.equal(response.status, 200)
  assert.ok(!observedTables.includes("profiles"))
  assert.ok(!observedTables.includes("hair_profiles"))
  assert.equal(frontierCalls.count, 0)
})

test("tracker still redirects an authenticated user without current access to reactivate", async () => {
  const observedTables: string[] = []
  const frontierCalls = { count: 0 }
  const response = await createMiddleware({
    currentAccess: false,
    userAppMetadata: {},
    observedTables,
    frontierCalls,
  })(new NextRequest("https://chaarlie.de/tracker"))

  assert.equal(response.status, 307)
  assert.equal(
    response.headers.get("location"),
    "https://chaarlie.de/reactivate?reason=expired&next=%2Ftracker",
  )
  assert.ok(!observedTables.includes("profiles"))
  assert.ok(!observedTables.includes("hair_profiles"))
  assert.equal(frontierCalls.count, 0)
})

// --- Freemium scanner-first flag (T2), end-to-end through createUpdateSession ---

test("flag off: FREEMIUM_SCANNER_FIRST_ENABLED unset still redirects tracker to reactivate (byte-identical)", async () => {
  const original = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  try {
    const response = await createMiddleware({
      currentAccess: false,
      userAppMetadata: {},
    })(new NextRequest("https://chaarlie.de/tracker"))

    assert.equal(response.status, 307)
    assert.equal(
      response.headers.get("location"),
      "https://chaarlie.de/reactivate?reason=expired&next=%2Ftracker",
    )
  } finally {
    if (original === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = original
  }
})

test("flag on: a free authenticated user (no current access) reaches /tracker instead of being sent to reactivate", async () => {
  const original = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  process.env.FREEMIUM_SCANNER_FIRST_ENABLED = "true"
  try {
    const response = await createMiddleware({
      currentAccess: false,
      userAppMetadata: {},
    })(new NextRequest("https://chaarlie.de/tracker"))

    assert.equal(response.status, 200)
    assert.equal(response.headers.get("location"), null)
  } finally {
    if (original === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = original
  }
})

test("flag on: a free authenticated user without current access is still gated on a non-admitted route (POST /api/chat stays subscription_required)", async () => {
  const original = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  process.env.FREEMIUM_SCANNER_FIRST_ENABLED = "true"
  try {
    for (const request of [
      new NextRequest("https://chaarlie.de/api/chat", { method: "POST" }),
      new NextRequest("https://chaarlie.de/api/chat/conversation-1", { method: "DELETE" }),
      new NextRequest("https://chaarlie.de/api/chat/feedback", { method: "POST" }),
      new NextRequest("https://chaarlie.de/api/chat/trigger", { method: "POST" }),
      new NextRequest("https://chaarlie.de/api/chat/product-selection", { method: "POST" }),
      new NextRequest("https://chaarlie.de/api/profile"),
    ]) {
      const response = await createMiddleware({
        currentAccess: false,
        userAppMetadata: {},
      })(request)

      assert.equal(response.status, 403, `${request.method} ${request.nextUrl.pathname}`)
      const body = await response.json()
      assert.deepEqual(body, { error: "subscription_required" })
    }
  } finally {
    if (original === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = original
  }
})

// T17 keepsake reads: a lapsed owner's own conversation history has to stay readable on
// `/chat/[conversationId]`, which needs `GET /api/chat` and `GET /api/chat/[id]`. The
// carve-out is scoped by METHOD, deliberately NOT by adding `/api/chat` to
// `FREEMIUM_ADMITTED_ROUTE_PREFIXES` — that would admit the streaming POST too, since no
// route under this prefix carries an in-route entitlement guard (enforcement-matrix.md).
// Both reads are session-scoped and owner-filtered, so a never-paid user reaching them
// sees only their own (empty) history.
test("flag on: GET /api/chat and GET /api/chat/[id] are admitted for keepsake reads (T17)", async () => {
  const original = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  process.env.FREEMIUM_SCANNER_FIRST_ENABLED = "true"
  try {
    for (const pathname of ["/api/chat", "/api/chat/conversation-1"]) {
      const response = await createMiddleware({
        currentAccess: false,
        userAppMetadata: {},
      })(new NextRequest(`https://chaarlie.de${pathname}`))

      assert.equal(response.status, 200, pathname)
      assert.equal(response.headers.get("location"), null, pathname)
    }
  } finally {
    if (original === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = original
  }
})

test("flag off: GET /api/chat is still subscription_required (byte-identical)", async () => {
  const original = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  try {
    const response = await createMiddleware({
      currentAccess: false,
      userAppMetadata: {},
    })(new NextRequest("https://chaarlie.de/api/chat"))

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: "subscription_required" })
  } finally {
    if (original === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = original
  }
})

test("flag on: a free authenticated user reaches the /scan page shell without being bounced to onboarding", async () => {
  const original = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  process.env.FREEMIUM_SCANNER_FIRST_ENABLED = "true"
  try {
    const observedTables: string[] = []
    const response = await createMiddleware({
      currentAccess: false,
      userAppMetadata: {},
      observedTables,
    })(new NextRequest("https://chaarlie.de/scan"))

    assert.equal(response.status, 200)
    assert.equal(response.headers.get("location"), null)
    // No personal_plans routine lookup is needed to admit this free user —
    // the /scan bypass is now entitlement-independent under the flag.
    assert.ok(!observedTables.includes("personal_plans"))
  } finally {
    if (original === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = original
  }
})

test("flag on: needs_onboarding + no paid access reaches /anwendung without being bounced to onboarding", async () => {
  const original = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  process.env.FREEMIUM_SCANNER_FIRST_ENABLED = "true"
  try {
    // Default hairProfile (complete) + default profile.onboarding_completed
    // false resolves to intakeState "needs_onboarding". No paid access at
    // all: no current app access, no one-time purchase, no moderator grant.
    const response = await createMiddleware({
      currentAccess: false,
      userAppMetadata: {},
      oneTimeAccessState: "none",
      moderatorAccess: "none",
    })(new NextRequest("https://chaarlie.de/anwendung"))

    assert.equal(response.status, 200)
    assert.equal(response.headers.get("location"), null)
  } finally {
    if (original === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = original
  }
})

test("flag on: a one-time-access owner (active, but hasCurrentAppAccess false) at needs_onboarding is still redirected to /onboarding from /anwendung (I1 regression)", async () => {
  const original = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  process.env.FREEMIUM_SCANNER_FIRST_ENABLED = "true"
  try {
    // This mirrors the flag-OFF outcome exactly: a paying one-time-access
    // owner who hasn't finished legacy onboarding must not be admitted by
    // the freemium exemption just because the underlying `active` (current
    // app access) boolean happens to be false.
    const response = await createMiddleware({
      currentAccess: false,
      userAppMetadata: {},
      oneTimeAccessState: "active",
      moderatorAccess: "none",
    })(new NextRequest("https://chaarlie.de/anwendung"))

    assert.equal(response.status, 307)
    assert.equal(response.headers.get("location"), "https://chaarlie.de/onboarding")
  } finally {
    if (original === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = original
  }
})

test("flag off: a one-time-access owner at needs_onboarding is redirected to /onboarding from /anwendung (baseline)", async () => {
  const original = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  try {
    const response = await createMiddleware({
      currentAccess: false,
      userAppMetadata: {},
      oneTimeAccessState: "active",
      moderatorAccess: "none",
    })(new NextRequest("https://chaarlie.de/anwendung"))

    assert.equal(response.status, 307)
    assert.equal(response.headers.get("location"), "https://chaarlie.de/onboarding")
  } finally {
    if (original === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = original
  }
})

test("chat retains proxy intake and preserves redirect query parameters", async () => {
  const observedTables: string[] = []
  const frontierCalls = { count: 0 }
  const response = await createMiddleware({
    planResult: {
      data: { pending_routine_proposal_id: null, active_routine_version_id: null },
      error: null,
    },
    observedTables,
    frontierCalls,
  })(new NextRequest("https://chaarlie.de/chat?lead=lead-1&tab=history"))

  assert.equal(response.status, 307)
  assert.equal(
    response.headers.get("location"),
    "https://chaarlie.de/onboarding?lead=lead-1&tab=history",
  )
  assert.ok(observedTables.includes("profiles"))
  assert.ok(observedTables.includes("hair_profiles"))
  assert.equal(frontierCalls.count, 1)
})

test("a pending proposal does not grant /anwendung before an active routine exists", async () => {
  const response = await createMiddleware()(new NextRequest("https://chaarlie.de/anwendung"))

  assert.equal(response.status, 307)
  assert.equal(response.headers.get("location"), "https://chaarlie.de/onboarding")
})

test("field-test access fails closed when the app-access check is false", async () => {
  const response = await createMiddleware({ currentAccess: false })(
    new NextRequest("https://chaarlie.de/routine"),
  )

  assert.equal(response.status, 307)
  assert.equal(response.headers.get("location"), "https://chaarlie.de/test/haarplan/beendet")
})

test("email-bound moderator access reaches gated app routes without a synthetic guest marker", async () => {
  const response = await createMiddleware({
    currentAccess: false,
    userAppMetadata: {},
    moderatorAccess: "active",
  })(new NextRequest("https://chaarlie.de/tracker"))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get("location"), null)
})

test("an ended moderator account receives the field-test end state unless paid access is valid", async () => {
  const response = await createMiddleware({
    currentAccess: false,
    userAppMetadata: {},
    moderatorAccess: "ended",
  })(new NextRequest("https://chaarlie.de/routine"))

  assert.equal(response.status, 307)
  assert.equal(response.headers.get("location"), "https://chaarlie.de/test/haarplan/beendet")
})

test("an ended moderator cannot retain access through its still-active tester grant", async () => {
  const response = await createMiddleware({
    currentAccess: true,
    paidAccess: false,
    userAppMetadata: {},
    moderatorAccess: "ended",
  })(new NextRequest("https://chaarlie.de/chat"))

  assert.equal(response.status, 307)
  assert.equal(response.headers.get("location"), "https://chaarlie.de/test/haarplan/beendet")
})

test("an unavailable moderator lookup with only its tester grant returns unavailable", async () => {
  const response = await createMiddleware({
    currentAccess: true,
    paidAccess: false,
    userAppMetadata: {},
    moderatorAccess: "unavailable",
  })(new NextRequest("https://chaarlie.de/chat"))

  assert.equal(response.status, 503)
})

test("an ended moderator with independently verified paid access remains admitted", async () => {
  const response = await createMiddleware({
    currentAccess: true,
    paidAccess: true,
    userAppMetadata: {},
    moderatorAccess: "ended",
  })(new NextRequest("https://chaarlie.de/tracker"))

  assert.equal(response.status, 200)
})

test("a moderator access lookup outage is unavailable rather than an expiry or paywall", async () => {
  const page = await createMiddleware({
    currentAccess: false,
    userAppMetadata: {},
    moderatorAccess: "unavailable",
  })(new NextRequest("https://chaarlie.de/routine"))
  assert.equal(page.status, 503)
  assert.match(await page.text(), /Zugang wird gerade geprüft/)

  const api = await createMiddleware({
    currentAccess: false,
    userAppMetadata: {},
    moderatorAccess: "unavailable",
  })(new NextRequest("https://chaarlie.de/api/routine"))
  assert.equal(api.status, 503)
  assert.deepEqual(await api.json(), { error: "moderator_access_unavailable" })
})

test("a personal-plan lookup error preserves legacy onboarding protection", async () => {
  const response = await createMiddleware({
    planResult: { data: null, error: { message: "database unavailable" } },
  })(new NextRequest("https://chaarlie.de/routine"))

  assert.equal(response.status, 307)
  assert.equal(response.headers.get("location"), "https://chaarlie.de/onboarding")
})

test("a thrown personal-plan lookup preserves legacy onboarding protection", async () => {
  const response = await createMiddleware({ throwsOnPlanLookup: true })(
    new NextRequest("https://chaarlie.de/routine"),
  )

  assert.equal(response.status, 307)
  assert.equal(response.headers.get("location"), "https://chaarlie.de/onboarding")
})

test("an eligible new buyer follows the Personal Plan frontier instead of legacy onboarding", async () => {
  const response = await createMiddleware({
    frontierResult: {
      data: { eligible: true, source_ready: true, plan: null },
      error: null,
    },
  })(new NextRequest("https://chaarlie.de/routine"))

  assert.equal(response.status, 307)
  assert.equal(response.headers.get("location"), "https://chaarlie.de/plan-start")
})

test("a Stage 1 frontier no longer bounces chat into the Personal Plan flow", async () => {
  const response = await createMiddleware({
    frontierResult: {
      data: { eligible: true, source_ready: true, plan: null },
      error: null,
    },
  })(new NextRequest("https://chaarlie.de/chat"))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get("location"), null)
})

test("an activated moderator returns to the saved plan instead of legacy onboarding", async () => {
  const response = await createMiddleware({
    userAppMetadata: {},
    moderatorAccess: "active",
    frontierResult: {
      data: { eligible: true, source_ready: true, plan: null },
      error: null,
    },
  })(new NextRequest("https://chaarlie.de/chat"))

  assert.equal(response.status, 307)
  assert.equal(response.headers.get("location"), "https://chaarlie.de/plan-start")
})

test("an activated moderator return stays in recovery while its plan is not ready", async () => {
  const response = await createMiddleware({
    userAppMetadata: {},
    moderatorAccess: "active",
    frontierResult: {
      data: { eligible: true, source_ready: false, plan: null },
      error: null,
    },
  })(new NextRequest("https://chaarlie.de/chat"))

  assert.equal(response.headers.get("location"), "https://chaarlie.de/plan-bereit")
})

test("an activated moderator return cannot fall through to legacy onboarding on a routing outage", async () => {
  const response = await createMiddleware({
    userAppMetadata: {},
    moderatorAccess: "active",
    frontierResult: { data: null, error: { message: "routing source unavailable" } },
  })(new NextRequest("https://chaarlie.de/chat"))

  assert.equal(response.status, 503)
  assert.equal(response.headers.get("location"), null)
})

test("an eligible buyer with an unready source stays in readiness recovery", async () => {
  const response = await createMiddleware({
    frontierResult: {
      data: { eligible: true, source_ready: false, plan: null },
      error: null,
    },
  })(new NextRequest("https://chaarlie.de/routine"))

  assert.equal(response.status, 307)
  assert.equal(response.headers.get("location"), "https://chaarlie.de/plan-bereit")
})

test("a routing-frontier outage cannot silently fall through to legacy onboarding", async () => {
  const response = await createMiddleware({
    frontierResult: {
      data: null,
      error: { message: "routing source unavailable" },
    },
  })(new NextRequest("https://chaarlie.de/routine"))

  assert.equal(response.status, 503)
  assert.equal(response.headers.get("location"), null)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  assert.match(await response.text(), /Bitte versuche es gleich noch einmal/)
})

test("a routing-frontier outage leaves chat to the intake gate", async () => {
  const outage = {
    frontierResult: {
      data: null,
      error: { message: "routing source unavailable" },
    },
  } as const

  const withRoutine = await createMiddleware(outage)(new NextRequest("https://chaarlie.de/chat"))
  assert.equal(withRoutine.status, 200)
  assert.equal(withRoutine.headers.get("location"), null)

  const withoutRoutine = await createMiddleware({
    ...outage,
    planResult: {
      data: { pending_routine_proposal_id: null, active_routine_version_id: null },
      error: null,
    },
  })(new NextRequest("https://chaarlie.de/chat"))
  assert.equal(withoutRoutine.status, 307)
  assert.equal(withoutRoutine.headers.get("location"), "https://chaarlie.de/onboarding")
})

test("chat stays reachable across the Personal Plan frontier", async () => {
  const activeRoutinePlan = {
    data: { pending_routine_proposal_id: null, active_routine_version_id: "routine-1" },
    error: null,
  } as const
  const stage5Frontier = {
    data: {
      eligible: true,
      source_ready: true,
      plan: {
        current_initial_need_version_id: "initial-1",
        current_refined_need_version_id: "refined-1",
        pending_routine_proposal_id: null,
        active_routine_version_id: "routine-1",
      },
    },
    error: null,
  } as const
  const stage4Frontier = {
    data: {
      eligible: true,
      source_ready: true,
      plan: {
        current_initial_need_version_id: "initial-1",
        current_refined_need_version_id: "refined-1",
        pending_routine_proposal_id: "proposal-1",
        active_routine_version_id: null,
      },
    },
    error: null,
  } as const

  const activeRoutine = await createMiddleware({
    frontierResult: stage5Frontier,
    planResult: activeRoutinePlan,
  })(new NextRequest("https://chaarlie.de/chat"))
  assert.equal(activeRoutine.status, 200)
  assert.equal(activeRoutine.headers.get("location"), null)

  const pendingRoutine = await createMiddleware({ frontierResult: stage4Frontier })(
    new NextRequest("https://chaarlie.de/chat"),
  )
  assert.equal(pendingRoutine.status, 200)
  assert.equal(pendingRoutine.headers.get("location"), null)

  for (const frontierResult of [stage4Frontier, stage5Frontier]) {
    const moderatorChat = await createMiddleware({
      userAppMetadata: {},
      moderatorAccess: "active",
      frontierResult,
      planResult: activeRoutinePlan,
    })(new NextRequest("https://chaarlie.de/chat"))
    assert.equal(moderatorChat.status, 200)
    assert.equal(moderatorChat.headers.get("location"), null)
  }

  const recoveryFrontier = await createMiddleware({
    frontierResult: { data: { eligible: true, source_ready: false, plan: null }, error: null },
    planResult: activeRoutinePlan,
  })(new NextRequest("https://chaarlie.de/chat"))
  assert.equal(recoveryFrontier.status, 200)
  assert.equal(recoveryFrontier.headers.get("location"), null)
})

test("chat without a routine pointer, quiz or entitlement keeps the intake gate", async () => {
  const entitledWithoutRoutine = await createMiddleware({
    frontierResult: {
      data: { eligible: true, source_ready: false, plan: null },
      error: null,
    },
    planResult: {
      data: { pending_routine_proposal_id: null, active_routine_version_id: null },
      error: null,
    },
  })(new NextRequest("https://chaarlie.de/chat"))
  assert.equal(entitledWithoutRoutine.status, 307)
  assert.equal(entitledWithoutRoutine.headers.get("location"), "https://chaarlie.de/onboarding")

  const needsQuiz = await createMiddleware({ hairProfile: null })(
    new NextRequest("https://chaarlie.de/chat"),
  )
  assert.equal(needsQuiz.status, 307)
  assert.equal(needsQuiz.headers.get("location"), "https://chaarlie.de/quiz")

  const withoutEntitlement = await createMiddleware({ userAppMetadata: {} })(
    new NextRequest("https://chaarlie.de/chat"),
  )
  assert.equal(withoutEntitlement.status, 307)
  assert.equal(withoutEntitlement.headers.get("location"), "https://chaarlie.de/onboarding")
})

test("explicit legacy onboarding edits are not intercepted by the Personal Plan frontier", async () => {
  const response = await createMiddleware({
    frontierResult: {
      data: { eligible: true, source_ready: true, plan: null },
      error: null,
    },
  })(
    new NextRequest(
      "https://chaarlie.de/onboarding?step=products&editMode=profile&returnTo=%2Fprofile",
    ),
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get("location"), null)
})

test("synthetic guest access does not depend on the unrelated moderator membership lookup", async () => {
  const response = await createMiddleware({ currentAccess: true, moderatorAccess: "unavailable" })(
    new NextRequest("https://chaarlie.de/tracker"),
  )
  assert.equal(response.status, 200)
})
