import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { AuthenticatedAppShell } from "../src/components/layout/authenticated-app-shell"
import { PersonalPlanNavigationView } from "../src/components/layout/personal-plan-navigation"
import type {
  NavSurfaceVisitedState,
  PersonalPlanLifecycleClient,
} from "../src/lib/personal-plan/lifecycle/repository"
import {
  resolveAuthenticatedAppNavigationAccess,
  schedulePersonalPlanNavSurfaceVisit,
  toAuthenticatedAppNavigationAccess,
  type AuthenticatedAppNavigationAccess,
  type PersonalPlanNavigationItem,
  type SchedulePersonalPlanNavSurfaceVisitDeps,
} from "../src/lib/personal-plan/navigation-access"
import type { PersonalPlanJourneyAccess } from "../src/lib/personal-plan/journey-access"

function personalPlanAccess(
  stage4: boolean,
  stage5: boolean,
): Extract<PersonalPlanJourneyAccess, { kind: "personal_plan" }> {
  return {
    kind: "personal_plan",
    personalPlanId: "plan-1",
    frontier: stage5 ? "stage5" : stage4 ? "stage4" : "stage3",
    nextHref: stage5 ? "/anwendung" : stage4 ? "/routine" : "/plan-start",
    allowed: { stage1: true, stage2: true, stage3: true, stage4, stage5 },
  }
}

test("Personal Plan navigation always exposes the same five tabs in the signed order, regardless of stage access", () => {
  const fixedItems = [
    { key: "chat", href: "/chat", label: "Chat" },
    { key: "routine", href: "/routine", label: "Routine" },
    { key: "scan", href: "/scan", label: "Scan" },
    { key: "application", href: "/anwendung", label: "Anwendung" },
    { key: "profile", href: "/profile", label: "Profil" },
  ]
  for (const [stage4, stage5] of [
    [false, false],
    [true, false],
    [true, true],
  ] as const) {
    assert.deepEqual(toAuthenticatedAppNavigationAccess(personalPlanAccess(stage4, stage5)), {
      kind: "personal_plan",
      hasPendingRoutineProposal: false,
      items: fixedItems,
      unvisitedNavSurfaces: new Set(),
      hasRoutineAccess: stage4,
      tier: "premium",
    })
  }
})

test("Personal Plan navigation carries the already-authoritative routine-attention state", () => {
  const access = {
    ...personalPlanAccess(true, false),
    hasPendingRoutineProposal: true,
  } as PersonalPlanJourneyAccess
  const navigation = toAuthenticatedAppNavigationAccess(access)

  assert.equal(navigation.kind, "personal_plan")
  assert.equal(navigation.hasPendingRoutineProposal, true)
})

// --- Nav-visited dots (Task 2.9, decision 14) --------------------------------

test("an unvisited tab dots, a visited one doesn't, and routine never dots even when unvisited", () => {
  const navVisitedState: NavSurfaceVisitedState = {
    available: true,
    visitedSurfaces: new Set(["profile"]),
  }
  const navigation = toAuthenticatedAppNavigationAccess(
    personalPlanAccess(true, true),
    navVisitedState,
  )

  assert.equal(navigation.kind, "personal_plan")
  if (navigation.kind !== "personal_plan") return
  assert.deepEqual(
    [...navigation.unvisitedNavSurfaces].sort(),
    ["application", "chat", "scan"].sort(),
  )
  assert.equal(navigation.unvisitedNavSurfaces.has("profile"), false)
  assert.equal(navigation.unvisitedNavSurfaces.has("routine"), false)
})

test("an unavailable nav-visited read (pre-migration) renders zero dots, never all of them", () => {
  const unavailable: NavSurfaceVisitedState = { available: false, visitedSurfaces: new Set() }
  const navigation = toAuthenticatedAppNavigationAccess(personalPlanAccess(true, true), unavailable)

  assert.equal(navigation.kind, "personal_plan")
  if (navigation.kind !== "personal_plan") return
  assert.deepEqual([...navigation.unvisitedNavSurfaces], [])
})

test("omitting the nav-visited state entirely also renders zero dots (safe default)", () => {
  const navigation = toAuthenticatedAppNavigationAccess(personalPlanAccess(true, true))
  assert.equal(navigation.kind, "personal_plan")
  if (navigation.kind !== "personal_plan") return
  assert.deepEqual([...navigation.unvisitedNavSurfaces], [])
})

test("resolveAuthenticatedAppNavigationAccess wires the nav-visited read through for a Personal Plan destination", async () => {
  let loadNavVisitedStateCalls = 0
  const navigation = await resolveAuthenticatedAppNavigationAccess({
    getUserId: async () => "user-1",
    loadJourneyAccess: async () => personalPlanAccess(true, false),
    loadNavVisitedState: async (userId) => {
      loadNavVisitedStateCalls += 1
      assert.equal(userId, "user-1")
      return { available: true, visitedSurfaces: new Set() }
    },
  })

  assert.equal(loadNavVisitedStateCalls, 1)
  assert.equal(navigation.kind, "personal_plan")
  if (navigation.kind !== "personal_plan") return
  assert.deepEqual(
    [...navigation.unvisitedNavSurfaces].sort(),
    ["application", "chat", "profile", "scan"].sort(),
  )
})

test("resolveAuthenticatedAppNavigationAccess skips the nav-visited read entirely for legacy destinations", async () => {
  let loadNavVisitedStateCalls = 0
  const navigation = await resolveAuthenticatedAppNavigationAccess({
    getUserId: async () => "user-1",
    loadJourneyAccess: async () => ({ kind: "legacy" }),
    loadNavVisitedState: async () => {
      loadNavVisitedStateCalls += 1
      return { available: true, visitedSurfaces: new Set() }
    },
  })

  assert.deepEqual(navigation, { kind: "legacy" })
  assert.equal(loadNavVisitedStateCalls, 0)
})

test("the rendered nav shows a dot only on an unvisited, non-routine tab", () => {
  // chat and routine are visited; scan, application, and profile are not.
  const navigation = toAuthenticatedAppNavigationAccess(personalPlanAccess(true, true), {
    available: true,
    visitedSurfaces: new Set(["chat", "routine"]),
  })
  assert.equal(navigation.kind, "personal_plan")
  if (navigation.kind !== "personal_plan") return
  assert.deepEqual(
    [...navigation.unvisitedNavSurfaces].sort(),
    ["application", "profile", "scan"].sort(),
  )

  // pathname pinned to "/chat" — an already-visited surface, not one of the
  // unvisited ones under test — so this test's dot assertions are
  // unaffected by the active-tab suppression covered separately below.
  const html = renderToStaticMarkup(
    createElement(PersonalPlanNavigationView, {
      items: navigation.items,
      pathname: "/chat",
      unvisitedNavSurfaces: navigation.unvisitedNavSurfaces,
    }),
  )
  // One dot per unvisited surface, doubled for the header + mobile tab bar renders
  // (the header also has an unrelated "/chat" logo link with no dot).
  assert.equal((html.match(/data-nav-unvisited-dot="true"/g) ?? []).length, 6)

  const headerNav = html.match(
    /<nav aria-label="Personal-Plan-Navigation"[^>]*>[\s\S]*?<\/nav>/,
  )?.[0]
  const mobileNav = html.match(
    /<nav aria-label="Personal-Plan-Navigation \(mobil\)"[^>]*>[\s\S]*?<\/nav>/,
  )?.[0]
  assert.ok(headerNav && mobileNav, "expected both the header and mobile nav markup")

  const linkFor = (nav: string, href: string) =>
    nav.match(new RegExp(`<a[^>]*href="${href}"[^>]*>[\\s\\S]*?</a>`))?.[0]

  for (const nav of [headerNav!, mobileNav!]) {
    for (const href of ["/chat", "/routine"]) {
      const link = linkFor(nav, href)
      assert.ok(link, `expected a nav link for ${href}`)
      assert.doesNotMatch(link!, /data-nav-unvisited-dot/)
    }
    for (const href of ["/scan", "/anwendung", "/profile"]) {
      const link = linkFor(nav, href)
      assert.ok(link, `expected a nav link for ${href}`)
      assert.match(link!, /data-nav-unvisited-dot="true"/)
    }
  }
})

test("fix round 1: the active tab never dots even when it's still in unvisitedNavSurfaces (the deferred after() write hasn't landed yet)", () => {
  // Simulates the very first visit to /anwendung: the server read that
  // produced `unvisitedNavSurfaces` ran BEFORE this render's visit-marking
  // write (deferred via after()), so "application" is still unvisited on
  // the render that's currently showing it.
  const navigation = toAuthenticatedAppNavigationAccess(personalPlanAccess(true, true), {
    available: true,
    visitedSurfaces: new Set(),
  })
  assert.equal(navigation.kind, "personal_plan")
  if (navigation.kind !== "personal_plan") return
  assert.ok(
    navigation.unvisitedNavSurfaces.has("application"),
    "test setup: application must be unvisited",
  )

  const html = renderToStaticMarkup(
    createElement(PersonalPlanNavigationView, {
      items: navigation.items,
      pathname: "/anwendung",
      unvisitedNavSurfaces: navigation.unvisitedNavSurfaces,
    }),
  )

  const headerNav = html.match(
    /<nav aria-label="Personal-Plan-Navigation"[^>]*>[\s\S]*?<\/nav>/,
  )?.[0]
  const mobileNav = html.match(
    /<nav aria-label="Personal-Plan-Navigation \(mobil\)"[^>]*>[\s\S]*?<\/nav>/,
  )?.[0]
  assert.ok(headerNav && mobileNav, "expected both the header and mobile nav markup")

  const linkFor = (nav: string, href: string) =>
    nav.match(new RegExp(`<a[^>]*href="${href}"[^>]*>[\\s\\S]*?</a>`))?.[0]

  for (const nav of [headerNav!, mobileNav!]) {
    // The active tab (application/"/anwendung") never dots, active-tab
    // suppression aside from persisted visited state.
    const activeLink = linkFor(nav, "/anwendung")
    assert.ok(activeLink, "expected a nav link for /anwendung")
    assert.doesNotMatch(activeLink!, /data-nav-unvisited-dot/)

    // Every OTHER unvisited, non-active, non-routine surface still dots —
    // the suppression is scoped to the active tab only.
    for (const href of ["/chat", "/scan", "/profile"]) {
      const link = linkFor(nav, href)
      assert.ok(link, `expected a nav link for ${href}`)
      assert.match(link!, /data-nav-unvisited-dot="true"/)
    }
  }
})

test("with no unvisited surfaces, no dot renders at all", () => {
  const navigation = toAuthenticatedAppNavigationAccess(personalPlanAccess(true, true))
  assert.equal(navigation.kind, "personal_plan")
  if (navigation.kind !== "personal_plan") return

  const html = renderToStaticMarkup(
    createElement(PersonalPlanNavigationView, { items: navigation.items, pathname: "/chat" }),
  )
  assert.doesNotMatch(html, /data-nav-unvisited-dot/)
})

test("legacy, paid-pending, and navigation read failures keep exactly one legacy Header", async () => {
  assert.deepEqual(toAuthenticatedAppNavigationAccess({ kind: "legacy" }), { kind: "legacy" })
  assert.deepEqual(
    toAuthenticatedAppNavigationAccess({ kind: "paid_pending", recoveryHref: "/plan-bereit" }),
    { kind: "legacy" },
  )

  const navigation = await resolveAuthenticatedAppNavigationAccess({
    getUserId: async () => "user-1",
    loadJourneyAccess: async () => {
      throw new Error("database unavailable")
    },
  })
  const html = renderToStaticMarkup(
    createElement(AuthenticatedAppShell, {
      navigation,
      legacyHeader: createElement("header", { "data-legacy-header": true }, "Legacy"),
      personalPlanNavigation: createElement(
        "nav",
        { "data-personal-plan-navigation": true },
        "Personal Plan",
      ),
      children: createElement("main", null, "Nutzbarer Inhalt"),
    }),
  )

  assert.equal((html.match(/data-legacy-header/g) ?? []).length, 1)
  assert.doesNotMatch(html, /data-personal-plan-navigation/)
  assert.match(html, /Nutzbarer Inhalt/)
  assert.doesNotMatch(html, /personal-plan-shell-bottom-padding/)
})

test("the signed navigation marks the current destination and the shell owns its bottom clearance", () => {
  const navigation = toAuthenticatedAppNavigationAccess(personalPlanAccess(true, true))
  assert.equal(navigation.kind, "personal_plan")
  const navHtml = renderToStaticMarkup(
    createElement(PersonalPlanNavigationView, {
      items: navigation.items,
      pathname: "/anwendung/wash_day",
    }),
  )
  // Die Navigation existiert doppelt: Header-Links (md+) und Tab-Bar (mobil, md:hidden).
  assert.match(navHtml, /aria-label="Personal-Plan-Navigation"/)
  assert.match(navHtml, /aria-label="Personal-Plan-Navigation \(mobil\)"/)
  assert.equal((navHtml.match(/aria-current="page"/g) ?? []).length, 2)
  assert.match(navHtml, /aria-current="page"[^>]*href="\/anwendung"/)
  assert.equal((navHtml.match(/>Chat</g) ?? []).length, 2)
  assert.equal((navHtml.match(/>Routine</g) ?? []).length, 2)
  assert.equal((navHtml.match(/>Scan</g) ?? []).length, 2)
  assert.equal((navHtml.match(/>Anwendung</g) ?? []).length, 2)
  assert.equal((navHtml.match(/>Profil</g) ?? []).length, 2)
  // Five fixed destinations, always in the same order (product ruling
  // 2026-08-31: navigation composition never changes per user).
  assert.equal(navigation.items.length, 5)
  assert.equal(navigation.items[2]?.key, "scan")
  assert.equal(navigation.items[3]?.key, "application")

  const shellHtml = renderToStaticMarkup(
    createElement(AuthenticatedAppShell, {
      navigation,
      legacyHeader: createElement("header", null, "Legacy"),
      personalPlanNavigation: createElement("nav", null, "Personal Plan"),
      children: createElement("main", null, "Inhalt"),
    }),
  )
  assert.match(shellHtml, /--personal-plan-shell-bottom-padding/)
  assert.match(shellHtml, /data-personal-plan-content="true"/)
  // Padding jetzt als responsive Klasse (mobil aktiv, ab md entfällt die Tab-Bar-Kompensation);
  // die Variable selbst bleibt konstant, weil application-state seine Höhe daraus ableitet.
  assert.match(shellHtml, /pb-\[var\(--personal-plan-shell-bottom-padding\)\] md:pb-0/)
  assert.doesNotMatch(shellHtml, /md:\[--personal-plan-shell-bottom-padding/)
  assert.doesNotMatch(shellHtml, /Legacy/)
})

test("the server shell owns Header presentation without changing the shared Header", () => {
  const header = readFileSync("src/components/layout/header.tsx", "utf8")
  assert.equal((header.match(/href="\/anwendung"/g) ?? []).length, 0)
  assert.match(header, /RoutineAttentionIndicator/)

  for (const layout of ["chat", "routine", "scan", "anwendung", "profile"]) {
    const source = readFileSync(`src/app/${layout}/layout.tsx`, "utf8")
    assert.match(source, /AuthenticatedAppShell/)
    assert.match(source, /loadAuthenticatedAppNavigationAccess/)
  }

  for (const file of [
    "src/app/chat/page.tsx",
    "src/app/chat/[conversationId]/page.tsx",
    "src/app/routine/page.tsx",
    "src/app/scan/page.tsx",
    "src/app/anwendung/page.tsx",
    "src/app/anwendung/loading.tsx",
    "src/app/profile/page.tsx",
    "src/components/routine/routine-page-client.tsx",
  ]) {
    const source = readFileSync(file, "utf8")
    assert.doesNotMatch(source, /<Header\b/)
    assert.doesNotMatch(source, /components\/layout\/header/)
  }
})

test("journey access is request-cached for shell and guarded page composition", () => {
  const navigationSource = readFileSync("src/lib/personal-plan/navigation-access.ts", "utf8")
  const routineSource = readFileSync("src/app/routine/page.tsx", "utf8")
  const applicationSource = readFileSync("src/app/anwendung/page.tsx", "utf8")
  assert.match(navigationSource, /cache\(/)
  assert.match(navigationSource, /loadCachedPersonalPlanJourneyAccessForUser/)
  assert.match(navigationSource, /loadCachedAuthenticatedAppUserId = cache/)
  assert.match(routineSource, /loadCachedPersonalPlanJourneyAccessForUser/)
  assert.match(routineSource, /getUserId: loadCachedAuthenticatedAppUserId/)
  assert.match(applicationSource, /loadCachedPersonalPlanJourneyAccessForUser/)
  assert.match(applicationSource, /getUserId: loadCachedAuthenticatedAppUserId/)
  assert.match(applicationSource, /journey\.activeRoutineVersionId/)
  assert.match(applicationSource, /loadPersonalPlanActiveRoutineVersion/)
})

test("regular Chat consumes Personal Plan clearance in the viewport once and keeps its own safe area", () => {
  const containerSource = readFileSync("src/components/chat/chat-container.tsx", "utf8")
  const inputSource = readFileSync("src/components/chat/chat-input.tsx", "utf8")

  assert.match(
    containerSource,
    /h-\[calc\(100dvh-3\.5rem-var\(--personal-plan-shell-bottom-padding,0px\)\)\]/,
  )
  assert.match(inputSource, /env\(safe-area-inset-bottom\)/)
  assert.doesNotMatch(inputSource, /personal-plan-shell-bottom-padding/)
})

// --- schedulePersonalPlanNavSurfaceVisit (Task 2.9 visit-marking) -----------

function fakeLifecycleClient(onUpsert: (row: Record<string, unknown>) => { error: unknown }) {
  return {
    from() {
      const query = {
        upsert: async (row: Record<string, unknown>) => onUpsert(row),
      }
      return query as unknown as ReturnType<PersonalPlanLifecycleClient["from"]>
    },
  } as PersonalPlanLifecycleClient
}

test("visiting an already-visited surface never schedules a write", async () => {
  let scheduled = 0
  const navigation = toAuthenticatedAppNavigationAccess(personalPlanAccess(true, true), {
    available: true,
    visitedSurfaces: new Set(["chat"]),
  })

  const deps: SchedulePersonalPlanNavSurfaceVisitDeps = {
    loadUserId: async () => "user-1",
    scheduleAfter: (() => {
      scheduled += 1
    }) as SchedulePersonalPlanNavSurfaceVisitDeps["scheduleAfter"],
  }
  await schedulePersonalPlanNavSurfaceVisit(navigation, "chat", deps)

  assert.equal(scheduled, 0)
})

test("visiting a legacy (non-Personal-Plan) destination never schedules a write", async () => {
  let scheduled = 0
  await schedulePersonalPlanNavSurfaceVisit({ kind: "legacy" }, "chat", {
    scheduleAfter: () => {
      scheduled += 1
    },
  })
  assert.equal(scheduled, 0)
})

test("visiting an unvisited surface schedules exactly one deferred write that records the visit", async () => {
  const upserts: Record<string, unknown>[] = []
  const navigation = toAuthenticatedAppNavigationAccess(personalPlanAccess(true, true), {
    available: true,
    visitedSurfaces: new Set(),
  })

  let scheduledTask: (() => unknown) | null = null
  await schedulePersonalPlanNavSurfaceVisit(navigation, "profile", {
    loadUserId: async () => "user-1",
    client: () =>
      fakeLifecycleClient((row) => {
        upserts.push(row)
        return { error: null }
      }),
    now: () => "2026-08-26T00:00:00.000Z",
    scheduleAfter: (task) => {
      scheduledTask = task as () => unknown
    },
  })

  assert.equal(typeof scheduledTask, "function")
  assert.equal(upserts.length, 0, "the write must not happen before the deferred task runs")
  await scheduledTask!()
  assert.deepEqual(upserts, [
    {
      user_id: "user-1",
      kind: "nav_surface_visited",
      subject: "profile",
      marked_at: "2026-08-26T00:00:00.000Z",
    },
  ])
})

test("a pre-migration write failure inside the deferred task is swallowed, not thrown", async () => {
  const navigation = toAuthenticatedAppNavigationAccess(personalPlanAccess(true, true), {
    available: true,
    visitedSurfaces: new Set(),
  })

  let scheduledTask: (() => Promise<unknown>) | null = null
  await schedulePersonalPlanNavSurfaceVisit(navigation, "profile", {
    loadUserId: async () => "user-1",
    client: () => fakeLifecycleClient(() => ({ error: { code: "42P01" } })),
    scheduleAfter: (task) => {
      scheduledTask = task as () => Promise<unknown>
    },
  })

  await assert.doesNotReject(() => scheduledTask!())
})

test("no user id resolves to a no-op: nothing is scheduled", async () => {
  let scheduled = 0
  const navigation = toAuthenticatedAppNavigationAccess(personalPlanAccess(true, true), {
    available: true,
    visitedSurfaces: new Set(),
  })

  await schedulePersonalPlanNavSurfaceVisit(navigation, "profile", {
    loadUserId: async () => null,
    scheduleAfter: () => {
      scheduled += 1
    },
  })

  assert.equal(scheduled, 0)
})

// --- T3: freemium shell + nav for free users (flag-gated) -------------------

function withFreemiumScannerFirstFlag(enabled: boolean, run: () => Promise<void> | void) {
  const original = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  if (enabled) process.env.FREEMIUM_SCANNER_FIRST_ENABLED = "true"
  else delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  return Promise.resolve(run()).finally(() => {
    if (original === undefined) delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    else process.env.FREEMIUM_SCANNER_FIRST_ENABLED = original
  })
}

const freeTierFixedItems = [
  { key: "chat", href: "/chat", label: "Chat" },
  { key: "routine", href: "/routine", label: "Routine" },
  { key: "scan", href: "/scan", label: "Scan" },
  { key: "application", href: "/anwendung", label: "Anwendung" },
  { key: "profile", href: "/profile", label: "Profil" },
]

test("flag off: a legacy-kind authenticated user with no paid access stays on the legacy shell, and the paid-access signal is never even consulted (byte-identical)", async () => {
  await withFreemiumScannerFirstFlag(false, async () => {
    let loadHasAppAccessCalls = 0
    const navigation = await resolveAuthenticatedAppNavigationAccess({
      getUserId: async () => "user-1",
      loadJourneyAccess: async () => ({ kind: "legacy" }),
      loadHasAppAccess: async () => {
        loadHasAppAccessCalls += 1
        return false
      },
    })
    assert.deepEqual(navigation, { kind: "legacy" })
    assert.equal(loadHasAppAccessCalls, 0)
  })
})

test("flag on but no loadHasAppAccess dep wired: never promotes to free tier (safe default)", async () => {
  await withFreemiumScannerFirstFlag(true, async () => {
    const navigation = await resolveAuthenticatedAppNavigationAccess({
      getUserId: async () => "user-1",
      loadJourneyAccess: async () => ({ kind: "legacy" }),
    })
    assert.deepEqual(navigation, { kind: "legacy" })
  })
})

test("flag on, legacy journey kind, no paid app access: promotes to the free-tier five-tab nav", async () => {
  await withFreemiumScannerFirstFlag(true, async () => {
    let loadHasAppAccessUserId: string | null = null
    const navigation = await resolveAuthenticatedAppNavigationAccess({
      getUserId: async () => "user-1",
      loadJourneyAccess: async () => ({ kind: "legacy" }),
      loadHasAppAccess: async (userId) => {
        loadHasAppAccessUserId = userId
        return false
      },
    })
    assert.equal(loadHasAppAccessUserId, "user-1")
    assert.deepEqual(navigation, {
      kind: "personal_plan",
      items: freeTierFixedItems,
      hasPendingRoutineProposal: false,
      hasRoutineAccess: false,
      unvisitedNavSurfaces: new Set(),
      tier: "free",
    })
  })
})

test("flag on, legacy journey kind, but WITH paid app access (a premium legacy state): keeps exactly today's legacy shell", async () => {
  await withFreemiumScannerFirstFlag(true, async () => {
    const navigation = await resolveAuthenticatedAppNavigationAccess({
      getUserId: async () => "user-1",
      loadJourneyAccess: async () => ({ kind: "legacy" }),
      loadHasAppAccess: async () => true,
    })
    assert.deepEqual(navigation, { kind: "legacy" })
  })
})

test("flag on, paid_pending journey kind: left untouched, never promoted to free tier", async () => {
  await withFreemiumScannerFirstFlag(true, async () => {
    let loadHasAppAccessCalls = 0
    const navigation = await resolveAuthenticatedAppNavigationAccess({
      getUserId: async () => "user-1",
      loadJourneyAccess: async () => ({ kind: "paid_pending", recoveryHref: "/plan-bereit" }),
      loadHasAppAccess: async () => {
        loadHasAppAccessCalls += 1
        return false
      },
    })
    assert.deepEqual(navigation, { kind: "legacy" })
    assert.equal(loadHasAppAccessCalls, 0)
  })
})

test("flag on, a real Personal Plan journey: tier is always premium and the paid-access signal is never consulted", async () => {
  await withFreemiumScannerFirstFlag(true, async () => {
    const navigation = await resolveAuthenticatedAppNavigationAccess({
      getUserId: async () => "user-1",
      loadJourneyAccess: async () => personalPlanAccess(true, false),
      loadHasAppAccess: async () => {
        throw new Error("must not be called for an already-paid Personal Plan journey")
      },
    })
    assert.equal(navigation.kind, "personal_plan")
    if (navigation.kind !== "personal_plan") return
    assert.equal(navigation.tier, "premium")
  })
})

test("premium tier renders zero lock markers", () => {
  const html = renderToStaticMarkup(
    createElement(PersonalPlanNavigationView, {
      items: freeTierFixedItems as PersonalPlanNavigationItem[],
      pathname: "/scan",
      tier: "premium",
    }),
  )
  assert.doesNotMatch(html, /data-nav-lock-badge/)
})

test("free tier renders the lock marker on exactly chat, routine, and anwendung — never scan or profile, and never on the desktop nav (no icons there)", () => {
  const html = renderToStaticMarkup(
    createElement(PersonalPlanNavigationView, {
      items: freeTierFixedItems as PersonalPlanNavigationItem[],
      pathname: "/scan",
      tier: "free",
    }),
  )

  const headerNav = html.match(
    /<nav aria-label="Personal-Plan-Navigation"[^>]*>[\s\S]*?<\/nav>/,
  )?.[0]
  const mobileNav = html.match(
    /<nav aria-label="Personal-Plan-Navigation \(mobil\)"[^>]*>[\s\S]*?<\/nav>/,
  )?.[0]
  assert.ok(headerNav && mobileNav, "expected both the header and mobile nav markup")
  assert.doesNotMatch(headerNav!, /data-nav-lock-badge/)

  const linkFor = (nav: string, href: string) =>
    nav.match(new RegExp(`<a[^>]*href="${href}"[^>]*>[\\s\\S]*?</a>`))?.[0]

  for (const href of ["/chat", "/routine", "/anwendung"]) {
    const link = linkFor(mobileNav!, href)
    assert.ok(link, `expected a nav link for ${href}`)
    assert.match(link!, /data-nav-lock-badge="true"/)
    // The lock marker never replaces or covers the tab icon (controller
    // resolution): the icon glyph must still render alongside the badge.
    assert.match(link!, /<svg[^>]*class="[^"]*\bh-5 w-5\b[^"]*"/)
  }
  for (const href of ["/scan", "/profile"]) {
    const link = linkFor(mobileNav!, href)
    assert.ok(link, `expected a nav link for ${href}`)
    assert.doesNotMatch(link!, /data-nav-lock-badge/)
  }
})

test("the shell picks the five-tab nav (with locks) for a free-tier navigation object, exactly like a real Personal Plan owner", () => {
  const freeTierNavigation: AuthenticatedAppNavigationAccess = {
    kind: "personal_plan",
    items: freeTierFixedItems as PersonalPlanNavigationItem[],
    hasPendingRoutineProposal: false,
    hasRoutineAccess: false,
    unvisitedNavSurfaces: new Set(),
    tier: "free",
  }
  const html = renderToStaticMarkup(
    createElement(AuthenticatedAppShell, {
      navigation: freeTierNavigation,
      legacyHeader: createElement("header", { "data-legacy-header": true }, "Legacy"),
      children: createElement("main", null, "Inhalt"),
    }),
  )
  assert.doesNotMatch(html, /data-legacy-header/)
  assert.match(html, /aria-label="Personal-Plan-Navigation \(mobil\)"/)
  assert.equal((html.match(/data-nav-lock-badge="true"/g) ?? []).length, 3)
})
