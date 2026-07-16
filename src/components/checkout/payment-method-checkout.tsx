"use client"

import { useReducer } from "react"
import dynamic from "next/dynamic"
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js"
import type { Stripe } from "@stripe/stripe-js"

import { Button } from "@/components/ui/button"
import type { CheckoutContext, CheckoutFailureStage } from "@/lib/analytics/events"
import type { BillingInterval } from "@/lib/stripe/intervals"

export type CheckoutFailure = {
  errorCode: string
  failureStage: CheckoutFailureStage
  retryable: boolean
}

const DynamicPayPalSubscriptionButton = dynamic(
  () => import("./paypal-subscription-button").then((module) => module.PayPalSubscriptionButton),
  {
    loading: () => (
      <div className="grid min-h-[52px] place-items-center rounded-full bg-[#ffc439] text-[17px] font-black text-[#003087]">
        PayPal
      </div>
    ),
    ssr: false,
  },
)

export function isPayPalCheckoutEnabled() {
  return process.env.NEXT_PUBLIC_PAYPAL_ENABLED === "true"
}

export type PaymentMethodCheckoutState = {
  cardCheckoutOpen: boolean
}

export function createPaymentMethodCheckoutState(
  paypalEnabled: boolean,
): PaymentMethodCheckoutState {
  return { cardCheckoutOpen: !paypalEnabled }
}

export function paymentMethodCheckoutReducer(
  state: PaymentMethodCheckoutState,
  action: "reveal_card",
): PaymentMethodCheckoutState {
  if (action === "reveal_card" && !state.cardCheckoutOpen) {
    return { cardCheckoutOpen: true }
  }
  return state
}

export function PaymentMethodCheckout({
  cardCheckoutMinHeightClassName = "min-h-[560px]",
  checkoutAttemptId,
  checkoutContext,
  checkoutError = null,
  checkoutKey,
  fetchClientSecret,
  interval,
  leadId,
  lockedProvider = null,
  onChangePlan,
  onPayPalCheckoutFailed,
  onPayPalCheckoutStarted,
  onPaymentMethodSelected,
  onRetry,
  planLabel,
  returnDestination,
  source,
  stripe,
}: {
  cardCheckoutMinHeightClassName?: "min-h-[560px]" | "min-h-[600px]"
  checkoutAttemptId?: string
  checkoutContext?: CheckoutContext
  checkoutError?: string | null
  checkoutKey: string
  fetchClientSecret: () => Promise<string>
  interval: BillingInterval
  leadId?: string | null
  lockedProvider?: "stripe" | "paypal" | null
  onChangePlan: () => void
  onPayPalCheckoutFailed?: (failure: CheckoutFailure) => void
  onPayPalCheckoutStarted: (funnelEventId: string) => void
  onPaymentMethodSelected?: (provider: "stripe" | "paypal") => void
  onRetry: () => void
  planLabel: string
  returnDestination?: string
  source: "pricing_page" | "quiz_result_offer"
  stripe: Promise<Stripe | null>
}) {
  const paypalEnabled = isPayPalCheckoutEnabled()
  const [{ cardCheckoutOpen }, dispatchPaymentMethod] = useReducer(
    paymentMethodCheckoutReducer,
    paypalEnabled,
    createPaymentMethodCheckoutState,
  )
  const showPayPalCheckout = paypalEnabled && lockedProvider !== "stripe"
  const showCardCheckout =
    lockedProvider !== "paypal" &&
    (!paypalEnabled || cardCheckoutOpen || lockedProvider === "stripe")
  const providerLockCopy =
    lockedProvider === "paypal"
      ? "Dein PayPal-Checkout läuft bereits. Bitte führe ihn hier fort."
      : lockedProvider === "stripe"
        ? "Dein Karten-Checkout läuft bereits. Bitte führe ihn hier fort."
        : null

  return (
    <div className="mt-5 rounded-[16px] border border-border bg-white p-4 shadow-[0_16px_40px_-28px_rgba(var(--brand-plum-rgb),0.45)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-[13px] font-bold text-[var(--brand-plum-darkest)]">Sicher bezahlen</p>
          <p className="text-[12px] text-muted-foreground">{planLabel}</p>
        </div>
        <Button
          type="button"
          variant="unstyled"
          onClick={onChangePlan}
          disabled={lockedProvider !== null}
          data-offer-cta={source === "quiz_result_offer" ? "change_plan" : undefined}
          data-offer-destination={source === "quiz_result_offer" ? "pricing" : undefined}
          data-offer-selected-interval={source === "quiz_result_offer" ? interval : undefined}
          data-offer-source-section={source === "quiz_result_offer" ? "pricing" : undefined}
          className="min-h-10 rounded-[10px] bg-[var(--brand-plum-ice)] px-3 text-[12px] font-bold text-[var(--brand-plum)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Plan ändern
        </Button>
      </div>

      {providerLockCopy ? (
        <p className="mb-3 rounded-[12px] bg-[var(--brand-plum-ice)] px-3 py-2 text-[12px] font-semibold leading-relaxed text-[var(--brand-plum-darkest)]">
          {providerLockCopy}
        </p>
      ) : null}

      {showPayPalCheckout ? (
        <div className="grid gap-3">
          <div>
            <DynamicPayPalSubscriptionButton
              checkoutAttemptId={checkoutAttemptId}
              checkoutContext={checkoutContext}
              interval={interval}
              leadId={leadId}
              onCheckoutFailed={onPayPalCheckoutFailed}
              onCheckoutStarted={onPayPalCheckoutStarted}
              onPaymentMethodSelected={onPaymentMethodSelected}
              returnDestination={returnDestination}
              source={source}
            />
            <p className="mt-3 text-center text-[11px] leading-relaxed text-[var(--text-caption)]">
              PayPal öffnet sich zur Bestätigung. Danach aktivieren wir dein Konto.
            </p>
          </div>

          {lockedProvider === null ? (
            <>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-[11px] font-bold uppercase text-[var(--text-caption)]">
                <span className="h-px bg-border" aria-hidden="true" />
                <span>oder</span>
                <span className="h-px bg-border" aria-hidden="true" />
              </div>

              <div>
                <button
                  type="button"
                  aria-controls="card-checkout"
                  aria-describedby={!cardCheckoutOpen ? "payment-method-helper" : undefined}
                  aria-expanded={cardCheckoutOpen}
                  onClick={() => {
                    if (!cardCheckoutOpen) onPaymentMethodSelected?.("stripe")
                    dispatchPaymentMethod("reveal_card")
                  }}
                  className={`min-h-[52px] w-full rounded-[12px] border bg-white px-4 text-[16px] font-bold text-[var(--brand-plum-darkest)] transition-colors ${
                    cardCheckoutOpen
                      ? "border-[var(--brand-plum)] bg-[var(--brand-plum-ice)]"
                      : "border-border hover:border-[var(--brand-plum-light)]"
                  }`}
                >
                  Karte & weitere
                </button>
                {!cardCheckoutOpen ? (
                  <p
                    id="payment-method-helper"
                    className="mt-3 text-center text-[11px] leading-relaxed text-[var(--text-caption)]"
                  >
                    Im sicheren Checkout siehst du alle verfügbaren Zahlungsarten.
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {showCardCheckout ? (
        <div id="card-checkout" className={paypalEnabled ? "mt-3" : undefined}>
          {checkoutError ? (
            <div className="rounded-[14px] border border-destructive/30 bg-destructive/10 p-5 text-center">
              <p className="mb-3 text-sm text-destructive">{checkoutError}</p>
              <Button
                type="button"
                variant="unstyled"
                onClick={onRetry}
                className="min-h-10 rounded-[10px] bg-[var(--brand-coral)] px-4 text-sm font-bold text-white"
              >
                Erneut versuchen
              </Button>
            </div>
          ) : (
            <div className={cardCheckoutMinHeightClassName}>
              <EmbeddedCheckoutProvider
                key={checkoutKey}
                stripe={stripe}
                options={{ fetchClientSecret }}
              >
                <EmbeddedCheckout />
              </EmbeddedCheckoutProvider>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
