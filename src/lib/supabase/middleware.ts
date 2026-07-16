import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { getAuthenticatedAppRedirect, resolveIntakeState } from "@/lib/auth/intake-state"
import { hasCurrentAppAccess } from "@/lib/billing/subscriptions"
import { getUnauthenticatedRedirectTarget } from "@/lib/auth/unauthenticated-redirect"
import { sanitizeReactivationReturnDestination } from "@/lib/reactivation/return-destination"
import {
  classifyRoute,
  pathMatchesRoutePrefix,
  type RouteEnvironment,
} from "@/lib/auth/route-classification"

const AUTHENTICATED_APP_ROUTE_PREFIXES = ["/chat", "/routine", "/tracker"]
const SUB_REQUIRED_PREFIXES = [
  "/onboarding",
  "/chat",
  "/api/chat",
  "/api/product-intake",
  "/profile",
  "/api/profile",
  "/api/memory",
  "/routine",
  "/api/routine",
  "/tracker",
  "/api/tracker",
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

export function isAdminRoutePath(pathname: string) {
  return (
    pathMatchesRoutePrefix(pathname, "/admin") || pathMatchesRoutePrefix(pathname, "/api/admin")
  )
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  })

  const { pathname } = request.nextUrl
  const routeEnvironment: RouteEnvironment = {
    nodeEnv: process.env.NODE_ENV,
    localDevLoginEnabled: process.env.LOCAL_DEV_LOGIN_ENABLED === "1",
  }
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

  if (ROUTES_WITHOUT_AUTH_LOOKUP.some((route) => pathMatchesRoutePrefix(pathname, route))) {
    return supabaseResponse
  }

  const supabase = createServerClient(
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

  const isQuizRetake = pathname === "/quiz" && request.nextUrl.searchParams.get("mode") === "retake"
  const isForcedAuthLogin =
    pathname === "/auth" && request.nextUrl.searchParams.get("force") === "login"
  const needsAuthenticatedAppRouting =
    pathname === "/auth" || pathname === "/quiz" || isAuthenticatedAppRoutePath(pathname)

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

  if (needsSub) {
    let active: boolean
    try {
      active = await hasCurrentAppAccess(supabase, { userId: user.id, email: user.email })
    } catch (error) {
      console.warn("[billing] app access check failed", error)
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

    if (!active) {
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
  }
  // --- End subscription paywall ------------------------------------------

  if (needsAuthenticatedAppRouting) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("onboarding_completed")
      .eq("id", user.id)
      .maybeSingle()

    const { data: hairProfile } = await supabase
      .from("hair_profiles")
      .select(
        "hair_texture, thickness, density, cuticle_condition, protein_moisture_balance, scalp_type, scalp_condition, chemical_treatment, concerns",
      )
      .eq("user_id", user.id)
      .maybeSingle()

    const intakeState = resolveIntakeState(profile, hairProfile)
    const redirectPath = getAuthenticatedAppRedirect(pathname, intakeState, { isQuizRetake })

    if (redirectPath) {
      const url = request.nextUrl.clone()
      url.pathname = redirectPath
      if (redirectPath === "/onboarding") {
        const leadId = request.nextUrl.searchParams.get("lead")
        if (leadId) {
          url.searchParams.set("lead", leadId)
        }
      } else {
        url.searchParams.delete("lead")
      }
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

export function redirectWithSupabaseCookies(
  url: string | URL,
  supabaseResponse: NextResponse,
): NextResponse {
  const redirectResponse = NextResponse.redirect(url)
  supabaseResponse.cookies.getAll().forEach((cookie) => redirectResponse.cookies.set(cookie))
  return redirectResponse
}
