import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime"
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime"

import { GatedAnwendungExample } from "../src/components/gated-preview/gated-anwendung-example"
import { GatedChatExample } from "../src/components/gated-preview/gated-chat-example"
import { GatedRoutineExample } from "../src/components/gated-preview/gated-routine-example"
import { GATED_EXAMPLE_COPY } from "../src/lib/gated-preview/example-copy"
import { GATED_EXAMPLE_PRODUCTS } from "../src/lib/gated-preview/fixtures/example-products"
import { GATED_CHAT_EXAMPLE_MESSAGES } from "../src/lib/gated-preview/fixtures/chat-example"
import { resolveGatedPageMode, shouldRenderGatedExample } from "../src/lib/gated-preview/gate"
import {
  loadAuthenticatedAppAccessState,
  loadAuthenticatedAppPageTier,
  resolveAuthenticatedAppPageTier,
} from "../src/lib/auth/authenticated-app-route-access"
import { PREMIUM_FEATURES } from "../src/lib/premium-sheet/context"

/**
 * T12: the free tier's Routine / Anwendung / Chat are the REAL components fed static
 * example data, framed by T11's `GatedPreview`. These tests pin the two halves that a
 * refactor could silently break: which tier gets the example at all, and what the example
 * actually says.
 */

// --- tier branching ---------------------------------------------------------

test("only the free tier renders the example", async () => {
  assert.equal(await shouldRenderGatedExample(async () => "free"), true)
  assert.equal(await shouldRenderGatedExample(async () => "premium"), false)
})

// PR3 Codex fix (X1): the billing reads behind the tier composite throw on a query error
// instead of returning "unavailable" (see src/lib/billing/subscriptions.ts,
// src/lib/billing/purchases.ts). Uncaught, that throw used to become a hard server error on
// /chat and reject the whole Promise.all on /routine and /anwendung. `shouldRenderGatedExample`
// must fail closed to premium (never free, never a rethrow) for any tier-lookup failure,
// exactly like a returned "unavailable" already does.
test("a thrown tier-lookup failure fails closed to premium, not a rethrow", async () => {
  const rendersExample = await shouldRenderGatedExample(async () => {
    throw new Error("billing read failed")
  })
  assert.equal(rendersExample, false)
})

test("a thrown failure anywhere in the real tier composite (getUser or the paid-access read) still fails closed to premium", async () => {
  const throwingGetUser = await shouldRenderGatedExample(() =>
    resolveAuthenticatedAppPageTier({
      getUser: async () => {
        throw new Error("auth.getUser() unavailable")
      },
      resolvePaidAccess: async () => "denied",
    }),
  )
  assert.equal(throwingGetUser, false)

  const throwingBillingRead = await shouldRenderGatedExample(() =>
    resolveAuthenticatedAppPageTier({
      getUser: async () => ({ id: "user-1", email: "user@example.com" }),
      resolvePaidAccess: async () => {
        throw new Error("findCurrentBillingSubscriptionForUser: query failed")
      },
    }),
  )
  assert.equal(throwingBillingRead, false)
})

test("with the freemium flag off the tier resolves premium without any lookup", async () => {
  const previous = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  try {
    // No Supabase client is created and no billing/moderator read happens: the loader
    // returns before `createClient()`, which is why this call can run at all in a plain
    // node test with no request context.
    assert.equal(await loadAuthenticatedAppPageTier(), "premium")
    assert.equal(await shouldRenderGatedExample(), false)
    // T17: the three pages branch on `resolveGatedPageMode`, whose flag-off short-circuit
    // is the same one — `"premium"` before any client is created, so neither the tier
    // composite nor the keepsake read happens.
    assert.equal(await loadAuthenticatedAppAccessState(), "premium")
    assert.equal(await resolveGatedPageMode(), "premium")
  } finally {
    if (previous === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = previous
  }
})

const SOURCE_ROOT = path.resolve(process.cwd(), "src")

const GATED_ROUTES = [
  ["app/routine/page.tsx", "GatedRoutineExample"],
  ["app/anwendung/page.tsx", "GatedAnwendungExample"],
  ["app/chat/page.tsx", "GatedChatExample"],
  ["app/chat/[conversationId]/page.tsx", "GatedChatExample"],
] as const

for (const [route, component] of GATED_ROUTES) {
  test(`${route} gates on the server tier before it renders the real page`, () => {
    const source = readFileSync(path.join(SOURCE_ROOT, route), "utf8")
    const gate = source.indexOf("resolveGatedPageMode()")
    assert.ok(gate > -1, `${route} must derive the tier server-side`)
    // The window is a readability bound, not a contract: PR5's keepsake branch (Z2's
    // routine-less state) sits between the gate and the free-tier return on /routine.
    assert.match(
      source.slice(gate, gate + 1500),
      new RegExp(`return <${component} \\/>`),
      `${route} must return the example for the free tier`,
    )
    // The gate is a guard clause, not a wrapper: everything the real page does still
    // happens verbatim below it for premium and for flag-off.
    assert.ok(source.indexOf("resolveGatedPageMode") < source.lastIndexOf("return"))
  })
}

// Pre-boundary fix wave, finding F2: `/routine` and `/anwendung` used to await the tier
// check BEFORE starting their own page resolver, serializing one auth.getUser() plus a
// billing/moderator composite ahead of every premium render. They now start the tier
// check and the resolver in the same `Promise.all`, so the composite's cost overlaps the
// resolver's own reads instead of sitting in front of them. This pins the concurrency,
// not just the outcome — a regression back to sequential awaits would still pass the
// gating test above (the free/premium behaviour is unchanged either way) but would silently
// reintroduce the latency finding closed this wave.
test("routine and anwendung resolve the tier concurrently with their own page data (F2)", () => {
  const cases = [
    ["app/routine/page.tsx", "resolveDefaultRoutinePage"],
    ["app/anwendung/page.tsx", "resolveDefaultAnwendungPage"],
  ] as const

  for (const [route, resolver] of cases) {
    const source = readFileSync(path.join(SOURCE_ROOT, route), "utf8")
    const gate = source.indexOf("resolveGatedPageMode()")
    assert.ok(gate > -1, `${route} must derive the tier server-side`)
    // Both files also use `Promise.all` internally (parallel content/DB reads inside the
    // resolver itself) — find the one that actually wraps the tier check, not the first
    // occurrence in the file.
    const promiseAll = source.lastIndexOf("Promise.all([", gate)
    assert.ok(promiseAll > -1, `${route}: tier check and resolver must start concurrently`)
    const closing = source.indexOf("])", promiseAll)
    assert.ok(closing > -1, `${route}: unterminated Promise.all`)
    const block = source.slice(promiseAll, closing)
    assert.match(
      block,
      /resolveGatedPageMode\(\)/,
      `${route}: tier check must be inside the Promise.all`,
    )
    assert.match(
      block,
      new RegExp(resolver),
      `${route}: page resolver must be inside the same Promise.all`,
    )
  }
  // `/chat` has no server-side page resolver of its own to run the tier check alongside
  // (`ChatContainer` loads its data client-side) — see the code comment in
  // `app/chat/page.tsx` and the PR3 Codex fix (X2) test below for how that page instead
  // streams the tier check behind Suspense.
})

// PR3 Codex fix (X2, controller ruling): flag on streams `/chat`'s tier-resolved segment
// behind a Suspense boundary instead of awaiting it in the page body (so the page shell isn't
// serialized behind one `auth.getUser()` plus the paid-access composite); flag off stays the
// literal pre-branch page — no tier call, no Suspense wrapper, byte-identical to today. This
// pins both halves of that split so a regression back to one unconditional
// `await resolveGatedPageMode()` (reintroducing the added latency on every premium
// render) — or a Suspense wrapper that also wraps the flag-off branch (breaking byte-identity)
// — fails this test even though the free/premium behaviour it renders is unchanged either way.
test("/chat streams the tier check behind Suspense only when the flag is on; flag off stays branch-free (X2)", () => {
  const source = readFileSync(path.join(SOURCE_ROOT, "app/chat/page.tsx"), "utf8")

  const flagOffGuard = source.indexOf("if (!isFreemiumScannerFirstEnabled())")
  assert.ok(flagOffGuard > -1, "flag-off must be an explicit, separate branch")
  const flagOffLine = source.slice(flagOffGuard, source.indexOf("\n", flagOffGuard))
  assert.match(
    flagOffLine,
    /return <ChatContainer \/>/,
    "flag off must return ChatContainer directly, with no tier call and no Suspense",
  )
  const suspenseIndex = source.indexOf("<Suspense")
  assert.ok(suspenseIndex > flagOffGuard, "the Suspense boundary is the flag-on path only")
  const suspenseBlock = source.slice(suspenseIndex, source.indexOf("</Suspense>", suspenseIndex))
  assert.match(
    suspenseBlock,
    /<ChatTierSegment \/>/,
    "the Suspense boundary must stream the tier-resolved segment",
  )

  // `ChatTierSegment` — not the exported page component — is what actually calls the tier
  // check and branches on it, so it can be the async child a Suspense boundary streams.
  const segmentStart = source.indexOf("async function ChatTierSegment")
  assert.ok(segmentStart > -1, "the tier branch must live in its own async segment component")
  const segmentEnd = source.indexOf("\n}", segmentStart)
  const segmentBody = source.slice(segmentStart, segmentEnd)
  assert.match(segmentBody, /resolveGatedPageMode\(\)/)
  assert.match(segmentBody, /return <GatedChatExample \/>/)
  assert.match(segmentBody, /return <ChatContainer \/>/)

  // The exported page itself must not be `async` — flag off must resolve synchronously,
  // matching the pre-T12 page's immediate render with zero added server-side latency.
  assert.doesNotMatch(
    source,
    /export default async function ChatPage/,
    "ChatPage itself must not be async — only ChatTierSegment awaits the tier check",
  )
})

// --- copy -------------------------------------------------------------------

test("each page has its own benefit line, never the sheet's own copy and never a generic pitch", () => {
  const benefits = Object.values(GATED_EXAMPLE_COPY).map((copy) => copy.benefit)
  assert.equal(new Set(benefits).size, benefits.length, "no page repeats another's benefit")

  for (const copy of Object.values(GATED_EXAMPLE_COPY)) {
    // T11 carry-forward 2: the sheet shows `PREMIUM_FEATURES[feature].benefit` the moment
    // the CTA opens it — repeating it above the CTA would say it twice in two seconds.
    assert.notEqual(copy.benefit, PREMIUM_FEATURES[copy.feature].benefit)
    assert.doesNotMatch(copy.cta, /Premium freischalten/)
    assert.match(copy.exampleLabel, /^Beispiel · /)
    // Benefit-framed: the CTA names what the reader unlocks, not the product tier.
    assert.match(copy.cta, /freischalten$/)
  }
})

test("the sheet context is the page's own", () => {
  assert.deepEqual(
    Object.values(GATED_EXAMPLE_COPY).map(({ feature, source }) => ({ feature, source })),
    [
      { feature: "routine", source: "gated:routine" },
      { feature: "anwendung", source: "gated:anwendung" },
      { feature: "chat", source: "gated:chat" },
    ],
  )
})

// --- rendered examples ------------------------------------------------------

/**
 * T14: `PremiumSheet` (mounted by every gated composition) now uses the app router to
 * refresh the surface after a purchase. `useRouter`/`usePathname` throw outside the App
 * Router's own contexts, which a bare `renderToStaticMarkup` does not provide — so supply
 * them here. The router is a throwing stub on purpose: a gated render that navigates or
 * refreshes would be exactly the mutation these tests exist to forbid.
 */
function withAppRouter(node: React.ReactElement): React.ReactElement {
  const router = {
    back: () => {
      throw new Error("gated render must not navigate")
    },
    forward: () => {
      throw new Error("gated render must not navigate")
    },
    push: () => {
      throw new Error("gated render must not navigate")
    },
    replace: () => {
      throw new Error("gated render must not navigate")
    },
    refresh: () => {
      throw new Error("gated render must not refresh")
    },
    prefetch: () => {},
  }
  return (
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/routine">{node}</PathnameContext.Provider>
    </AppRouterContext.Provider>
  )
}

function render(Composition: () => React.ReactElement) {
  return renderToStaticMarkup(withAppRouter(<Composition />))
}

test("the Routine example is the real Routine page, filled with real catalog products", () => {
  const html = render(GatedRoutineExample)

  assert.match(html, /Deine Routine/)
  assert.match(html, /Deine Basis/)
  assert.match(html, /Optional/)
  // Five included products — the copy the real page derives from the payload.
  assert.match(html, /Deine Routine mit 5 Produkten\./)

  for (const product of Object.values(GATED_EXAMPLE_PRODUCTS)) {
    assert.ok(
      html.includes(product.displayName.replace(/&/g, "&amp;")),
      `${product.displayName} appears in the example`,
    )
    assert.ok(html.includes(product.imageUrl), `${product.displayName} shows its catalog image`)
  }

  // No live affordance survived: no „Anpassen", no detail buttons, no basis gap.
  assert.doesNotMatch(html, /Anpassen/)
  assert.doesNotMatch(html, /data-routine-detail-button/)
  assert.doesNotMatch(html, /Basis-Baustein fehlt/)
  assert.doesNotMatch(html, /Änderungen prüfen/)
})

test("the Anwendung example shows populated days, not empty ones", () => {
  const html = render(GatedAnwendungExample)

  assert.match(html, /Anwendung/)
  assert.match(html, /Waschtag/)
  assert.match(html, /Intensivpflegetag/)
  assert.match(html, /Stylingtag/)
  assert.match(html, /Pausentag/)

  // Nick's explicit requirement: days carry actual products. Every non-rest day puts a
  // real product on its shelf, so no day renders as a row of empty silhouettes.
  const openSlots = html.match(/data-application-shelf-slot="open"/g) ?? []
  assert.equal(openSlots.length, 0, "no open/unresolved shelf slot in the example")
  assert.match(html, /data-application-shelf-slot="confirmed"/)
  assert.match(html, /data-application-rest-day-visual/, "the Pausentag keeps its rest visual")

  // Nothing is „teilweise bereit" — an example must not model a broken plan.
  assert.doesNotMatch(html, /Teilweise bereit/)
  assert.doesNotMatch(html, /Detail(s)? offen/)
})

test("the Chat example is a short, capability-true transcript through the real bubbles", () => {
  const html = render(GatedChatExample)

  assert.match(html, /data-testid="message-user"/)
  assert.match(html, /data-testid="message-assistant"/)
  assert.match(html, /data-testid="chat-input"/)
  assert.match(html, /disabled=""/, "the composer renders visibly unusable")

  // Short: Nick asked for something short — two turns, four messages.
  assert.equal(GATED_CHAT_EXAMPLE_MESSAGES.length, 4)
  assert.equal(GATED_CHAT_EXAMPLE_MESSAGES.filter((m) => m.role === "user").length, 2)

  const transcript = GATED_CHAT_EXAMPLE_MESSAGES.map((m) => m.content ?? "").join("\n")
  // Capability-true: general hair-care Q&A the paid chat genuinely does. No scan-aware
  // claim and no verdict explanation — those are explicitly forbidden content here.
  for (const forbidden of [/scan/i, /gescannt/i, /verdict/i, /passt nicht/i, /Merkliste/i]) {
    assert.doesNotMatch(transcript, forbidden, `the transcript must not claim ${forbidden}`)
  }
  // No feedback affordance and no product card: both need live handlers.
  assert.doesNotMatch(html, /Antwort positiv bewerten/)
  assert.doesNotMatch(html, /weitere Empfehlungen/)
})

test("no example message carries a timestamp — a formatted one would mismatch on hydration", () => {
  for (const message of GATED_CHAT_EXAMPLE_MESSAGES) {
    assert.equal(message.created_at, "")
  }
  assert.doesNotMatch(render(GatedChatExample), /type-caption text-muted-foreground">\d\d:\d\d/)
})

test("every example is framed by GatedPreview with its own label, benefit and one CTA", () => {
  const pages = [
    [GatedRoutineExample, GATED_EXAMPLE_COPY.routine],
    [GatedAnwendungExample, GATED_EXAMPLE_COPY.anwendung],
    [GatedChatExample, GATED_EXAMPLE_COPY.chat],
  ] as const

  for (const [Composition, copy] of pages) {
    const html = render(Composition)
    assert.match(html, new RegExp(`data-gated-preview="${copy.feature}"`))
    assert.ok(html.includes(copy.exampleLabel), `${copy.feature}: „Beispiel" band`)
    assert.ok(html.includes(copy.benefit), `${copy.feature}: benefit line`)
    assert.ok(html.includes(copy.cta), `${copy.feature}: CTA`)
    assert.equal(
      (html.match(/data-gated-preview-cta-block/g) ?? []).length,
      1,
      `${copy.feature}: exactly one CTA block`,
    )
  }
})
