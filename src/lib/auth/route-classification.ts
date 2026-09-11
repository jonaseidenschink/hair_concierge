export type RouteClassification = "public" | "protected" | "legacy" | "development" | "unknown"

export type RouteEnvironment = {
  ciOfferPageLabEnabled?: boolean
  ciPersonalPlanStage3LabEnabled?: boolean
  ciPersonalPlanProductionJourneyEnabled?: boolean
  nodeEnv: string | undefined
  localDevLoginEnabled: boolean
  vercelEnv?: string | undefined
}

const PUBLIC_EXACT_ROUTES = [
  "/",
  "/agb",
  "/datenschutz",
  "/icon",
  "/impressum",
  "/kontakt",
  "/methodik",
  "/opengraph-image",
  "/pricing",
  "/quiz",
  "/robots.txt",
  "/sitemap.xml",
  "/twitter-image",
  "/welcome",
  "/warteliste",
  "/warteliste/b",
  "/warteliste/umfrage",
  "/warteliste/danke",
  "/widerruf",
]

const PUBLIC_ROUTE_PREFIXES = [
  "/auth",
  "/lp",
  "/partner",
  "/result",
  "/test/haarplan",
  "/test/quiz",
  "/api/funnel",
  "/api/og",
  "/api/paypal",
  "/api/partner-access",
  "/api/quiz",
  "/api/stripe",
]

const PUBLIC_API_EXACT_ROUTES = [
  "/api/analytics/meta-offer-view",
  "/api/analytics/offer-engaged",
  "/api/auth/callback",
  "/api/auth/send-magic-link",
  "/api/auth/send-setup-link",
  "/api/auth/set-checkout-password",
  // A paid buyer reaches this capability before an account/session exists.
  // Keep it exact: all other billing APIs remain behind the billing prefix.
  "/api/billing/one-time-activation-status",
  // The field-test handler performs its own signed campaign, funnel, lead,
  // session, and rate-limit checks before it creates or reuses a guest.
  "/api/personal-plan/field-test/activate",
  // These email-bound moderator handlers authenticate their own session and
  // must remain reachable before the moderator receives an entitlement.
  "/api/personal-plan/field-test/moderator/start",
  "/api/personal-plan/field-test/moderator/activate",
  "/api/personal-plan/field-test/moderator/activate-organic",
  "/api/quiz/field-test/activate",
  "/api/waitlist",
  "/api/waitlist/survey",
  "/api/waitlist/survey-access",
]

const PROTECTED_ROUTE_PREFIXES = [
  "/admin",
  "/anwendung",
  "/chat",
  "/onboarding",
  "/plan-bereit",
  "/profile",
  "/plan-start",
  "/reactivate",
  "/routine",
  "/scan",
  "/tracker",
  "/api/admin",
  "/api/billing",
  "/api/chat",
  "/api/customerio",
  "/api/feedback",
  // freemium-scanner-first T14: contextual purchase completion. Authenticated by
  // definition — it verifies and admits the CALLER's own purchase.
  "/api/freemium",
  "/api/memory",
  "/api/personal-plan",
  "/api/product-intake",
  "/api/products",
  "/api/profile",
  "/api/routine",
  "/api/scan",
  "/api/tracker",
  // The public waitlist entries above are intentionally exact; later
  // descendants must not silently inherit public access.
  "/warteliste",
  "/api/waitlist",
]

const DEVELOPMENT_ROUTE_PREFIXES = ["/labs", "/api/labs"]
const DEVELOPMENT_EXACT_ROUTES = ["/api/debug/build-info"]
const LOCAL_LOGIN_ROUTE = "/api/dev/login"
const VERCEL_PREVIEW_DEVELOPMENT_ROUTES = [
  "/labs/offer-page",
  "/labs/personal-plan/stage-3",
  "/labs/portrait",
]

export function pathMatchesRoutePrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

function matchesRoutePrefix(pathname: string, prefixes: readonly string[]) {
  return prefixes.some((prefix) => pathMatchesRoutePrefix(pathname, prefix))
}

export function classifyRoute(
  pathname: string,
  environment: RouteEnvironment,
): RouteClassification {
  if (pathname === "/offer") {
    return "legacy"
  }

  const isDevelopment = environment.nodeEnv === "development"
  const isVercelPreview = environment.vercelEnv === "preview"
  const isCiOfferPageLab =
    pathname === "/labs/offer-page" && environment.ciOfferPageLabEnabled === true
  const isCiPersonalPlanStage3Lab =
    pathname === "/labs/personal-plan/stage-3" &&
    environment.ciPersonalPlanStage3LabEnabled === true
  const isCiPersonalPlanProductionJourney =
    pathname === "/plan-start" &&
    isDevelopment &&
    environment.ciPersonalPlanProductionJourneyEnabled === true
  const isLocalLoginRoute = pathname === LOCAL_LOGIN_ROUTE
  const isStandardDevelopmentRoute =
    DEVELOPMENT_EXACT_ROUTES.includes(pathname) ||
    matchesRoutePrefix(pathname, DEVELOPMENT_ROUTE_PREFIXES)

  if (isLocalLoginRoute) {
    return isDevelopment && environment.localDevLoginEnabled ? "development" : "protected"
  }

  if (
    (VERCEL_PREVIEW_DEVELOPMENT_ROUTES.includes(pathname) && isVercelPreview) ||
    isCiOfferPageLab ||
    isCiPersonalPlanStage3Lab ||
    isCiPersonalPlanProductionJourney
  ) {
    return "development"
  }

  if (isStandardDevelopmentRoute) {
    return isDevelopment ? "development" : "protected"
  }

  if (
    PUBLIC_EXACT_ROUTES.includes(pathname) ||
    PUBLIC_API_EXACT_ROUTES.includes(pathname) ||
    matchesRoutePrefix(pathname, PUBLIC_ROUTE_PREFIXES)
  ) {
    return "public"
  }

  if (matchesRoutePrefix(pathname, PROTECTED_ROUTE_PREFIXES)) {
    return "protected"
  }

  return "unknown"
}
