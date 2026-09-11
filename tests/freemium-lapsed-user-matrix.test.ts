import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { NextRequest } from "next/server"

import {
  resolveAuthenticatedAppAccessState,
  type AuthenticatedAppAccessState,
} from "../src/lib/auth/authenticated-app-route-access"
import { resolveGatedPageMode } from "../src/lib/gated-preview/gate"
import {
  hasPersonalPlanKeepsakeEvidence,
  loadPersonalPlanKeepsakeContent,
  parsePersonalPlanKeepsakeContent,
} from "../src/lib/personal-plan/keepsake-content"
import { resolveNavigationPaidAccess } from "../src/lib/personal-plan/navigation-access"
import {
  createUpdateSession,
  isFreemiumKeepsakeReadRoutePath,
  shouldBypassPersonalPlanFrontierRedirect,
  shouldRedirectToReactivation,
  type UpdateSessionDependencies,
} from "../src/lib/supabase/middleware"
import { createScanWishlistRouteHandler } from "../src/app/api/scan/wishlist/route"
import { resolveKeepsakeRoutinePage } from "../src/app/routine/page"
import { resolveAnwendungPage } from "../src/app/anwendung/page"

/**
 * T17 — THE lapsed-user matrix (plan.md PR5, task T17 "Done:" criterion).
 *
 * One user, one question per row: for someone who HELD paid access and holds none now,
 * under the freemium flag —
 *
 *   read their own Routine / Anwendung / Merkliste / chat history   → ALLOWED
 *   mutate anything                                                 → DENIED
 *   bump into a premium affordance                                  → the Premium sheet
 *   navigate to /routine or /anwendung                              → NO frontier bounce
 *
 * and the two counter-cohorts that must not move: a never-paid free user (unchanged
 * „Beispiel" behaviour) and a premium user (unchanged everything). Flag off is asserted
 * on every seam that has one.
 */

const SOURCE_ROOT = path.resolve(process.cwd(), "src")
const readSource = (relative: string) => readFileSync(path.join(SOURCE_ROOT, relative), "utf8")

const PLAN_ID = "11111111-1111-4111-8111-111111111111"
const ROUTINE_VERSION_ID = "22222222-2222-4222-8222-222222222222"
const USER_ID = "33333333-3333-4333-8333-333333333333"

async function withFlag(enabled: boolean, run: () => Promise<void>): Promise<void> {
  const previous = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  if (enabled) process.env.FREEMIUM_SCANNER_FIRST_ENABLED = "true"
  else delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = previous
  }
}

// --- 1. Lapsed detection ----------------------------------------------------
//
// "Lapsed" is composed, not stored: the paid-access composite denies AND the user owns
// an accepted Routine version. Both halves are load-bearing, and both failure modes have
// a required direction.

function accessStateDeps(overrides: {
  tier?: "free" | "premium" | (() => Promise<never>)
  keepsake?: boolean | (() => Promise<never>)
  userId?: string | null
}) {
  const tier = overrides.tier ?? "free"
  const keepsake = overrides.keepsake ?? false
  return {
    loadTier: typeof tier === "function" ? tier : async () => tier,
    getUserId: async () => (overrides.userId === undefined ? USER_ID : overrides.userId),
    hasKeepsakeContent: typeof keepsake === "function" ? keepsake : async () => keepsake,
  }
}

test("lapsed = composite denied AND an accepted Routine version exists", async () => {
  const cases: Array<[Parameters<typeof accessStateDeps>[0], AuthenticatedAppAccessState]> = [
    // Premium: never even asks for keepsake evidence (asserted separately below).
    [{ tier: "premium", keepsake: true }, "premium"],
    [{ tier: "premium", keepsake: false }, "premium"],
    // Denied + owns an accepted Routine -> lapsed.
    [{ tier: "free", keepsake: true }, "lapsed"],
    // Denied + never paid -> today's free tier, unchanged.
    [{ tier: "free", keepsake: false }, "free"],
    // Denied + no session -> free, never lapsed.
    [{ tier: "free", keepsake: true, userId: null }, "free"],
  ]

  for (const [overrides, expected] of cases) {
    assert.equal(
      await resolveAuthenticatedAppAccessState(accessStateDeps(overrides)),
      expected,
      JSON.stringify({
        tier: overrides.tier,
        keepsake: overrides.keepsake,
        userId: overrides.userId,
      }),
    )
  }
})

test("a premium tier never performs the keepsake read at all", async () => {
  await resolveAuthenticatedAppAccessState(
    accessStateDeps({
      tier: "premium",
      keepsake: () => {
        throw new Error("keepsake read must not run for a premium user")
      },
    }),
  )
})

test("both lookups fail closed, in opposite directions", async () => {
  // A tier-lookup failure must never open a free surface for a paying user.
  assert.equal(
    await resolveAuthenticatedAppAccessState(
      accessStateDeps({
        tier: () => {
          throw new Error("billing read failed")
        },
      }),
    ),
    "premium",
  )
  // A keepsake-lookup failure must never GRANT a keepsake read — it degrades to today's
  // behaviour for a composite-denied user.
  assert.equal(
    await resolveAuthenticatedAppAccessState(
      accessStateDeps({
        tier: "free",
        keepsake: () => {
          throw new Error("personal_plans read failed")
        },
      }),
    ),
    "free",
  )
})

test("keepsake evidence is an ACCEPTED routine version, never a pending proposal", () => {
  assert.deepEqual(
    parsePersonalPlanKeepsakeContent({
      id: PLAN_ID,
      active_routine_version_id: ROUTINE_VERSION_ID,
    }),
    { personalPlanId: PLAN_ID, activeRoutineVersionId: ROUTINE_VERSION_ID },
  )
  // A plan that only ever reached a pending proposal is NOT keepsake content.
  assert.equal(
    parsePersonalPlanKeepsakeContent({ id: PLAN_ID, active_routine_version_id: null }),
    null,
  )
  assert.equal(parsePersonalPlanKeepsakeContent(null), null)
  assert.equal(parsePersonalPlanKeepsakeContent({ active_routine_version_id: 42 }), null)
})

test("the keepsake read is owner-scoped and surfaces query errors instead of swallowing them", async () => {
  const observed: Array<{ table: string; column: string; value: unknown }> = []
  const client = (result: { data: unknown; error: unknown }) =>
    ({
      from(table: "personal_plans") {
        const query = {
          select: () => query,
          eq: (column: string, value: unknown) => {
            observed.push({ table, column, value })
            return query
          },
          maybeSingle: async () => result,
        }
        return query
      },
    }) as never

  await loadPersonalPlanKeepsakeContent(
    client({ data: { id: PLAN_ID, active_routine_version_id: ROUTINE_VERSION_ID }, error: null }),
    USER_ID,
  )
  assert.deepEqual(observed, [{ table: "personal_plans", column: "user_id", value: USER_ID }])

  await assert.rejects(
    loadPersonalPlanKeepsakeContent(client({ data: null, error: { message: "boom" } }), USER_ID),
  )
})

// --- 1b. PR5 review fix (Z2): the ROUTINE-LESS lapsed cohort ----------------
//
// Paid scanning, saving and chat never required an accepted Routine, so keying "lapsed"
// on `active_routine_version_id` alone dropped two real paying cohorts into the never-paid
// bucket: legacy subscribers from before the Personal Plan, and buyers whose provisioning
// stopped before Stage-4 acceptance. Evidence is now ANY paid-era artifact.

function evidenceClient(rows: Partial<Record<string, unknown>>, error?: unknown) {
  const queried: string[] = []
  const client = {
    from(table: string) {
      queried.push(table)
      // V5: the paid-origin filter is applied for real, so a fixture that stands
      // for a FREE-origin plan row (`enrollment_purchase_source_id: null`) is
      // invisible to the probe exactly as it is in Postgres.
      let paidOriginOnly = false
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          assert.equal(column, "user_id", `${table} must be owner-scoped`)
          assert.equal(value, USER_ID)
          return query
        },
        not: (column: string, operator: string, value: unknown) => {
          assert.equal(column, "enrollment_purchase_source_id")
          assert.equal(operator, "is")
          assert.equal(value, null)
          paidOriginOnly = true
          return query
        },
        limit: (count: number) => {
          assert.equal(count, 1, `${table} must be an existence probe, not a listing`)
          return query
        },
        maybeSingle: async () => {
          const row = rows[table] ?? null
          if (
            paidOriginOnly &&
            row &&
            !(row as Record<string, unknown>).enrollment_purchase_source_id
          ) {
            return { data: null, error: error ?? null }
          }
          return { data: row, error: error ?? null }
        },
      }
      return query
    },
  }
  return { client: client as never, queried }
}

/** A plan row admitted by a real purchase (T14's pin, or any paid Stage-1 path). */
const PAID_PLAN_ROW = {
  id: PLAN_ID,
  enrollment_purchase_source_id: "40000000-0000-4000-8000-000000000001",
}

test("Z2: lapsed evidence is ANY paid-era artifact — plan, own Merkliste rows, or own chat", async () => {
  for (const [table, row] of [
    ["personal_plans", PAID_PLAN_ROW],
    ["scan_wishlist", { id: "row-1" }],
    ["conversations", { id: "row-1" }],
  ] as const) {
    const { client } = evidenceClient({ [table]: row })
    assert.equal(
      await hasPersonalPlanKeepsakeEvidence(client, USER_ID),
      true,
      `${table} alone must prove a paid era`,
    )
  }

  // A routine-less plan row (no accepted Routine version) is now evidence in its own right
  // — the exact cohort the old classifier lost.
  const { client: routineLess } = evidenceClient({
    personal_plans: { ...PAID_PLAN_ROW, active_routine_version_id: null },
  })
  assert.equal(await hasPersonalPlanKeepsakeEvidence(routineLess, USER_ID), true)

  // Never paid: no artifact anywhere -> unchanged „Beispiel" behaviour.
  const { client: none, queried } = evidenceClient({})
  assert.equal(await hasPersonalPlanKeepsakeEvidence(none, USER_ID), false)
  assert.deepEqual(queried, ["personal_plans", "scan_wishlist", "conversations"])
})

// --- PR6 Codex review, finding V5 (cross-PR) --------------------------------
//
// T18's free registration provisions an initial need snapshot at `/auth/confirm`, and the
// RPC that writes it CREATES the `personal_plans` row. Counting any such row as paid-era
// evidence classified a brand-new free registrant as LAPSED — keepsake views and „Noch
// keine Routine" instead of the approved Beispiel pages and upgrade CTAs.
test("V5: a fresh FREE registrant's own plan row is not paid-era evidence", async () => {
  // Exactly what T6/T18 write: the plan exists, its enrollment source is null.
  const { client: freshFree, queried } = evidenceClient({
    personal_plans: { id: PLAN_ID, enrollment_purchase_source_id: null },
  })
  assert.equal(
    await hasPersonalPlanKeepsakeEvidence(freshFree, USER_ID),
    false,
    "a free-origin plan row must not promote a new registrant into the lapsed cohort",
  )
  // And the probe does not stop there — it goes on to ask the other two.
  assert.deepEqual(queried, ["personal_plans", "scan_wishlist", "conversations"])

  // The same free registrant after a purchase: T14's pin moves the column off
  // null, and the row becomes evidence.
  const { client: afterPurchase } = evidenceClient({ personal_plans: PAID_PLAN_ROW })
  assert.equal(await hasPersonalPlanKeepsakeEvidence(afterPurchase, USER_ID), true)
})

test("Z2: the evidence probes short-circuit on the first hit and surface query errors", async () => {
  const { client, queried } = evidenceClient({ personal_plans: PAID_PLAN_ROW })
  await hasPersonalPlanKeepsakeEvidence(client, USER_ID)
  assert.deepEqual(queried, ["personal_plans"], "no further reads once the era is proven")

  const { client: broken } = evidenceClient({}, { message: "boom" })
  await assert.rejects(hasPersonalPlanKeepsakeEvidence(broken, USER_ID))
})

test("Z2: a routine-less lapsed user gets the honest empty Routine, never the Beispiel", async () => {
  const base = {
    getUserId: async () => USER_ID,
    loadKeepsakeContent: async () => null,
    readView: async () => ({ status: "no_personal_plan" }) as never,
  }

  // No accepted Routine version at all.
  assert.equal((await resolveKeepsakeRoutinePage(base)).kind, "no_routine")
  // Evidence exists but the view carries no active version.
  assert.equal(
    (
      await resolveKeepsakeRoutinePage({
        ...base,
        loadKeepsakeContent: async () => ({
          personalPlanId: PLAN_ID,
          activeRoutineVersionId: ROUTINE_VERSION_ID,
        }),
        readView: async () =>
          ({
            status: "active",
            personalPlanId: PLAN_ID,
            planRevision: 1,
            sourceRevision: 1,
            activeVersion: null,
            pendingProposal: null,
            productPresentation: { catalogProducts: [] },
          }) as never,
      })
    ).kind,
    "no_routine",
  )
  // A read that FAILED is still `unavailable` — an untrusted signal keeps today's fallback.
  assert.equal(
    (
      await resolveKeepsakeRoutinePage({
        ...base,
        loadKeepsakeContent: async () => {
          throw new Error("read failed")
        },
      })
    ).kind,
    "unavailable",
  )
  assert.equal(
    (await resolveKeepsakeRoutinePage({ ...base, getUserId: async () => null })).kind,
    "unavailable",
  )
})

test("Z2: the routine-less keepsake render keeps the Merkliste readable and drops the Beispiel", () => {
  const source = readSource("app/routine/page.tsx")
  const keepsakeBranch = source.slice(source.indexOf('if (pageMode === "keepsake")'))
  assert.match(keepsakeBranch, /keepsake\.kind === "no_routine"/)
  assert.match(keepsakeBranch, /<KeepsakeNoRoutineState/)
  assert.ok(
    keepsakeBranch.indexOf("<KeepsakeNoRoutineState") <
      keepsakeBranch.indexOf("<GatedRoutineExample />"),
    "the Beispiel is only reachable for an unreadable keepsake signal",
  )
  // The state itself: their own Merkliste, read-only — no write affordance, no example.
  const state = source.slice(source.indexOf("function KeepsakeNoRoutineState"))
  assert.match(state, /<GemerktSection merklisteEnabled=\{merklisteEnabled\} readOnly \/>/)
})

test("Z2: both keepsake gates read the widened evidence, not the accepted-Routine content", () => {
  assert.match(
    readSource("lib/auth/authenticated-app-route-access.ts"),
    /hasKeepsakeContent: hasPersonalPlanKeepsakeEvidenceForUser/,
  )
  assert.match(
    readSource("app/api/scan/wishlist/route.ts"),
    /return await hasPersonalPlanKeepsakeEvidenceForUser\(userId\)/,
  )
})

// --- 2. Page mode: reads allowed, example untouched -------------------------

test("the page mode maps the three access states onto the three renders", async () => {
  assert.equal(await resolveGatedPageMode(async () => "premium"), "premium")
  assert.equal(await resolveGatedPageMode(async () => "lapsed"), "keepsake")
  assert.equal(await resolveGatedPageMode(async () => "free"), "example")
  assert.equal(
    await resolveGatedPageMode(async () => {
      throw new Error("unavailable")
    }),
    "premium",
  )
})

// --- 3. Routine read: their OWN routine, not the Beispiel composition -------

test("the keepsake Routine reads the owner's own accepted version, with the proposal machinery off", async () => {
  const readViewCalls: Array<{ userId: string; enabled: boolean }> = []
  const resolved = await resolveKeepsakeRoutinePage({
    getUserId: async () => USER_ID,
    loadKeepsakeContent: async () => ({
      personalPlanId: PLAN_ID,
      activeRoutineVersionId: ROUTINE_VERSION_ID,
    }),
    readView: async (input) => {
      readViewCalls.push(input)
      return {
        status: "active",
        personalPlanId: PLAN_ID,
        planRevision: 1,
        sourceRevision: 1,
        activeVersion: {
          id: ROUTINE_VERSION_ID,
          payload: { source: { productPortfolioVersionId: null } },
        },
        pendingProposal: null,
        productPresentation: { catalogProducts: [] },
      } as never
    },
  })

  assert.equal(resolved.kind, "keepsake")
  // `enabled: false` is what makes this a keepsake read rather than a live Routine: no
  // pending proposal is loaded, so nothing can be accepted or rejected from this render.
  assert.deepEqual(readViewCalls, [{ userId: USER_ID, enabled: false }])
})

test("the keepsake Routine refuses to render the OWNER'S ROUTINE without both halves of the evidence", async () => {
  const base = {
    getUserId: async () => USER_ID,
    loadKeepsakeContent: async () => ({
      personalPlanId: PLAN_ID,
      activeRoutineVersionId: ROUTINE_VERSION_ID,
    }),
    readView: async () =>
      ({
        status: "active",
        personalPlanId: PLAN_ID,
        planRevision: 1,
        sourceRevision: 1,
        activeVersion: { id: ROUTINE_VERSION_ID, payload: { source: {} } },
        pendingProposal: null,
        productPresentation: { catalogProducts: [] },
      }) as never,
  }

  assert.equal(
    (await resolveKeepsakeRoutinePage({ ...base, getUserId: async () => null })).kind,
    "unavailable",
  )
  // PR5 review fix (Z2): a MISSING routine is no longer the same answer as a BROKEN read —
  // it is the honest `no_routine` state (see the routine-less cohort's own test above), so
  // neither of these renders the owner's Routine, and neither falls back to the Beispiel.
  assert.equal(
    (await resolveKeepsakeRoutinePage({ ...base, loadKeepsakeContent: async () => null })).kind,
    "no_routine",
  )
  assert.equal(
    (
      await resolveKeepsakeRoutinePage({
        ...base,
        readView: async () => ({ status: "no_personal_plan" }) as never,
      })
    ).kind,
    "no_routine",
  )
  assert.equal(
    (
      await resolveKeepsakeRoutinePage({
        ...base,
        loadKeepsakeContent: async () => {
          throw new Error("read failed")
        },
      })
    ).kind,
    "unavailable",
  )
})

test("the Routine page renders the REAL client for keepsake and the Beispiel only for free", () => {
  const source = readSource("app/routine/page.tsx")
  const keepsakeBranch = source.slice(source.indexOf('if (pageMode === "keepsake")'))
  // The keepsake branch mounts the real PersonalPlanRoutineClient — never GatedRoutineExample
  // as its primary render — with writes off and the keepsake locks on.
  assert.match(keepsakeBranch, /<PersonalPlanRoutineClient/)
  assert.match(keepsakeBranch, /enabled=\{false\}/)
  assert.match(keepsakeBranch, /keepsake\s*\/>/)
  assert.ok(
    keepsakeBranch.indexOf("<PersonalPlanRoutineClient") <
      keepsakeBranch.indexOf("<GatedRoutineExample />"),
    "the example is only the fallback, never the keepsake render",
  )
})

// --- 4. Mutations stay denied; gates open the sheet -------------------------

test("keepsake mode removes every write path from the Routine client and locks the edit entry", () => {
  const client = readSource("components/routine/personal-plan/personal-plan-routine-client.tsx")
  const page = readSource("components/routine/personal-plan/routine-page.tsx")

  // The edit entry is locked (sheet), not silently hidden.
  assert.match(client, /onLockedEdit=\{keepsake \? openKeepsakeRoutineGate : undefined\}/)
  assert.match(
    client,
    /const KEEPSAKE_ROUTINE_GATE = \{ feature: "routine", source: "gated:routine" \}/,
  )
  // The per-item product-detail read (403 for this cohort) is dropped.
  assert.match(
    client,
    /onItemDetail=\{keepsake \? undefined : \(item\) => void openDetail\(item\)\}/,
  )
  // Merkliste is readable but not writable.
  assert.match(client, /merklisteReadOnly=\{keepsake\}/)
  // The sheet is only ever mounted in keepsake mode, so premium/flag-off DOM is unchanged.
  assert.match(client, /\{keepsake \? \(\s*<PremiumSheet/)
  // The locked affordance carries the gate's accessible name once; the badge is decorative.
  assert.match(page, /aria-label="Anpassen — Premium"/)
  assert.match(page, /<KeepsakeLockBadge \/>/)
})

test("keepsake mode removes every write path from the chat container and locks the composer", () => {
  const container = readSource("components/chat/chat-container.tsx")
  const composer = readSource("components/chat/chat-keepsake-composer.tsx")

  assert.match(container, /const KEEPSAKE_CHAT_GATE = \{ feature: "chat", source: "gated:chat" \}/)
  assert.match(container, /if \(keepsake\) \{\s*openKeepsakeChatGate\(\)\s*return\s*\}/)
  assert.match(
    container,
    /onSelectProductCandidate=\{keepsake \? undefined : selectProductCandidate\}/,
  )
  assert.match(container, /onFeedback=\{keepsake \? undefined : submitFeedback\}/)
  assert.match(container, /keepsake \? undefined : applyProductIntakeSubmission/)
  assert.match(container, /drawerProduct && !keepsake/)
  assert.match(
    container,
    /keepsake \? \(\s*<ChatKeepsakeComposer onUnlock=\{openKeepsakeChatGate\} \/>/,
  )
  // The one write that does not funnel through `handleSendMessage`: the mount-effect
  // routine-trigger seed dispatches `sendMessage` directly. It must not fire either.
  assert.match(container, /if \(keepsake\) return\s*\n\s*const routineSeedConversationId/)
  // The locked composer cannot submit anything: no textarea, no form, no fetch.
  assert.doesNotMatch(composer, /<textarea/)
  assert.doesNotMatch(composer, /<form/)
  assert.doesNotMatch(composer, /fetch\(/)
  assert.match(composer, /aria-label="Chat freischalten — Premium"/)
})

test("Z4: keepsake history renders the interactive chat cards statically — no failing POST is reachable", () => {
  const container = readSource("components/chat/chat-container.tsx")
  const message = readSource("components/chat/chat-message.tsx")
  const clarification = readSource("components/chat/product-lookup-clarification-card.tsx")
  const intake = readSource("components/chat/product-intake-card.tsx")

  // The container's withheld callbacks were not enough: `selectProductFromClarification` is
  // always a function and THROWS when the callback is missing, so the card's „Auswählen"
  // stayed clickable for this cohort. It is now withheld and the card is read-only.
  assert.match(container, /keepsake=\{keepsake\}/)
  assert.match(
    message,
    /onSelectProduct=\{keepsake \? undefined : selectProductFromClarification\}/,
  )
  assert.match(message, /readOnly=\{keepsake\}/)

  // Read-only clarification: selection inert, and the „none"-action intake form — its own
  // POST /api/product-intake, 403 for a lapsed owner — is not offered at all.
  assert.match(clarification, /const canSelect =\s*!readOnly &&/)
  assert.match(clarification, /\{!hasLockedSelection && !readOnly \? \(/)
  assert.match(clarification, /\{showIntake && !hasLockedSelection && !readOnly \? \(/)

  // Read-only intake offer: a static note, returned BEFORE any of the form's own state or
  // submit path is rendered.
  assert.match(
    intake,
    /if \(readOnly && !submittedStatus && !persistedState\?\.submittedStatus\) \{/,
  )
  assert.match(intake, /return <ProductIntakeKeepsakeState \/>/)
  const keepsakeState = intake.slice(intake.indexOf("export function ProductIntakeKeepsakeState"))
  assert.doesNotMatch(
    keepsakeState.slice(0, keepsakeState.indexOf("export function ProductIntakeSubmittedState")),
    /fetch\(|<input|<select|onClick/,
  )

  // Both cards default to interactive, so premium and flag-off are untouched.
  assert.match(clarification, /readOnly = false/)
  assert.match(intake, /readOnly = false/)
  assert.match(message, /keepsake = false/)
})

test("the Gemerkt section drops both write affordances when read-only", () => {
  const source = readSource("components/routine/gemerkt-section.tsx")
  const readOnlyBranch = source.slice(source.indexOf("{readOnly ? null : ("))
  assert.ok(readOnlyBranch.indexOf("Zur Routine hinzufügen") > -1)
  assert.ok(readOnlyBranch.indexOf("von der Merkliste entfernen") > -1)
  // The listing itself is outside that branch — the data stays readable.
  assert.ok(source.indexOf('id="gemerkt"') < source.indexOf("{readOnly ? null : ("))
})

// --- 5. Merkliste: GET opens for keepsake, writes do not --------------------

function wishlistHandler(overrides: {
  access: "allowed" | "denied" | "unavailable"
  keepsake?: (userId: string) => Promise<boolean>
}) {
  return createScanWishlistRouteHandler({
    getUserId: async () => USER_ID,
    checkRateLimit: (async () => ({ allowed: true })) as never,
    createAdminClient: (() => ({})) as never,
    listWishlist: async () => [],
    requirePremiumAccess: async () => overrides.access,
    allowKeepsakeRead: overrides.keepsake,
  })
}

test("Merkliste GET: premium unchanged, lapsed reads, never-paid still 403", async () => {
  const premium = await wishlistHandler({ access: "allowed" })(
    new NextRequest("https://chaarlie.de/api/scan/wishlist"),
  )
  assert.equal(premium.status, 200)

  const lapsed = await wishlistHandler({ access: "denied", keepsake: async () => true })(
    new NextRequest("https://chaarlie.de/api/scan/wishlist"),
  )
  assert.equal(lapsed.status, 200)
  assert.deepEqual(await lapsed.json(), { entries: [] })

  const neverPaid = await wishlistHandler({ access: "denied", keepsake: async () => false })(
    new NextRequest("https://chaarlie.de/api/scan/wishlist"),
  )
  assert.equal(neverPaid.status, 403)
  assert.deepEqual(await neverPaid.json(), { error: "subscription_required" })

  // No keepsake dep wired at all (every pre-T17 caller) = today's behaviour.
  const withoutDep = await wishlistHandler({ access: "denied" })(
    new NextRequest("https://chaarlie.de/api/scan/wishlist"),
  )
  assert.equal(withoutDep.status, 403)

  // An entitlement-source outage still outranks keepsake: retriable, not a silent read.
  const outage = await wishlistHandler({ access: "unavailable", keepsake: async () => true })(
    new NextRequest("https://chaarlie.de/api/scan/wishlist"),
  )
  assert.equal(outage.status, 503)
})

test("Merkliste MUTATIONS are untouched by the keepsake read", () => {
  const save = readSource("app/api/scan/save/route.ts")
  // The save route (POST move + DELETE remove) never learned about keepsake at all.
  assert.doesNotMatch(save, /[Kk]eepsake/)
})

// --- 6. Middleware: keepsake reads are GET-only -----------------------------

test("the keepsake read carve-out is scoped to GET on /api/chat and nothing else", () => {
  assert.equal(isFreemiumKeepsakeReadRoutePath("/api/chat"), true)
  assert.equal(isFreemiumKeepsakeReadRoutePath("/api/chat/conversation-1"), true)
  for (const pathname of [
    "/api/profile",
    "/api/personal-plan",
    "/api/routine",
    "/api/memory",
    "/api/product-intake",
    "/api/tracker",
  ]) {
    assert.equal(isFreemiumKeepsakeReadRoutePath(pathname), false, pathname)
  }

  // Flag on: GET admitted, every mutating method still denied.
  assert.equal(
    shouldRedirectToReactivation({
      pathname: "/api/chat",
      freemiumScannerFirstEnabled: true,
      method: "GET",
    }),
    false,
  )
  for (const method of ["POST", "DELETE", "PUT", "PATCH", undefined]) {
    assert.equal(
      shouldRedirectToReactivation({
        pathname: "/api/chat",
        freemiumScannerFirstEnabled: true,
        method,
      }),
      true,
      String(method),
    )
  }
  // Flag off: no method opens anything.
  for (const method of ["GET", "POST"]) {
    assert.equal(
      shouldRedirectToReactivation({
        pathname: "/api/chat",
        freemiumScannerFirstEnabled: false,
        method,
      }),
      true,
      method,
    )
  }
})

// --- 7. Frontier carve-out (T2 review finding I2) ---------------------------

test("the frontier bypass fires only for a lapsed owner on an admitted read surface", () => {
  const lapsed = {
    freemiumScannerFirstEnabled: true,
    subscriptionChecked: true,
    hasPaidAppAccess: false,
    frontierKind: "personal_plan" as const,
  }

  for (const pathname of ["/routine", "/routine/current", "/anwendung", "/anwendung/wash_day"]) {
    assert.equal(shouldBypassPersonalPlanFrontierRedirect({ ...lapsed, pathname }), true, pathname)
  }

  // Never-paid: their routing source does not exist, so the frontier is `legacy` and the
  // redirect was already null — the bypass must not claim them.
  assert.equal(
    shouldBypassPersonalPlanFrontierRedirect({
      ...lapsed,
      pathname: "/routine",
      frontierKind: "legacy",
    }),
    false,
  )
  // A frontier outage keeps failing closed for everyone.
  assert.equal(
    shouldBypassPersonalPlanFrontierRedirect({
      ...lapsed,
      pathname: "/routine",
      frontierKind: "recovery",
    }),
    false,
  )
  // Premium: unchanged.
  assert.equal(
    shouldBypassPersonalPlanFrontierRedirect({
      ...lapsed,
      pathname: "/routine",
      hasPaidAppAccess: true,
    }),
    false,
  )
  // Flag off: unchanged.
  assert.equal(
    shouldBypassPersonalPlanFrontierRedirect({
      ...lapsed,
      pathname: "/routine",
      freemiumScannerFirstEnabled: false,
    }),
    false,
  )
  // A route the paywall did not evaluate (e.g. /auth) has no trustworthy paid-access
  // value, so it can never bypass.
  assert.equal(
    shouldBypassPersonalPlanFrontierRedirect({
      ...lapsed,
      pathname: "/auth",
      subscriptionChecked: false,
    }),
    false,
  )
  // Non-admitted routes are untouched.
  assert.equal(
    shouldBypassPersonalPlanFrontierRedirect({ ...lapsed, pathname: "/plan-start" }),
    false,
  )
})

// --- 8. End-to-end middleware: no bounce to /plan-start -> /reactivate -------

function createLapsedMiddleware(options: {
  frontier: "stage1" | "stage2" | "stage3" | "stage4" | "stage5" | "legacy"
  hasPaidAccess?: boolean
}) {
  const fakeSupabase = {
    auth: {
      getUser: async () => ({
        data: { user: { id: USER_ID, email: "lapsed@example.com", app_metadata: {} } },
      }),
    },
    from(table: string) {
      return {
        select(columns?: string) {
          return {
            eq() {
              return {
                maybeSingle: async () => {
                  if (table === "profiles") {
                    return {
                      data:
                        columns === "is_admin"
                          ? { is_admin: false }
                          : { onboarding_completed: true },
                    }
                  }
                  if (table === "hair_profiles") return { data: null }
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
      options.hasPaidAccess === true) as UpdateSessionDependencies["hasCurrentAppAccess"],
    hasCurrentPaidAppAccess: (async () =>
      options.hasPaidAccess === true) as UpdateSessionDependencies["hasCurrentPaidAppAccess"],
    resolveOneTimeAccessState: (async () =>
      "none") as UpdateSessionDependencies["resolveOneTimeAccessState"],
    resolveModeratorAccess: (async () =>
      "none") as UpdateSessionDependencies["resolveModeratorAccess"],
    getRouteEnvironment: () => ({ nodeEnv: "test", localDevLoginEnabled: false }),
    loadPersonalPlanRoutingFrontier: async () =>
      options.frontier === "legacy"
        ? { kind: "legacy" }
        : {
            kind: "personal_plan",
            frontier: options.frontier,
            nextHref:
              options.frontier === "stage5"
                ? "/anwendung"
                : options.frontier === "stage4"
                  ? "/routine"
                  : "/plan-start",
          },
  }

  return createUpdateSession(dependencies)
}

test("flag on: a lapsed owner mid-journey is NOT bounced off /routine or /anwendung", async () => {
  await withFlag(true, async () => {
    for (const pathname of ["/routine", "/anwendung"]) {
      const response = await createLapsedMiddleware({ frontier: "stage3" })(
        new NextRequest(`https://chaarlie.de${pathname}`),
      )
      assert.equal(response.status, 200, pathname)
      assert.equal(response.headers.get("location"), null, pathname)
    }
  })
})

// Flag off, the same user never even reaches the frontier: the subscription paywall turns
// them away first. That is the exact bounce T17 keeps intact for flag-off — and the reason
// the frontier redirect only becomes visible for this cohort once the flag admits them.
test("flag off: the same lapsed owner is turned away by the paywall itself (byte-identical)", async () => {
  await withFlag(false, async () => {
    for (const pathname of ["/routine", "/anwendung"]) {
      const response = await createLapsedMiddleware({ frontier: "stage3" })(
        new NextRequest(`https://chaarlie.de${pathname}`),
      )
      assert.equal(response.status, 307, pathname)
      const location = new URL(response.headers.get("location")!)
      assert.equal(location.pathname, "/reactivate", pathname)
      assert.equal(location.searchParams.get("reason"), "expired", pathname)
    }
  })
})

test("flag on: a never-paid free user's frontier is legacy, so nothing about their routing changes", async () => {
  await withFlag(true, async () => {
    const response = await createLapsedMiddleware({ frontier: "legacy" })(
      new NextRequest("https://chaarlie.de/routine"),
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("location"), null)
  })
})

test("flag on: a PAID mid-journey owner is still routed by the frontier", async () => {
  await withFlag(true, async () => {
    const response = await createLapsedMiddleware({ frontier: "stage3", hasPaidAccess: true })(
      new NextRequest("https://chaarlie.de/routine"),
    )
    assert.equal(response.status, 307)
    assert.equal(response.headers.get("location"), "https://chaarlie.de/plan-start")
  })
})

// --- 9. Anwendung: keepsake source, same pipeline ---------------------------

test("the keepsake Anwendung sources the plan from keepsake evidence, never from journey access", async () => {
  const loadRoutineVersionCalls: Array<[string, string, string]> = []
  const deps = {
    getUserId: async () => USER_ID,
    loadJourneyAccess: async () => {
      throw new Error("journey access must not be consulted in keepsake mode")
    },
    loadKeepsakeContent: async () => ({
      personalPlanId: PLAN_ID,
      activeRoutineVersionId: ROUTINE_VERSION_ID,
    }),
    loadRoutineVersion: async (userId: string, planId: string, versionId: string) => {
      loadRoutineVersionCalls.push([userId, planId, versionId])
      return null
    },
    adaptRoutine: (async () => ({})) as never,
    loadProfile: (async () => ({})) as never,
    loadContent: (() => ({
      loadActiveDayTypeDefinitions: async () => [],
      loadActiveGuidanceProtocols: async () => [],
    })) as never,
    createReadClient: (() => ({})) as never,
    appEnabled: () => true,
    stage4Enabled: () => true,
    reportFailure: () => {},
  } as never

  const view = await resolveAnwendungPage(deps, undefined, { keepsake: true })
  assert.equal(view.state, "no_active_routine")
  assert.deepEqual(loadRoutineVersionCalls, [[USER_ID, PLAN_ID, ROUTINE_VERSION_ID]])
})

test("keepsake mode without evidence yields no_active_routine, never a journey fallback", async () => {
  const view = await resolveAnwendungPage(
    {
      getUserId: async () => USER_ID,
      loadJourneyAccess: async () => {
        throw new Error("journey access must not be consulted in keepsake mode")
      },
      loadKeepsakeContent: async () => null,
      appEnabled: () => true,
      stage4Enabled: () => true,
      reportFailure: () => {},
    } as never,
    undefined,
    { keepsake: true },
  )
  assert.equal(view.state, "no_active_routine")
})

// --- 10. Nav badges match page reality (deferral 2) -------------------------

test("the nav paid-access signal is the email-aware composite, not a user-id-only lookup", async () => {
  const observed: Array<[string, string | null | undefined, boolean]> = []
  const resolveAccess = (async (
    userId: string,
    email: string | null | undefined,
    fieldTestGuest: boolean,
  ) => {
    observed.push([userId, email, fieldTestGuest])
    // The exact cohort the old lookup got wrong: an email-bound manual grant with no
    // `user_id` row. It resolves "allowed" only because the email is passed through.
    return email === "granted@example.com" ? "allowed" : "denied"
  }) as never

  const emailGranted = await resolveNavigationPaidAccess(USER_ID, {
    loadUser: async () => ({ id: USER_ID, email: "granted@example.com", app_metadata: {} }),
    resolveAccess,
  })
  assert.equal(emailGranted, true, "an email-grant holder must not see locked nav badges")
  assert.deepEqual(observed.at(-1), [USER_ID, "granted@example.com", false])

  const free = await resolveNavigationPaidAccess(USER_ID, {
    loadUser: async () => ({ id: USER_ID, email: "nobody@example.com", app_metadata: {} }),
    resolveAccess,
  })
  assert.equal(free, false, "a genuinely free user still gets the locked five-tab nav")

  // Field-test guests skip the moderator lookup, exactly as middleware does.
  await resolveNavigationPaidAccess(USER_ID, {
    loadUser: async () => ({
      id: USER_ID,
      email: "tester@example.com",
      app_metadata: { access_kind: "field_test" },
    }),
    resolveAccess,
  })
  assert.deepEqual(observed.at(-1), [USER_ID, "tester@example.com", true])

  // A session that is not this user contributes no email/metadata.
  await resolveNavigationPaidAccess(USER_ID, {
    loadUser: async () => ({ id: "someone-else", email: "granted@example.com" }),
    resolveAccess,
  })
  assert.deepEqual(observed.at(-1), [USER_ID, undefined, false])
})

test("an unreadable entitlement source fails closed to premium in the nav, never to a lock", async () => {
  assert.equal(
    await resolveNavigationPaidAccess(USER_ID, {
      loadUser: async () => ({ id: USER_ID, email: "user@example.com" }),
      resolveAccess: (async () => "unavailable") as never,
    }),
    true,
  )
})

test("the nav's paid-access read is still only reached behind the freemium flag", () => {
  const source = readSource("lib/personal-plan/navigation-access.ts")
  assert.match(
    source,
    /access\.kind === "legacy" && deps\.loadHasAppAccess && isFreemiumScannerFirstEnabled\(\)/,
  )
  assert.match(source, /loadUser: loadCachedAuthenticatedAppUser/)
  assert.match(source, /resolveAccess: resolvePaidAppAccess/)
})
