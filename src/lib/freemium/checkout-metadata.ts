import type Stripe from "stripe"

/**
 * The marker a Premium-sheet Checkout Session carries (freemium-scanner-first T14).
 *
 * Freemium admission is the ONE thing that must never be inferred: a plain
 * standard-catalog subscription is also what every legacy pricing-page buyer has, and
 * admitting those retroactively into the Personal-Plan journey would rewrite entitlement
 * for users who never bought a plan. So admission keys off an explicit marker that only
 * `create-checkout-session` writes, for `source: "premium_sheet"`, and only while the
 * freemium flag is on — plus the buyer's own user id, so a completion callback can never
 * admit somebody else's session.
 */
export const FREEMIUM_CHECKOUT_MARKER_KEY = "freemium_admission"
export const FREEMIUM_CHECKOUT_MARKER_VALUE = "1"
export const FREEMIUM_CHECKOUT_USER_KEY = "freemium_user_id"

type MetadataCarrier = Pick<Stripe.Checkout.Session, "metadata">

/** True only for a Session this app created for the Premium sheet. */
export function isFreemiumCheckoutSession(session: MetadataCarrier): boolean {
  return session.metadata?.[FREEMIUM_CHECKOUT_MARKER_KEY] === FREEMIUM_CHECKOUT_MARKER_VALUE
}

/** The user id the Session was created for, or `null` when it carries none. */
export function freemiumCheckoutUserId(session: MetadataCarrier): string | null {
  const value = session.metadata?.[FREEMIUM_CHECKOUT_USER_KEY]
  return typeof value === "string" && value.trim() ? value.trim() : null
}
