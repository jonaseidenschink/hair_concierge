import type Stripe from "stripe"

type BuildStripeCheckoutSessionParamsInput = {
  checkoutKind?: "subscription" | "personal_plan_once"
  origin: string
  priceId: string
  presentation?: "embedded_page" | "elements"
  customerId?: string
  customerEmail?: string
  leadId?: string | null
  funnelSessionId?: string | null
  funnelPackageKey?: string | null
  checkoutContext?: "membership_reactivation" | null
  returnDestination?: string | null
  reactivationReservationId?: string | null
  expiresAt?: number
  metadata?: Record<string, string>
  /**
   * Where Checkout hands the buyer back (freemium-scanner-first T14).
   *
   * - `"welcome"` (default, every pre-T14 caller): today's behaviour, byte for byte —
   *   `return_url` = `/welcome?session_id=…` with Stripe's default
   *   `redirect_on_completion: "always"` (left implicit, so the created params object is
   *   unchanged for those callers).
   * - `"contextual"`: the Premium sheet's in-place completion. `redirect_on_completion:
   *   "if_required"` keeps a card/wallet payment INSIDE the sheet (Stripe fires the
   *   embedded `onComplete` callback instead of navigating) while still allowing the
   *   redirect-based methods — PayPal above all — that `"never"` would silently remove
   *   from the payment-method list. Those methods come back to `contextualReturnUrl`,
   *   which is the ORIGINATING app surface, never `/welcome`.
   */
  completion?: "welcome" | "contextual"
  /** Required with `completion: "contextual"` — already-sanitized, origin-absolute. */
  contextualReturnUrl?: string
}

export function buildStripeCheckoutSessionParams({
  checkoutKind = "subscription",
  origin,
  priceId,
  presentation = "embedded_page",
  customerId,
  customerEmail,
  leadId,
  funnelSessionId,
  funnelPackageKey,
  checkoutContext,
  returnDestination,
  reactivationReservationId,
  expiresAt,
  metadata: extraMetadata,
  completion = "welcome",
  contextualReturnUrl,
}: BuildStripeCheckoutSessionParamsInput): Stripe.Checkout.SessionCreateParams {
  const isElementsPresentation = presentation === "elements"
  const isOneTimePurchase = checkoutKind === "personal_plan_once"
  const isContextualCompletion = completion === "contextual"
  if (isContextualCompletion && !contextualReturnUrl) {
    throw new Error("contextual checkout completion requires a return url")
  }

  return {
    mode: isOneTimePurchase ? "payment" : "subscription",
    ui_mode: presentation,
    line_items: [{ price: priceId, quantity: 1 }],
    // Pass customer OR customer_email — never both (Stripe rejects that combination)
    ...(customerId ? { customer: customerId } : { customer_email: customerEmail }),
    // One-time purchases need a Customer even when Checkout starts with only an email.
    ...(isOneTimePurchase && !customerId ? { customer_creation: "always" } : {}),
    ...(isContextualCompletion
      ? {
          redirect_on_completion: "if_required" as const,
          return_url: contextualReturnUrl!,
        }
      : { return_url: `${origin}/welcome?session_id={CHECKOUT_SESSION_ID}` }),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    automatic_tax: { enabled: true },
    ...(isOneTimePurchase
      ? {
          payment_intent_data: {
            metadata: {
              product_kind: "personal_plan_once",
              ...(extraMetadata?.checkout_attempt_id
                ? { checkout_attempt_id: extraMetadata.checkout_attempt_id }
                : {}),
              ...(extraMetadata?.is_internal_test
                ? { is_internal_test: extraMetadata.is_internal_test }
                : {}),
            },
          },
        }
      : {}),
    ...(!isOneTimePurchase && extraMetadata?.is_internal_test
      ? {
          subscription_data: {
            metadata: { is_internal_test: extraMetadata.is_internal_test },
          },
        }
      : {}),
    ...(isElementsPresentation
      ? { excluded_payment_method_types: ["sepa_debit", "paypal"] }
      : {
          consent_collection: { terms_of_service: "required" },
          custom_text: {
            terms_of_service_acceptance: {
              message:
                "Ich akzeptiere die AGB. Mein gesetzliches 14-tägiges Widerrufsrecht bleibt unberührt: https://chaarlie.de/widerruf.",
            },
          },
          excluded_payment_method_types: ["sepa_debit"],
        }),
    metadata:
      leadId ||
      funnelSessionId ||
      funnelPackageKey ||
      checkoutContext ||
      returnDestination ||
      reactivationReservationId ||
      isOneTimePurchase ||
      extraMetadata
        ? {
            ...(leadId ? { lead_id: leadId } : {}),
            ...(funnelSessionId ? { funnel_session_id: funnelSessionId } : {}),
            ...(funnelPackageKey ? { funnel_package_key: funnelPackageKey } : {}),
            ...(checkoutContext ? { checkout_context: checkoutContext } : {}),
            ...(returnDestination ? { return_destination: returnDestination } : {}),
            ...(reactivationReservationId
              ? { reactivation_reservation_id: reactivationReservationId }
              : {}),
            ...(isOneTimePurchase ? { product_kind: "personal_plan_once" } : {}),
            ...extraMetadata,
          }
        : undefined,
  }
}
