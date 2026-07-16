export const DEFAULT_REACTIVATION_RETURN_DESTINATION = "/chat"

const ALLOWED_RETURN_PATHS = new Set(["/chat", "/routine", "/tracker", "/profile", "/onboarding"])

const REDIRECT_QUERY_KEYS = new Set([
  "callbackurl",
  "continue",
  "destination",
  "next",
  "redirect",
  "redirect_to",
  "return",
  "returnto",
  "url",
])

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const MALFORMED_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/i
const ENCODED_CONTROL_CHARACTER = /%(?:00|0a|0d|7f)/i

/**
 * Keep post-reactivation navigation inside the small set of member pages that
 * can legitimately trigger reactivation. The returned value is safe to append
 * to the current origin; invalid and recursive destinations fall back to chat.
 */
export function sanitizeReactivationReturnDestination(
  rawDestination: string | null | undefined,
): string {
  if (!rawDestination || rawDestination.trim() !== rawDestination) {
    return DEFAULT_REACTIVATION_RETURN_DESTINATION
  }

  if (
    !rawDestination.startsWith("/") ||
    rawDestination.startsWith("//") ||
    rawDestination.includes("\\") ||
    rawDestination.includes("#") ||
    CONTROL_CHARACTER.test(rawDestination) ||
    MALFORMED_PERCENT_ESCAPE.test(rawDestination) ||
    ENCODED_CONTROL_CHARACTER.test(rawDestination)
  ) {
    return DEFAULT_REACTIVATION_RETURN_DESTINATION
  }

  const queryStart = rawDestination.indexOf("?")
  const pathname = queryStart === -1 ? rawDestination : rawDestination.slice(0, queryStart)

  // The allowlisted pathnames contain no escapes. Rejecting any percent sign in
  // this portion also blocks encoded slashes, backslashes, traversal and double
  // encoding without relying on URL parser normalization.
  if (pathname.includes("%") || !ALLOWED_RETURN_PATHS.has(pathname)) {
    return DEFAULT_REACTIVATION_RETURN_DESTINATION
  }

  if (queryStart === -1 || queryStart === rawDestination.length - 1) {
    return pathname
  }

  const query = rawDestination.slice(queryStart + 1)
  const searchParams = new URLSearchParams(query)

  // Do not forward nested navigation instructions. Query parameters that only
  // configure the destination page remain intact.
  for (const key of searchParams.keys()) {
    if (REDIRECT_QUERY_KEYS.has(key.toLowerCase())) {
      return DEFAULT_REACTIVATION_RETURN_DESTINATION
    }
  }

  return `${pathname}?${query}`
}
