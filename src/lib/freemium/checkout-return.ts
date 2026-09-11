/**
 * Where a redirect-based Premium-sheet payment comes back to (freemium-scanner-first T14).
 *
 * The sheet's Stripe Checkout Session is created with `redirect_on_completion:
 * "if_required"`: a card/wallet payment never leaves the sheet (Stripe fires the embedded
 * `onComplete` callback in place), but a redirect method — PayPal above all — hands the
 * buyer back through a real navigation. That navigation must land on the surface the sheet
 * was opened FROM, never on `/welcome`, so the browser tells the server which surface that
 * was. Browser-supplied means untrusted: only the exact app surfaces that mount the sheet
 * are accepted, everything else falls back to the scanner.
 */

/** Query parameter the contextual return carries, holding the Checkout Session id. */
export const FREEMIUM_CHECKOUT_RETURN_PARAM = "freemium_checkout"

/**
 * Surfaces that mount `PremiumSheet` today: the scanner (T9/T10 gates) and the three gated
 * „Beispiel" pages (T12). `/anwendung` covers its `[dayType]` children.
 */
const ALLOWED_RETURN_PREFIXES = ["/scan", "/routine", "/anwendung", "/chat"] as const

export const FREEMIUM_CHECKOUT_DEFAULT_RETURN_PATH = "/scan"

/**
 * Normalizes a browser-supplied return path to one of the allowed app surfaces. Query and
 * hash are dropped (the only parameter the return needs is added by the caller), and
 * anything absolute, protocol-relative, traversing, or off-list collapses to `/scan`.
 */
export function sanitizeFreemiumCheckoutReturnPath(value: unknown): string {
  if (typeof value !== "string") return FREEMIUM_CHECKOUT_DEFAULT_RETURN_PATH
  const raw = value.trim()
  // Reject absolute URLs, protocol-relative URLs, backslash tricks and traversal outright
  // rather than trying to repair them.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.includes("..")) {
    return FREEMIUM_CHECKOUT_DEFAULT_RETURN_PATH
  }
  const path = raw.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/"
  const allowed = ALLOWED_RETURN_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  )
  return allowed ? path : FREEMIUM_CHECKOUT_DEFAULT_RETURN_PATH
}

/**
 * The origin-absolute `return_url` handed to Stripe. `{CHECKOUT_SESSION_ID}` is Stripe's
 * own template token — it substitutes the real session id on redirect, so the returning
 * page can verify the purchase server-side without trusting anything else in the URL.
 */
export function buildFreemiumCheckoutReturnUrl(origin: string, returnPath: unknown): string {
  const path = sanitizeFreemiumCheckoutReturnPath(returnPath)
  return `${origin}${path}?${FREEMIUM_CHECKOUT_RETURN_PARAM}={CHECKOUT_SESSION_ID}`
}
