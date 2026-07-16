import { pathMatchesRoutePrefix } from "@/lib/auth/route-classification"

const AUTH_FIRST_PREFIXES = [
  "/chat",
  "/routine",
  "/profile",
  "/reactivate",
  "/onboarding",
  "/tracker",
  "/admin",
  "/api/chat",
  "/api/routine",
  "/api/tracker",
  "/api/profile",
  "/api/products",
  "/api/memory",
  "/api/admin",
]

function isAuthFirstRoute(pathname: string): boolean {
  return AUTH_FIRST_PREFIXES.some((prefix) => pathMatchesRoutePrefix(pathname, prefix))
}

export function getUnauthenticatedRedirectTarget(
  pathname: string,
  search: string,
  hasReturningCookie: boolean,
): string {
  const next = `${pathname}${search}`

  if (hasReturningCookie || isAuthFirstRoute(pathname)) {
    const params = new URLSearchParams()
    if (hasReturningCookie) {
      params.set("reason", "session_expired")
    }
    params.set("next", next)
    return `/auth?${params.toString()}`
  }

  return "/quiz"
}
