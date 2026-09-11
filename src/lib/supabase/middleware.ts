import { createServerClient } from "@supabase/ssr"
import type { SupabaseClient } from "@supabase/supabase-js"
import { NextResponse, type NextRequest } from "next/server"
import {
  getAuthenticatedAppRedirect,
  isPersonalPlanOnboardingBypassRoute,
  resolveIntakeState,
  type PersonalPlanRoutineAccess,
} from "@/lib/auth/intake-state"
import { resolveOneTimeAccessStateForUser as resolveOneTimeAccessState } from "@/lib/billing/purchases"
import { hasCurrentAppAccess, hasCurrentPaidAppAccess } from "@/lib/billing/subscriptions"
import type { OneTimeAccessState } from "@/lib/billing/types"
import { getUnauthenticatedRedirectTarget } from "@/lib/auth/unauthenticated-redirect"
import { sanitizeReactivationReturnDestination } from "@/lib/reactivation/return-destination"
import {
  getPersonalPlanFrontierRedirect,
  type PersonalPlanRoutingFrontier,
} from "@/lib/personal-plan/frontier-routing"
import { loadPersonalPlanRoutingFrontierForUser } from "@/lib/personal-plan/frontier-routing-loader"
import { resolveModeratorAccess } from "@/lib/personal-plan-field-test/moderator"
import {
  classifyRoute,
  pathMatchesRoutePrefix,
  type RouteEnvironment,
} from "@/lib/auth/route-classification"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"

const AUTHENTICATED_APP_ROUTE_PREFIXES = ["/anwendung", "/chat", "/routine", "/scan", "/tracker"]
export const AUTHENTICATED_SESSION_RESPONSE_HEADER = "x-chaarlie-authenticated-session"
const SUB_REQUIRED_PREFIXES = [
  "/anwendung",
  "/onboarding",
  "/chat",
  "/api/chat",
  "/api/product-intake",
  "/profile",
  "/api/profile",
  "/plan-start",
  "/api/personal-plan",
  "/api/memory",
  "/routine",
  "/api/routine",
  "/scan",
  "/api/scan",
  "/tracker",
  "/api/tracker",
]
const SERVER_AUTHENTICATED_ROUTES_WITHOUT_SESSION_LOOKUP = [
  "/api/billing/reconcile",
  "/api/billing/payment-monitor",
  "/api/customerio/profile-sync/reconcile",
]
const UNAUTHENTICATED_EXACT_ROUTES_WITHOUT_SESSION_LOOKUP = [
  "/api/billing/one-time-activation-status",
  "/api/personal-plan/field-test/activate",
  "/api/personal-plan/field-test/moderator/start",
  "/api/personal-plan/field-test/moderator/activate",
  "/api/personal-plan/field-test/moderator/activate-organic",
  "/api/quiz/field-test/activate",
]
const ROUTES_WITHOUT_AUTH_LOOKUP = [
  "/",
  "/agb",
  "/datenschutz",
  "/icon",
  "/impressum",
  "/kontakt",
  "/lp",
  "/methodik",
  "/opengraph-image",
  "/pricing",
  "/robots.txt",
  "/sitemap.xml",
  "/twitter-image",
  "/widerruf",
  "/api/og",
  "/api/funnel",
  "/api/stripe",
  "/api/paypal",
  "/api/auth/send-magic-link",
  "/api/auth/send-setup-link",
  "/api/auth/set-checkout-password",
  "/welcome",
]
export function isAuthenticatedAppRoutePath(pathname: string) {
  return AUTHENTICATED_APP_ROUTE_PREFIXES.some((prefix) => pathMatchesRoutePrefix(pathname, prefix))
}

export function requiresSubscriptionPath(pathname: string) {
  return SUB_REQUIRED_PREFIXES.some((prefix) => pathMatchesRoutePrefix(pathname, prefix))
}

// Freemium scanner-first (flag-gated): the app-shell page routes plus
// /api/scan admit an authenticated user without paid access — page/API
// shells render instead of bouncing to /reactivate. Every other /api/*
// prefix (chat, profile, personal-plan, routine, tracker, memory,
// product-intake) is deliberately excluded and stays subscription-gated;
// per-feature/premium API enforcement inside these shells is a later task.
const FREEMIUM_ADMITTED_ROUTE_PREFIXES = [
  "/anwendung",
  "/chat",
  "/routine",
  "/scan",
  "/api/scan",
  "/profile",
  "/tracker",
]

export function isFreemiumAdmittedRoutePath(pathname: string) {
  return FREEMIUM_ADMITTED_ROUTE_PREFIXES.some((prefix) => pathMatchesRoutePrefix(pathname, prefix))
}

export type ReactivationRedirectContext = {
  pathname: string
  freemiumScannerFirstEnabled: boolean
}

/**
 * Decides whether a user who has resolved to "no active paid access" at the
 * outer subscription gate should be sent to /reactivate (pages) or receive
 * the subscription_required 403 (APIs). Extracted so T17 can extend the
 * freemium carve-out without re-threading the surrounding paywall control
 * flow. Behavior today (flag off, or flag on for a non-admitted route) is
 * unchanged: always redirect/deny.
 */
export function shouldRedirectToReactivation(ctx: ReactivationRedirectContext): boolean {
  if (ctx.freemiumScannerFirstEnabled && isFreemiumAdmittedRoutePath(ctx.pathname)) {
    return false
  }
  return true
}

export function isAdminRoutePath(pathname: string) {
  return (
    pathMatchesRoutePrefix(pathname, "/admin") || pathMatchesRoutePrefix(pathname, "/api/admin")
  )
}

export function isPersonalPlanFieldTestGuest(user: { app_metadata?: Record<string, unknown> }) {
  return user.app_metadata?.access_kind === "field_test"
}

export function isPartnerAccessGuest(user: { app_metadata?: Record<string, unknown> }) {
  return (
    user.app_metadata?.access_kind === "partner" ||
    typeof user.app_metadata?.partner_access_invitation_id === "string"
  )
}

export function getFieldTestEndedRoute(user: { app_metadata?: Record<string, unknown> }) {
  return user.app_metadata?.field_test_flow === "regular_quiz"
    ? "/test/quiz/beendet"
    : "/test/haarplan/beendet"
}

export function hasActivePersonalPlanRoutineEntitlement({
  hasCurrentAppAccess,
  fieldTestGuest,
  partnerGuest = false,
  moderatorAccess = "none",
  oneTimeAccessState,
}: {
  hasCurrentAppAccess: boolean
  fieldTestGuest: boolean
  partnerGuest?: boolean
  moderatorAccess?: ModeratorAccessState
  oneTimeAccessState: OneTimeAccessState | null
}) {
  return (
    oneTimeAccessState === "active" ||
    (fieldTestGuest && hasCurrentAppAccess) ||
    (partnerGuest && hasCurrentAppAccess) ||
    moderatorAccess === "active"
  )
}

export type ModeratorAccessState = "active" | "ended" | "none" | "unavailable"

function normalizeModeratorAccessState(value: unknown): ModeratorAccessState {
  if (value === "active" || value === "ended" || value === "none" || value === "unavailable") {
    return value
  }
  if (value && typeof value === "object") {
    const discriminator =
      (value as Record<string, unknown>).kind ?? (value as Record<string, unknown>).status
    if (
      discriminator === "active" ||
      discriminator === "ended" ||
      discriminator === "none" ||
      discriminator === "unavailable"
    ) {
      return discriminator
    }
  }
  return "unavailable"
}

export function buildAuthenticatedIntakeRedirectUrl(
  sourceUrl: URL,
  sourcePathname: string,
  redirectPath: string,
) {
  const url = new URL(sourceUrl.toString())
  const leadId = url.searchParams.get("lead")
  url.pathname = redirectPath

  if (sourcePathname === "/auth") {
    url.search = ""
    if (redirectPath === "/onboarding" && leadId) {
      url.searchParams.set("lead", leadId)
    }
    return url
  }

  if (redirectPath === "/onboarding") {
    if (leadId) {
      url.searchParams.set("lead", leadId)
    }
  } else {
    url.searchParams.delete("lead")
  }
  return url
}

export function buildAuthenticatedAppRedirectUrl(requestUrl: URL, redirectPath: string): URL {
  return buildAuthenticatedIntakeRedirectUrl(requestUrl, requestUrl.pathname, redirectPath)
}

export type UpdateSessionDependencies = {
  createServerClient: typeof createServerClient
  hasCurrentAppAccess: typeof hasCurrentAppAccess
  hasCurrentPaidAppAccess?: typeof hasCurrentPaidAppAccess
  resolveOneTimeAccessState: typeof resolveOneTimeAccessState
  resolveModeratorAccess?: (input: {
    client: Pick<SupabaseClient, "from">
    userId: string
  }) => Promise<unknown>
  getRouteEnvironment: () => RouteEnvironment
  loadPersonalPlanRoutingFrontier?: (
    client: Pick<SupabaseClient, "from">,
    userId: string,
  ) => Promise<PersonalPlanRoutingFrontier>
}

function getDefaultRouteEnvironment(): RouteEnvironment {
  return {
    ciOfferPageLabEnabled:
      process.env.CI === "true" && process.env.CI_OFFER_PAGE_LAB_ENABLED === "true",
    ciPersonalPlanStage3LabEnabled:
      process.env.CI === "true" && process.env.CI_PERSONAL_PLAN_STAGE3_LAB_ENABLED === "true",
    ciPersonalPlanProductionJourneyEnabled:
      process.env.CI === "true" &&
      process.env.CI_PERSONAL_PLAN_PRODUCTION_JOURNEY_ENABLED === "true",
    nodeEnv: process.env.NODE_ENV,
    localDevLoginEnabled: process.env.LOCAL_DEV_LOGIN_ENABLED === "1",
    vercelEnv: process.env.VERCEL_ENV,
  }
}

const defaultUpdateSessionDependencies: UpdateSessionDependencies = {
  createServerClient,
  hasCurrentAppAccess,
  hasCurrentPaidAppAccess,
  resolveOneTimeAccessState,
  // Moderator membership is deliberately service-only. Never pass the browser
  // session client here or RLS would convert ordinary protected requests into
  // false access outages.
  resolveModeratorAccess: ({ userId }) => resolveModeratorAccess({ userId }),
  getRouteEnvironment: getDefaultRouteEnvironment,
  loadPersonalPlanRoutingFrontier: loadPersonalPlanRoutingFrontierForUser as never,
}

/**
 * Builds the middleware handler with injectable server-side dependencies.
 *
 * Production callers use `updateSession`; the factory only exists to make the
 * authenticated routing order testable without a network-backed Supabase client.
 */
export function createUpdateSession(
  dependencies: UpdateSessionDependencies = defaultUpdateSessionDependencies,
) {
  return async function updateSession(request: NextRequest) {
    let supabaseResponse = NextResponse.next({
      request,
    })

    const { pathname } = request.nextUrl
    const freemiumScannerFirstEnabled = isFreemiumScannerFirstEnabled()
    const routeEnvironment = dependencies.getRouteEnvironment()
    const routeClassification = classifyRoute(pathname, routeEnvironment)

    if (routeClassification === "legacy") {
      const url = request.nextUrl.clone()
      const leadId = url.searchParams.get("lead_id") ?? url.searchParams.get("lead")

      url.search = ""
      if (leadId) {
        url.pathname = `/result/${encodeURIComponent(leadId)}`
        url.searchParams.set("focus", "unlock-plan")
      } else {
        url.pathname = "/pricing"
      }

      return NextResponse.redirect(url)
    }

    if (routeClassification === "unknown") {
      return supabaseResponse
    }

    if (
      SERVER_AUTHENTICATED_ROUTES_WITHOUT_SESSION_LOOKUP.includes(pathname) ||
      UNAUTHENTICATED_EXACT_ROUTES_WITHOUT_SESSION_LOOKUP.includes(pathname) ||
      ROUTES_WITHOUT_AUTH_LOOKUP.some((route) => pathMatchesRoutePrefix(pathname, route))
    ) {
      return supabaseResponse
    }

    const supabase = dependencies.createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
            supabaseResponse = NextResponse.next({
              request,
            })
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options),
            )
          },
        },
      },
    )

    const {
      data: { user },
    } = await supabase.auth.getUser()

    const isQuizRetake =
      pathname === "/quiz" && request.nextUrl.searchParams.get("mode") === "retake"
    const isForcedAuthLogin =
      pathname === "/auth" && request.nextUrl.searchParams.get("force") === "login"
    const needsAuthenticatedAppRouting =
      pathname === "/auth" ||
      pathname === "/quiz" ||
      (isAuthenticatedAppRoutePath(pathname) && !pathMatchesRoutePrefix(pathname, "/tracker"))
    const isPublicRoute = routeClassification === "public" || routeClassification === "development"

    if (!user && !isPublicRoute) {
      const url = request.nextUrl.clone()
      const redirectTarget = getUnauthenticatedRedirectTarget(
        pathname,
        request.nextUrl.search,
        request.cookies.has("hc_returning"),
      )
      const [targetPathname, targetSearch = ""] = redirectTarget.split("?")
      url.pathname = targetPathname
      url.search = targetSearch ? `?${targetSearch}` : ""
      return redirectWithSupabaseCookies(url, supabaseResponse)
    }

    // All checks below require an authenticated user
    if (!user) {
      return supabaseResponse
    }

    // Internal proxy signal only. The proxy removes it before returning the
    // response and uses it to keep signed field-test cookies from overriding
    // authenticated app routing on `/quiz`.
    supabaseResponse.headers.set(AUTHENTICATED_SESSION_RESPONSE_HEADER, "1")

    if (isForcedAuthLogin) {
      return supabaseResponse
    }

    // Mark user as returning (survives session expiry, 1 year)
    if (!request.cookies.has("hc_returning")) {
      supabaseResponse.cookies.set("hc_returning", "1", {
        path: "/",
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 365,
      })
    }

    // --- Subscription paywall ---------------------------------------------
    const needsSub = requiresSubscriptionPath(pathname)
    const fieldTestGuest = isPersonalPlanFieldTestGuest(user)
    const partnerGuest = isPartnerAccessGuest(user)
    let oneTimeAccessState: OneTimeAccessState | null = null
    let hasActivePersonalPlanEntitlement = false
    // Mirrors the paywall's own "has paid access" definition (see the
    // `!active && oneTimeAccessState !== "active" && moderatorAccess !==
    // "active"` gate below) — NOT just `hasCurrentAppAccess`. A one-time
    // purchaser or active moderator counts as paid even while `active` is
    // `false`, so they must not be treated as free-tier by the freemium
    // intake exemption below.
    let hasPaidAppAccessResult = false
    let moderatorAccess: ModeratorAccessState = "none"

    if (needsSub) {
      let active: boolean
      try {
        ;[active, oneTimeAccessState, moderatorAccess] = await Promise.all([
          dependencies.hasCurrentAppAccess(supabase, { userId: user.id, email: user.email }),
          dependencies.resolveOneTimeAccessState(supabase, user.id),
          !fieldTestGuest && dependencies.resolveModeratorAccess
            ? dependencies
                .resolveModeratorAccess({ client: supabase, userId: user.id })
                .then(normalizeModeratorAccessState)
            : Promise.resolve<ModeratorAccessState>("none"),
        ])
        let hasIndependentPaidEntitlement = oneTimeAccessState === "active"
        if (moderatorAccess === "ended" || moderatorAccess === "unavailable") {
          hasIndependentPaidEntitlement = dependencies.hasCurrentPaidAppAccess
            ? await dependencies.hasCurrentPaidAppAccess(supabase, { userId: user.id })
            : false
          // `active` includes a manual tester grant. Once its matching
          // moderator record has ended or cannot be read, only independently
          // verified paid access may keep the protected route open.
          active = hasIndependentPaidEntitlement
        }
        if (moderatorAccess === "unavailable" && !hasIndependentPaidEntitlement) {
          if (pathMatchesRoutePrefix(pathname, "/api")) {
            return NextResponse.json({ error: "moderator_access_unavailable" }, { status: 503 })
          }
          const unavailable = new NextResponse(
            "Dein Zugang wird gerade geprüft. Bitte versuche es gleich noch einmal.",
            {
              status: 503,
              headers: {
                "Cache-Control": "private, no-store",
                "Content-Type": "text/plain; charset=utf-8",
              },
            },
          )
          supabaseResponse.cookies.getAll().forEach((cookie) => unavailable.cookies.set(cookie))
          return unavailable
        }
        hasActivePersonalPlanEntitlement = hasActivePersonalPlanRoutineEntitlement({
          hasCurrentAppAccess: active,
          fieldTestGuest,
          partnerGuest,
          moderatorAccess,
          oneTimeAccessState,
        })
        hasPaidAppAccessResult =
          active || oneTimeAccessState === "active" || moderatorAccess === "active"
      } catch (error) {
        console.warn("[billing] app access check failed", error)
        if (fieldTestGuest) {
          if (pathMatchesRoutePrefix(pathname, "/api")) {
            return NextResponse.json({ error: "field_test_access_unavailable" }, { status: 503 })
          }
          const url = request.nextUrl.clone()
          url.pathname = getFieldTestEndedRoute(user)
          url.search = ""
          url.searchParams.set("reason", "unavailable")
          return redirectWithSupabaseCookies(url, supabaseResponse)
        }
        if (pathMatchesRoutePrefix(pathname, "/api")) {
          return NextResponse.json({ error: "access_check_unavailable" }, { status: 503 })
        }
        const url = request.nextUrl.clone()
        const next = sanitizeReactivationReturnDestination(
          `${request.nextUrl.pathname}${request.nextUrl.search}`,
        )
        url.pathname = "/reactivate"
        url.search = ""
        url.searchParams.set("reason", "access_check_unavailable")
        url.searchParams.set("next", next)
        return redirectWithSupabaseCookies(url, supabaseResponse)
      }

      if (!active && oneTimeAccessState === "paid_pending") {
        if (pathMatchesRoutePrefix(pathname, "/api")) {
          return NextResponse.json({ error: "activation_pending" }, { status: 409 })
        }
        if (pathname !== "/plan-bereit") {
          const url = request.nextUrl.clone()
          url.pathname = "/plan-bereit"
          url.search = ""
          const leadId = request.nextUrl.searchParams.get("lead")
          if (leadId) {
            url.searchParams.set("lead", leadId)
          }
          return redirectWithSupabaseCookies(url, supabaseResponse)
        }
      }

      // A current app entitlement still reaches the ordinary onboarding/intake
      // flow even when it is not yet a Personal Plan routine entitlement.
      // Email-bound moderators and one-time owners also need to pass this
      // outer subscription gate; their later journey readers validate the
      // exact Personal Plan source.
      if (!active && oneTimeAccessState !== "active" && moderatorAccess !== "active") {
        if (moderatorAccess === "ended") {
          if (pathMatchesRoutePrefix(pathname, "/api")) {
            return NextResponse.json({ error: "field_test_ended" }, { status: 403 })
          }
          const url = request.nextUrl.clone()
          url.pathname = "/test/haarplan/beendet"
          url.search = ""
          return redirectWithSupabaseCookies(url, supabaseResponse)
        }
        if (fieldTestGuest) {
          if (pathMatchesRoutePrefix(pathname, "/api")) {
            return NextResponse.json({ error: "field_test_ended" }, { status: 403 })
          }
          const url = request.nextUrl.clone()
          url.pathname = getFieldTestEndedRoute(user)
          url.search = ""
          return redirectWithSupabaseCookies(url, supabaseResponse)
        }
        if (
          shouldRedirectToReactivation({
            pathname,
            freemiumScannerFirstEnabled,
          })
        ) {
          if (pathMatchesRoutePrefix(pathname, "/api")) {
            return NextResponse.json({ error: "subscription_required" }, { status: 403 })
          }
          const url = request.nextUrl.clone()
          const next = sanitizeReactivationReturnDestination(
            `${request.nextUrl.pathname}${request.nextUrl.search}`,
          )
          url.pathname = "/reactivate"
          url.search = ""
          url.searchParams.set("reason", "expired")
          url.searchParams.set("next", next)
          return redirectWithSupabaseCookies(url, supabaseResponse)
        }
        // Freemium admission: flag on + admitted route -> fall through so the
        // page/API shell renders without an active subscription.
      }
    }
    // --- End subscription paywall ------------------------------------------

    if (needsAuthenticatedAppRouting) {
      const [{ data: profile }, { data: hairProfile }] = await Promise.all([
        supabase.from("profiles").select("onboarding_completed").eq("id", user.id).maybeSingle(),
        supabase
          .from("hair_profiles")
          .select(
            "hair_texture, thickness, density, cuticle_condition, protein_moisture_balance, scalp_type, scalp_condition, chemical_treatment, concerns",
          )
          .eq("user_id", user.id)
          .maybeSingle(),
      ])

      const intakeState = resolveIntakeState(profile, hairProfile)
      const moderatorLegacyEntry =
        moderatorAccess === "active" &&
        intakeState !== "ready" &&
        pathMatchesRoutePrefix(pathname, "/chat")
      try {
        const frontier = await (
          dependencies.loadPersonalPlanRoutingFrontier ?? loadPersonalPlanRoutingFrontierForUser
        )(supabase as never, user.id)
        // A reset moderator has no legacy onboarding completion. Password login
        // defaults to /chat; keep early-plan returns in the saved Personal Plan.
        // Once a routine exists, retain ordinary chat access.
        const moderatorEntryRedirect =
          moderatorLegacyEntry &&
          (frontier.kind !== "personal_plan" ||
            ["stage1", "stage2", "stage3"].includes(frontier.frontier))
            ? frontier.kind === "legacy"
              ? "/plan-bereit"
              : frontier.nextHref
            : null
        const frontierRedirect =
          moderatorEntryRedirect ?? getPersonalPlanFrontierRedirect(pathname, frontier)
        if (frontierRedirect) {
          const url = buildAuthenticatedIntakeRedirectUrl(
            request.nextUrl,
            pathname,
            frontierRedirect,
          )
          return redirectWithSupabaseCookies(url, supabaseResponse)
        }
      } catch (error) {
        console.warn("[personal-plan] routing frontier unavailable", error)
        if (
          moderatorLegacyEntry ||
          getPersonalPlanFrontierRedirect(pathname, {
            kind: "recovery",
            nextHref: "/plan-bereit",
          })
        ) {
          const unavailableResponse = new NextResponse(
            "Dein Haarplan ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.",
            {
              status: 503,
              headers: {
                "Cache-Control": "private, no-store",
                "Content-Type": "text/plain; charset=utf-8",
              },
            },
          )
          supabaseResponse.cookies
            .getAll()
            .forEach((cookie) => unavailableResponse.cookies.set(cookie))
          return unavailableResponse
        }
      }
      let personalPlanRoutineAccess: PersonalPlanRoutineAccess | undefined
      if (
        intakeState === "needs_onboarding" &&
        hasActivePersonalPlanEntitlement &&
        isPersonalPlanOnboardingBypassRoute(pathname)
      ) {
        try {
          const { data: plan, error } = await supabase
            .from("personal_plans")
            .select("pending_routine_proposal_id,active_routine_version_id")
            .eq("user_id", user.id)
            .maybeSingle()

          if (error) {
            console.warn("[personal-plan] routine access check failed", error)
          } else {
            personalPlanRoutineAccess = {
              hasActivePersonalPlanEntitlement,
              pendingRoutineProposalId:
                typeof plan?.pending_routine_proposal_id === "string"
                  ? plan.pending_routine_proposal_id
                  : null,
              activeRoutineVersionId:
                typeof plan?.active_routine_version_id === "string"
                  ? plan.active_routine_version_id
                  : null,
            }
          }
        } catch (error) {
          console.warn("[personal-plan] routine access check failed", error)
        }
      }
      const rawRedirectPath = getAuthenticatedAppRedirect(pathname, intakeState, {
        isQuizRetake,
        personalPlanRoutineAccess,
        freemiumScannerFirstEnabled,
      })
      // Freemium admission: a free-tier user (no paid access, per the same
      // composite the subscription paywall uses — hasCurrentAppAccess OR an
      // active one-time purchase OR an active moderator grant) navigating an
      // admitted app-shell route is never bounced into legacy onboarding —
      // they land where they navigated. Paid users (including one-time
      // owners and active moderators), and any non-admitted route (e.g.
      // /auth, /quiz), are unaffected.
      const freemiumIntakeAdmitted =
        freemiumScannerFirstEnabled &&
        rawRedirectPath === "/onboarding" &&
        !hasPaidAppAccessResult &&
        isFreemiumAdmittedRoutePath(pathname)
      const redirectPath = freemiumIntakeAdmitted ? null : rawRedirectPath

      if (redirectPath) {
        const url = buildAuthenticatedIntakeRedirectUrl(request.nextUrl, pathname, redirectPath)
        return redirectWithSupabaseCookies(url, supabaseResponse)
      }
    }

    // Admin route protection
    if (isAdminRoutePath(pathname)) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("is_admin")
        .eq("id", user.id)
        .single()

      if (!profile?.is_admin) {
        const url = request.nextUrl.clone()
        url.pathname = "/chat"
        return redirectWithSupabaseCookies(url, supabaseResponse)
      }
    }

    return supabaseResponse
  }
}

export const updateSession = createUpdateSession()

export function redirectWithSupabaseCookies(
  url: string | URL,
  supabaseResponse: NextResponse,
): NextResponse {
  const redirectResponse = NextResponse.redirect(url)
  supabaseResponse.cookies.getAll().forEach((cookie) => redirectResponse.cookies.set(cookie))
  return redirectResponse
}
