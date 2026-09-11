import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  buildAddressRateLimitKey,
  buildFreeRegistrationEmailRedirect,
  buildFreeRegistrationRecoveryPath,
  isFreeRegistrationConfirmRequest,
  requestFreeRegistrationLink,
  resolveQuizCompletionDestination,
  resolveFreeRegistrationBind,
  resolveFreeRegistrationConfirmContext,
  type FreeRegistrationDependencies,
  type FreeRegistrationLead,
  type FreeRegistrationRateDimension,
} from "../src/lib/auth/free-registration"
import {
  issueFreeRegistrationCapability,
  verifyFreeRegistrationCapability,
  FREE_REGISTRATION_CAPABILITY_TTL_MS,
} from "../src/lib/auth/free-registration-capability"
import { createFreeRegistrationPostHandler } from "../src/app/api/auth/free-registration/route"
import { classifyRoute } from "../src/lib/auth/route-classification"

const LEAD_ID = "11111111-1111-4111-8111-111111111111"
const SITE_URL = "https://app.test"

type Recorder = {
  sent: { email: string; emailRedirectTo: string }[]
  leadEmailWrites: { leadId: string; email: string }[]
  rateLimitKeys: string[]
  rateLimitCalls: { dimension: FreeRegistrationRateDimension; identifier: string }[]
  capabilityChecks: { token: unknown; leadId: string }[]
  provenanceMarks: string[]
}

/** A correction is authorized by default; individual tests take it away. */
const VALID_CAPABILITY = "valid-capability"

function createDeps(
  overrides: Partial<FreeRegistrationDependencies> & { lead?: FreeRegistrationLead | null } = {},
): { deps: FreeRegistrationDependencies; recorder: Recorder } {
  const recorder: Recorder = {
    sent: [],
    leadEmailWrites: [],
    rateLimitKeys: [],
    rateLimitCalls: [],
    capabilityChecks: [],
    provenanceMarks: [],
  }
  const lead: FreeRegistrationLead | null =
    overrides.lead === undefined
      ? { id: LEAD_ID, email: "lena@example.com", quizKind: "personal_plan", userId: null }
      : overrides.lead
  const mutableLead = lead ? { ...lead } : null

  const deps: FreeRegistrationDependencies = {
    siteUrl: SITE_URL,
    async checkRateLimit({ dimension, identifier }) {
      recorder.rateLimitCalls.push({ dimension, identifier })
      if (dimension === "lead") recorder.rateLimitKeys.push(identifier)
      return { allowed: true }
    },
    async loadLead() {
      return mutableLead
    },
    async updateLeadEmail(leadId, email) {
      recorder.leadEmailWrites.push({ leadId, email })
      if (!mutableLead || mutableLead.userId) return { updated: false }
      mutableLead.email = email
      return { updated: true }
    },
    async markFreeRegistrationLead(leadId) {
      recorder.provenanceMarks.push(leadId)
      return { marked: Boolean(mutableLead && !mutableLead.userId) }
    },
    async checkEmailDeliverability(email) {
      return { ok: true, normalized: email }
    },
    verifyCorrectionCapability(token, leadId) {
      recorder.capabilityChecks.push({ token, leadId })
      return token === VALID_CAPABILITY
    },
    async sendMagicLink(input) {
      recorder.sent.push(input)
      return { error: null }
    },
    ...overrides,
  }
  return { deps, recorder }
}

test("the free-registration link points /auth/confirm at the exact lead and the /scan landing", () => {
  assert.equal(
    buildFreeRegistrationEmailRedirect(SITE_URL, LEAD_ID),
    `https://app.test/auth/confirm?free=1&lead=${LEAD_ID}&next=%2Fscan`,
  )
  // Trailing slashes on the configured site URL must not double up.
  assert.equal(
    buildFreeRegistrationEmailRedirect(`${SITE_URL}/`, LEAD_ID),
    `https://app.test/auth/confirm?free=1&lead=${LEAD_ID}&next=%2Fscan`,
  )
  assert.equal(
    isFreeRegistrationConfirmRequest(new URLSearchParams(`free=1&lead=${LEAD_ID}`)),
    true,
  )
  assert.equal(isFreeRegistrationConfirmRequest(new URLSearchParams(`lead=${LEAD_ID}`)), false)
  assert.equal(
    buildFreeRegistrationRecoveryPath(LEAD_ID),
    `/registrierung?lead=${LEAD_ID}&error=link_expired`,
  )
  assert.equal(buildFreeRegistrationRecoveryPath("not-a-uuid"), "/registrierung?error=link_expired")
})

test("flag off keeps the quiz-completion destination byte-identical; flag on routes to registration", () => {
  assert.equal(
    resolveQuizCompletionDestination({ leadId: LEAD_ID, freemiumScannerFirstEnabled: false }),
    `/result/${LEAD_ID}/reveal`,
  )
  assert.equal(
    resolveQuizCompletionDestination({ leadId: LEAD_ID, freemiumScannerFirstEnabled: true }),
    "/registrierung",
  )
})

test("a first send goes to the lead's own address and never rewrites the lead", async () => {
  const { deps, recorder } = createDeps()
  const result = await requestFreeRegistrationLink({ leadId: LEAD_ID }, deps)

  assert.deepEqual(result, { outcome: "sent", email: "lena@example.com", corrected: false })
  assert.equal(recorder.sent.length, 1)
  assert.equal(recorder.sent[0].email, "lena@example.com")
  assert.equal(recorder.leadEmailWrites.length, 0)
  assert.deepEqual(recorder.rateLimitKeys, [LEAD_ID])
})

test("resend re-sends to the same address (rate limit consulted every time)", async () => {
  const { deps, recorder } = createDeps()
  await requestFreeRegistrationLink({ leadId: LEAD_ID }, deps)
  const second = await requestFreeRegistrationLink({ leadId: LEAD_ID }, deps)

  assert.equal(second.outcome, "sent")
  assert.equal(recorder.sent.length, 2)
  assert.deepEqual(recorder.rateLimitKeys, [LEAD_ID, LEAD_ID])
})

test("correction rewrites the still-unclaimed lead so the confirm-time lead binding keeps matching", async () => {
  const { deps, recorder } = createDeps()
  const result = await requestFreeRegistrationLink(
    { leadId: LEAD_ID, email: "  Lena.Neu@Example.com ", capability: VALID_CAPABILITY },
    deps,
  )

  assert.deepEqual(result, { outcome: "sent", email: "lena.neu@example.com", corrected: true })
  assert.deepEqual(recorder.leadEmailWrites, [{ leadId: LEAD_ID, email: "lena.neu@example.com" }])
  assert.equal(recorder.sent[0].email, "lena.neu@example.com")
  assert.deepEqual(recorder.capabilityChecks, [{ token: VALID_CAPABILITY, leadId: LEAD_ID }])
})

test("ATTACK W1a: a correction without the quiz-completion capability is refused", async () => {
  // Possession of an unclaimed lead id is exactly what an attacker has — the
  // paid funnel publishes it at `/result/<leadId>/reveal`.
  for (const capability of [undefined, null, "", 42, "forged.capability"]) {
    const { deps, recorder } = createDeps()
    const result = await requestFreeRegistrationLink(
      { leadId: LEAD_ID, email: "angreifer@example.com", capability },
      deps,
    )

    assert.deepEqual(result, { outcome: "correction_not_authorized" }, String(capability))
    // Nothing was rewritten and nothing was mailed to the attacker's address.
    assert.equal(recorder.leadEmailWrites.length, 0)
    assert.equal(recorder.sent.length, 0)
  }
})

test("ATTACK W1a: the refusal never leaks whether the deliverability check would pass", async () => {
  let deliverabilityCalls = 0
  const { deps } = createDeps({
    async checkEmailDeliverability(email) {
      deliverabilityCalls += 1
      return { ok: true, normalized: email }
    },
  })
  await requestFreeRegistrationLink(
    { leadId: LEAD_ID, email: "angreifer@example.com", capability: "forged" },
    deps,
  )
  assert.equal(deliverabilityCalls, 0)
})

test("W1a: a resend to the lead's OWN address still needs no capability", async () => {
  const { deps, recorder } = createDeps()
  const result = await requestFreeRegistrationLink({ leadId: LEAD_ID }, deps)

  assert.equal(result.outcome, "sent")
  assert.equal(recorder.capabilityChecks.length, 0)
  assert.equal(recorder.sent[0].email, "lena@example.com")
})

test("W1a: the capability is signed, lead-bound and expires", () => {
  const secret = "test-signing-secret-that-is-long-enough"
  const other = "22222222-2222-4222-8222-222222222222"
  const now = 1_760_000_000_000
  const token = issueFreeRegistrationCapability(LEAD_ID, { now, secret })
  assert.ok(token)

  assert.equal(verifyFreeRegistrationCapability(token, LEAD_ID, { now, secret }), true)
  // Replayed for a different lead.
  assert.equal(verifyFreeRegistrationCapability(token, other, { now, secret }), false)
  // Signed with somebody else's secret.
  assert.equal(
    verifyFreeRegistrationCapability(token, LEAD_ID, { now, secret: `${secret}-different` }),
    false,
  )
  // Payload edited, signature kept.
  const [payload, signature] = token!.split(".")
  const forgedPayload = Buffer.from(JSON.stringify({ leadId: other, iat: now })).toString(
    "base64url",
  )
  assert.equal(
    verifyFreeRegistrationCapability(`${forgedPayload}.${signature}`, other, { now, secret }),
    false,
  )
  // Aged out, and clock-skewed into the future.
  assert.equal(
    verifyFreeRegistrationCapability(token, LEAD_ID, {
      now: now + FREE_REGISTRATION_CAPABILITY_TTL_MS + 1_000,
      secret,
    }),
    false,
  )
  assert.equal(
    verifyFreeRegistrationCapability(token, LEAD_ID, { now: now - 600_000, secret }),
    false,
  )
  // Malformed and missing inputs.
  for (const bad of [null, undefined, 7, "", "no-dot", `${payload}.${signature}.extra`]) {
    assert.equal(verifyFreeRegistrationCapability(bad, LEAD_ID, { now, secret }), false)
  }
  // No signing secret configured: fail closed in both directions.
  assert.equal(issueFreeRegistrationCapability(LEAD_ID, { now, secret: "" }), null)
  assert.equal(verifyFreeRegistrationCapability(token, LEAD_ID, { now, secret: "" }), false)
})

test("ATTACK W1b: the free confirm branch never binds a foreign lead into an established account", () => {
  // The victim already has a hair profile; the attacker's lead is not theirs.
  assert.equal(
    resolveFreeRegistrationBind({
      leadOwnedByAccount: false,
      hasEstablishedProfile: true,
      leadIsFreeRegistration: true,
    }),
    "skip",
  )
  // A brand-new free account has nothing to lose.
  assert.equal(
    resolveFreeRegistrationBind({
      leadOwnedByAccount: false,
      hasEstablishedProfile: false,
      leadIsFreeRegistration: true,
    }),
    "bind",
  )
  // Re-clicking one's OWN link keeps the same-user retry `canLinkDirectQuizLead` allows.
  assert.equal(
    resolveFreeRegistrationBind({
      leadOwnedByAccount: true,
      hasEstablishedProfile: true,
      leadIsFreeRegistration: true,
    }),
    "bind",
  )
})

test("re-submitting the same address is a resend, not a correction", async () => {
  const { deps, recorder } = createDeps()
  const result = await requestFreeRegistrationLink(
    { leadId: LEAD_ID, email: "LENA@example.com " },
    deps,
  )

  assert.equal(result.outcome, "sent")
  assert.equal(recorder.leadEmailWrites.length, 0)
})

test("an undeliverable correction address is rejected before the lead is rewritten", async () => {
  const { deps, recorder } = createDeps({
    async checkEmailDeliverability() {
      return { ok: false, reason: "no_mx", suggestion: "lena@example.com" }
    },
  })
  const result = await requestFreeRegistrationLink(
    { leadId: LEAD_ID, email: "lena@examplle.com", capability: VALID_CAPABILITY },
    deps,
  )

  assert.deepEqual(result, {
    outcome: "undeliverable_email",
    reason: "no_mx",
    suggestion: "lena@example.com",
  })
  assert.equal(recorder.leadEmailWrites.length, 0)
  assert.equal(recorder.sent.length, 0)
})

test("a lead that already belongs to an account can no longer be re-pointed", async () => {
  const { deps, recorder } = createDeps({
    lead: {
      id: LEAD_ID,
      email: "lena@example.com",
      quizKind: "personal_plan",
      userId: "99999999-9999-4999-8999-999999999999",
    },
  })
  const result = await requestFreeRegistrationLink(
    { leadId: LEAD_ID, email: "angreifer@example.com", capability: VALID_CAPABILITY },
    deps,
  )

  assert.deepEqual(result, { outcome: "lead_claimed" })
  assert.equal(recorder.leadEmailWrites.length, 0)
  assert.equal(recorder.sent.length, 0)
})

test("W5: a lead claimed between the read and the guarded write is a conflict, not a silent success", async () => {
  const { deps, recorder } = createDeps({
    // The read still sees an unclaimed lead; the guarded UPDATE matches nothing.
    async updateLeadEmail(leadId, email) {
      recorder.leadEmailWrites.push({ leadId, email })
      return { updated: false }
    },
  })
  const result = await requestFreeRegistrationLink(
    { leadId: LEAD_ID, email: "lena.neu@example.com", capability: VALID_CAPABILITY },
    deps,
  )

  assert.deepEqual(result, { outcome: "lead_claimed" })
  assert.equal(recorder.leadEmailWrites.length, 1)
  // The decisive assertion: the link never went to an address the lead no
  // longer carries, so the resulting account cannot dead-end.
  assert.equal(recorder.sent.length, 0)
})

test("W4: every send is bounded per lead, per caller IP and per destination address", async () => {
  const { deps, recorder } = createDeps()
  await requestFreeRegistrationLink({ leadId: LEAD_ID, ipAddress: "203.0.113.7" }, deps)

  assert.deepEqual(recorder.rateLimitCalls, [
    { dimension: "lead", identifier: LEAD_ID },
    { dimension: "ip", identifier: "203.0.113.7" },
    { dimension: "address", identifier: "lena@example.com" },
  ])

  // A correction spends the CORRECTED address's budget, not the lead's old one.
  const corrected = createDeps()
  await requestFreeRegistrationLink(
    {
      leadId: LEAD_ID,
      email: "lena.neu@example.com",
      capability: VALID_CAPABILITY,
      ipAddress: "203.0.113.7",
    },
    corrected.deps,
  )
  assert.deepEqual(corrected.recorder.rateLimitCalls.at(-1), {
    dimension: "address",
    identifier: "lena.neu@example.com",
  })
})

// --- N1 (fix round 2): the address rate-limit KEY is alias-canonicalized ---

test("N1: buildAddressRateLimitKey strips a +suffix for every domain", () => {
  assert.equal(buildAddressRateLimitKey("opfer@example.com"), "opfer@example.com")
  assert.equal(buildAddressRateLimitKey("opfer+1@example.com"), "opfer@example.com")
  assert.equal(buildAddressRateLimitKey("opfer+2@example.com"), "opfer@example.com")
  assert.equal(buildAddressRateLimitKey("opfer+anything-here@example.com"), "opfer@example.com")
})

test("N1: buildAddressRateLimitKey additionally collapses dots for Gmail-family domains only", () => {
  assert.equal(buildAddressRateLimitKey("o.p.fer@gmail.com"), "opfer@gmail.com")
  assert.equal(buildAddressRateLimitKey("o.p.fer+x@gmail.com"), "opfer@gmail.com")
  assert.equal(buildAddressRateLimitKey("o.p.fer@googlemail.com"), "opfer@googlemail.com")
  // Dots are significant everywhere else — never collapsed for a non-Gmail domain.
  assert.equal(buildAddressRateLimitKey("o.p.fer@example.com"), "o.p.fer@example.com")
})

test("N1: opfer+1@, opfer+2@, ... all hit the SAME address rate-limit bucket", async () => {
  // This is the exact attack N1 closes: without canonicalization, each
  // plus-alias correction got its own untouched 5/60min bucket, degrading the
  // per-destination cap down to the (much looser) per-IP cap.
  const aliasKeys: string[] = []
  const { deps } = createDeps({
    lead: { id: LEAD_ID, email: "opfer@gmail.com", quizKind: "personal_plan", userId: null },
    async checkRateLimit({ dimension, identifier }) {
      if (dimension === "address") aliasKeys.push(identifier)
      return { allowed: true }
    },
  })

  for (const alias of ["opfer+1@gmail.com", "opfer+2@gmail.com", "opfer+3@gmail.com"]) {
    const result = await requestFreeRegistrationLink(
      { leadId: LEAD_ID, email: alias, capability: VALID_CAPABILITY },
      deps,
    )
    assert.equal(result.outcome, "sent", alias)
  }

  assert.deepEqual(new Set(aliasKeys), new Set(["opfer@gmail.com"]))
})

test("N1: the canonicalized key never touches the address that gets written or mailed", async () => {
  const { deps, recorder } = createDeps({
    lead: { id: LEAD_ID, email: "opfer@example.com", quizKind: "personal_plan", userId: null },
  })

  const result = await requestFreeRegistrationLink(
    {
      leadId: LEAD_ID,
      email: "o.p.fer+correction@gmail.com",
      capability: VALID_CAPABILITY,
    },
    deps,
  )

  assert.deepEqual(result, {
    outcome: "sent",
    email: "o.p.fer+correction@gmail.com",
    corrected: true,
  })
  // The rate-limit bucket is canonicalized ("opfer@gmail.com")...
  assert.deepEqual(recorder.rateLimitCalls.at(-1), {
    dimension: "address",
    identifier: "opfer@gmail.com",
  })
  // ...but the lead write and the actual send both use the exact requested address.
  assert.deepEqual(recorder.leadEmailWrites, [
    { leadId: LEAD_ID, email: "o.p.fer+correction@gmail.com" },
  ])
  assert.equal(recorder.sent[0]?.email, "o.p.fer+correction@gmail.com")
})

test("W4: each dimension can refuse on its own, before anything is written or sent", async () => {
  for (const blocked of ["ip", "address"] as const) {
    const { deps, recorder } = createDeps({
      async checkRateLimit({ dimension, identifier }) {
        recorder.rateLimitCalls.push({ dimension, identifier })
        return dimension === blocked ? { allowed: false } : { allowed: true }
      },
    })
    const result = await requestFreeRegistrationLink(
      {
        leadId: LEAD_ID,
        email: "lena.neu@example.com",
        capability: VALID_CAPABILITY,
        ipAddress: "203.0.113.7",
      },
      deps,
    )
    assert.deepEqual(result, { outcome: "rate_limited" }, blocked)
    assert.equal(recorder.sent.length, 0, blocked)
    assert.equal(recorder.leadEmailWrites.length, 0, blocked)
  }
})

test("legacy-quiz leads and missing leads are indistinguishable to the caller", async () => {
  for (const lead of [
    null,
    { id: LEAD_ID, email: "lena@example.com", quizKind: "legacy" as const, userId: null },
  ]) {
    const { deps, recorder } = createDeps({ lead })
    const result = await requestFreeRegistrationLink({ leadId: LEAD_ID }, deps)
    assert.deepEqual(result, { outcome: "lead_not_found" })
    assert.equal(recorder.sent.length, 0)
  }
})

test("malformed input never reaches the rate limiter or the lead lookup", async () => {
  const { deps, recorder } = createDeps()
  for (const request of [
    { leadId: "nope" },
    { leadId: 42 },
    { leadId: LEAD_ID, email: "keine-adresse" },
    { leadId: LEAD_ID, email: 7 },
  ]) {
    assert.deepEqual(await requestFreeRegistrationLink(request, deps), {
      outcome: "invalid_request",
    })
  }
  assert.equal(recorder.rateLimitKeys.length, 0)
  assert.equal(recorder.sent.length, 0)
})

test("rate limiting and an unavailable limiter are distinguished", async () => {
  const limited = createDeps({
    async checkRateLimit() {
      return { allowed: false }
    },
  })
  assert.deepEqual(await requestFreeRegistrationLink({ leadId: LEAD_ID }, limited.deps), {
    outcome: "rate_limited",
  })
  assert.equal(limited.recorder.sent.length, 0)

  const unavailable = createDeps({
    async checkRateLimit() {
      return { allowed: false, error: "service_unavailable" }
    },
  })
  assert.deepEqual(await requestFreeRegistrationLink({ leadId: LEAD_ID }, unavailable.deps), {
    outcome: "rate_limit_unavailable",
  })
})

test("a failed OTP send surfaces as send_failed", async () => {
  const { deps } = createDeps({
    async sendMagicLink() {
      return { error: new Error("supabase down") }
    },
  })
  assert.deepEqual(await requestFreeRegistrationLink({ leadId: LEAD_ID }, deps), {
    outcome: "send_failed",
  })
})

test("the endpoint is dark while the flag is off and speaks HTTP codes when on", async () => {
  const { deps } = createDeps()

  const dark = createFreeRegistrationPostHandler({ ...deps, isEnabled: () => false })
  const darkResponse = await dark(
    new Request("https://app.test/api/auth/free-registration", {
      method: "POST",
      body: JSON.stringify({ leadId: LEAD_ID }),
    }),
  )
  assert.equal(darkResponse.status, 404)

  const live = createFreeRegistrationPostHandler({ ...deps, isEnabled: () => true })
  const ok = await live(
    new Request("https://app.test/api/auth/free-registration", {
      method: "POST",
      body: JSON.stringify({ leadId: LEAD_ID }),
    }),
  )
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { ok: true, email: "lena@example.com", corrected: false })

  const badJson = await live(
    new Request("https://app.test/api/auth/free-registration", { method: "POST", body: "{" }),
  )
  assert.equal(badJson.status, 400)

  const claimed = createFreeRegistrationPostHandler({
    ...createDeps({
      lead: {
        id: LEAD_ID,
        email: "lena@example.com",
        quizKind: "personal_plan",
        userId: "99999999-9999-4999-8999-999999999999",
      },
    }).deps,
    isEnabled: () => true,
  })
  const claimedResponse = await claimed(
    new Request("https://app.test/api/auth/free-registration", {
      method: "POST",
      body: JSON.stringify({ leadId: LEAD_ID }),
    }),
  )
  assert.equal(claimedResponse.status, 409)
  assert.equal((await claimedResponse.json()).code, "lead_claimed")

  // An unauthorized correction is a 403 with honest German copy, not a 200.
  const refused = await live(
    new Request("https://app.test/api/auth/free-registration", {
      method: "POST",
      body: JSON.stringify({ leadId: LEAD_ID, email: "angreifer@example.com" }),
    }),
  )
  assert.equal(refused.status, 403)
  const refusedBody = (await refused.json()) as Record<string, unknown>
  assert.equal(refusedBody.code, "correction_not_authorized")
  assert.match(String(refusedBody.error), /Haaranalyse noch einmal/)
})

test("an unexpected persistence failure is a 500, never a silent success", async () => {
  const { deps } = createDeps({
    async loadLead() {
      throw new Error("db down")
    },
  })
  const handler = createFreeRegistrationPostHandler({ ...deps, isEnabled: () => true })
  const response = await handler(
    new Request("https://app.test/api/auth/free-registration", {
      method: "POST",
      body: JSON.stringify({ leadId: LEAD_ID }),
    }),
  )
  assert.equal(response.status, 500)
})

test("the new surfaces are classified — reachable before an account exists", () => {
  const production = { nodeEnv: "production", localDevLoginEnabled: false }
  assert.equal(classifyRoute("/registrierung", production), "public")
  assert.equal(classifyRoute("/api/auth/free-registration", production), "public")
})

test("field-test and moderator completions keep the paid reveal even with the flag on", () => {
  const quiz = readFileSync("src/components/personal-plan-quiz/personal-plan-quiz.tsx", "utf8")
  assert.match(
    quiz,
    /const freeRegistrationFunnel = freemiumScannerFirst && !fieldTest && !moderator/,
  )
  assert.match(
    quiz,
    /resolveQuizCompletionNavigation\(leadId, email, capability, freeRegistrationFunnel\)/,
  )
  // The capability is declared above `renderScreen`, which closes over it (W7).
  assert.ok(
    quiz.indexOf("const freeRegistrationFunnel") < quiz.indexOf("function renderScreen"),
    "freeRegistrationFunnel must be declared before the closure that reads it",
  )
})

test("the payment-activation magic-link route stays payment-only and untouched by T18", () => {
  const source = readFileSync("src/app/api/auth/send-magic-link/route.ts", "utf8")

  // The free path is the ONLY `shouldCreateUser: true` sender. Payment
  // activation must never create accounts, and must never import the free
  // registration contract.
  assert.ok(source.includes("shouldCreateUser: false"))
  assert.ok(!source.includes("shouldCreateUser: true"))
  assert.ok(!source.includes("free-registration"))
  assert.ok(!source.includes("provisionFreeInitialSnapshot"))
  assert.ok(source.includes("verifyCheckoutSessionForActivation"))
})

// --- PR6 Codex review, finding V2 -------------------------------------------

test("V2: the confirm context is resolved through the nesting the real builder produces", () => {
  const origin = SITE_URL
  const callback = buildFreeRegistrationEmailRedirect(SITE_URL, LEAD_ID)
  const nested = (key: "next" | "redirect_to") => {
    const url = new URL("/auth/confirm", origin)
    url.searchParams.set("token_hash", "hash")
    url.searchParams.set("type", key === "next" ? "email" : "magiclink")
    url.searchParams.set(key, callback)
    return url.searchParams
  }

  // The signup shape (`next=<callback>`) and the magic-link shape
  // (`redirect_to=<callback>`) both resolve the lead.
  assert.deepEqual(resolveFreeRegistrationConfirmContext(nested("next"), origin), {
    leadId: LEAD_ID,
  })
  assert.deepEqual(resolveFreeRegistrationConfirmContext(nested("redirect_to"), origin), {
    leadId: LEAD_ID,
  })
  // The direct/hand-built shape keeps working.
  assert.deepEqual(resolveFreeRegistrationConfirmContext(new URL(callback).searchParams, origin), {
    leadId: LEAD_ID,
  })
})

test("V2: the nested resolver is a whitelist — no new redirect sink, no unbounded walk", () => {
  const origin = SITE_URL
  const wrap = (inner: string) => {
    const url = new URL("/auth/confirm", origin)
    url.searchParams.set("next", inner)
    return url
  }

  // Cross-origin nesting is refused outright.
  const foreign = new URL("/auth/confirm", "https://evil.test")
  foreign.searchParams.set("free", "1")
  foreign.searchParams.set("lead", LEAD_ID)
  foreign.searchParams.set("next", "/scan")
  assert.equal(
    resolveFreeRegistrationConfirmContext(wrap(foreign.toString()).searchParams, origin),
    null,
  )

  // A nested layer that is not the exact minted shape resolves nothing:
  // a different landing, a non-UUID lead, or a missing free marker.
  for (const params of [
    { free: "1", lead: LEAD_ID, next: "/plan-start" },
    { free: "1", lead: "not-a-uuid", next: "/scan" },
    { lead: LEAD_ID, next: "/scan" },
  ]) {
    const inner = new URL("/auth/confirm", origin)
    for (const [key, value] of Object.entries(params)) inner.searchParams.set(key, value)
    assert.equal(
      resolveFreeRegistrationConfirmContext(wrap(inner.toString()).searchParams, origin),
      null,
    )
  }

  // The walk is depth-bounded: a chain longer than the cap resolves nothing
  // rather than recursing on attacker-controlled input.
  let chained = buildFreeRegistrationEmailRedirect(SITE_URL, LEAD_ID)
  for (let depth = 0; depth < 5; depth += 1) chained = wrap(chained).toString()
  assert.equal(resolveFreeRegistrationConfirmContext(new URL(chained).searchParams, origin), null)
})
