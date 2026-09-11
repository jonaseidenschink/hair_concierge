/**
 * The Premium sheet's purchase reference (docket rework R1).
 *
 * T14's purchase machine carries exactly one handle on an in-flight purchase — the thing
 * it persists across a refresh, polls on, and hands to the completion endpoint. With the
 * card lane alone that handle was simply a Stripe Checkout Session id. The sheet's native
 * PayPal button produces a different handle (its checkout-intent token), so the handle now
 * names its provider.
 *
 * A prefix rather than a second state field on purpose: every place that already carries
 * the reference — the reducer, `sessionStorage`, the poll, the resume lane — keeps working
 * on one opaque string, and only the one place that builds the HTTP request has to know
 * which provider it is talking to.
 *
 * Stripe references are never prefixed: they are `cs_…` exactly as before, so a purchase
 * that a previous deploy persisted still resumes.
 */

const PAYPAL_PREFIX = "paypal:"

/** Tags a PayPal checkout-intent token as this sheet's purchase reference. */
export function premiumSheetPayPalReference(token: string): string {
  return `${PAYPAL_PREFIX}${token}`
}

/**
 * The completion request body for a reference. The endpoint accepts one provider shape or
 * the other and never both, so this is the single place the two lanes diverge client-side.
 */
export function premiumSheetCompletionBody(
  reference: string,
): { sessionId: string } | { paypalToken: string } {
  if (reference.startsWith(PAYPAL_PREFIX)) {
    return { paypalToken: reference.slice(PAYPAL_PREFIX.length) }
  }
  return { sessionId: reference }
}
