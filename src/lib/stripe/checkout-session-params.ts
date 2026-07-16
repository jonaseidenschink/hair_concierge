import type Stripe from "stripe"

type BuildStripeCheckoutSessionParamsInput = {
  origin: string
  priceId: string
  customerId?: string
  customerEmail?: string
  leadId?: string | null
  funnelSessionId?: string | null
  funnelPackageKey?: string | null
  checkoutContext?: "membership_reactivation" | null
  returnDestination?: string | null
  reactivationReservationId?: string | null
}

export function buildStripeCheckoutSessionParams({
  origin,
  priceId,
  customerId,
  customerEmail,
  leadId,
  funnelSessionId,
  funnelPackageKey,
  checkoutContext,
  returnDestination,
  reactivationReservationId,
}: BuildStripeCheckoutSessionParamsInput): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "subscription",
    ui_mode: "embedded_page",
    line_items: [{ price: priceId, quantity: 1 }],
    // Pass customer OR customer_email — never both (Stripe rejects that combination)
    ...(customerId ? { customer: customerId } : { customer_email: customerEmail }),
    return_url: `${origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    automatic_tax: { enabled: true },
    consent_collection: { terms_of_service: "required" },
    custom_text: {
      terms_of_service_acceptance: {
        message:
          "Ich stimme zu, dass der Zugriff auf das Abo sofort beginnt und ich damit mein 14-tägiges Widerrufsrecht verliere (§ 356 Abs. 4 BGB).",
      },
    },
    excluded_payment_method_types: ["sepa_debit"],
    metadata:
      leadId ||
      funnelSessionId ||
      funnelPackageKey ||
      checkoutContext ||
      returnDestination ||
      reactivationReservationId
        ? {
            ...(leadId ? { lead_id: leadId } : {}),
            ...(funnelSessionId ? { funnel_session_id: funnelSessionId } : {}),
            ...(funnelPackageKey ? { funnel_package_key: funnelPackageKey } : {}),
            ...(checkoutContext ? { checkout_context: checkoutContext } : {}),
            ...(returnDestination ? { return_destination: returnDestination } : {}),
            ...(reactivationReservationId
              ? { reactivation_reservation_id: reactivationReservationId }
              : {}),
          }
        : undefined,
  }
}
