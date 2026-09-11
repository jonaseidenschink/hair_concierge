"use client"

import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js"
import dynamic from "next/dynamic"
import { useCallback, useMemo, useRef } from "react"

import { isPayPalCheckoutEnabled } from "@/components/checkout/payment-method-checkout"
import { premiumSheetPayPalReference } from "@/lib/premium-sheet/purchase-reference"
import type { BillingInterval } from "@/lib/stripe/intervals"
import { getOfferStripePromise } from "@/lib/stripe/offer-client-loader"

/**
 * The offer page's PayPal button, mounted verbatim (docket rework R1, Nick's ruling A2).
 * Same dynamic import, same loading placeholder, same `ssr: false` as
 * `payment-method-checkout.tsx` — the Stripe account has no PayPal, so this native button
 * is the only PayPal the sheet can offer, and a re-engineered one is exactly what the
 * ruling rules out.
 */
const DynamicPayPalSubscriptionButton = dynamic(
  () =>
    import("@/components/checkout/paypal-subscription-button").then(
      (module) => module.PayPalSubscriptionButton,
    ),
  {
    loading: () => (
      <div className="grid min-h-[52px] place-items-center rounded-full bg-[#ffc439] text-[17px] font-black text-[#003087]">
        PayPal
      </div>
    ),
    ssr: false,
  },
)

/**
 * Stripe embedded checkout, mounted INSIDE the Premium sheet (freemium-scanner-first T14).
 *
 * Three things separate this from the offer page's `payment-method-checkout.tsx` mount:
 *
 *  1. `onComplete`. The offer page needs no completion callback because it relies on Stripe
 *     navigating to `/welcome`. Here the Session is created with
 *     `redirect_on_completion: "if_required"`, so a card/wallet payment finishes in place
 *     and this callback is the only signal that it did. It is treated as a HINT, never as
 *     proof — the sheet's next move is to ask the server, which re-reads the Session from
 *     Stripe before anything is unlocked.
 *  2. The client secret is fetched with `source: "premium_sheet"`, which is what pins the
 *     SUBMITTED price to the standard catalog server-side (T13 carry-forward).
 *  3. **Every callback names the attempt it belongs to** (Codex fix wave, Y5). These are all
 *     async: a session-creation failure or an `onComplete` can land long after the buyer
 *     pressed „Plan ändern" and started over. The closures below capture the `attemptId`
 *     they were CREATED with, so the sheet's reducer can drop an outcome that belongs to a
 *     superseded attempt instead of replacing a live payment form with a stale failure.
 *
 * `EmbeddedCheckoutProvider` calls `fetchClientSecret` once per mount, so the `key` this
 * component gives it (the attempt id) is what starts a NEW checkout; re-rendering never does.
 *
 * **PayPal (docket rework R1, Nick's ruling A2).** T14 assumed PayPal could ride along
 * inside Stripe's embedded checkout; the Stripe account does not have it enabled, so the
 * sheet offered no PayPal at all. It now mounts the offer page's own
 * `PayPalSubscriptionButton` below the card form as a separate button — the proven
 * integration, verbatim, with exactly one prop the offer page does not pass (`onApproved`),
 * which is what keeps the completion contextual instead of navigating to `/welcome`.
 */
export function PremiumSheetCheckout({
  interval,
  attemptId,
  returnPath,
  onReady,
  onFailed,
  onCompleted,
}: {
  interval: BillingInterval
  /** Stable per CTA press. Doubles as the server-side Stripe idempotency key. */
  attemptId: string
  /** The surface the sheet was opened from, for redirect-based payment methods. */
  returnPath: string
  onReady: (attemptId: string) => void
  onFailed: (attemptId: string) => void
  /**
   * Fires with the purchase reference once a provider reports its payment form finished —
   * a Stripe Session id, or this sheet's PayPal reference (docket rework R1). Either way a
   * hint, never proof: the sheet's next move is to ask the server.
   */
  onCompleted: (reference: string, attemptId: string) => void
}) {
  const stripe = useMemo(() => getOfferStripePromise(), [])
  // Stripe's embedded `onComplete` takes no arguments, so the Session id has to be carried
  // over from the creation response. A ref (not state) on purpose: writing it must not
  // re-render and remount the provider mid-payment. The attempt is stored WITH it — this
  // component is not remounted between attempts, so a bare session id would let a late
  // `onComplete` from attempt A report attempt B's Session.
  const sessionRef = useRef<{ attemptId: string; sessionId: string } | null>(null)

  const fetchClientSecret = useCallback(async () => {
    let response: Response
    try {
      response = await fetch("/api/stripe/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interval,
          source: "premium_sheet",
          checkoutAttemptId: attemptId,
          returnPath,
        }),
      })
    } catch (error) {
      onFailed(attemptId)
      throw error
    }
    if (!response.ok) {
      onFailed(attemptId)
      throw new Error(`premium sheet checkout session failed: ${response.status}`)
    }
    const payload = (await response.json().catch(() => null)) as {
      client_secret?: unknown
      session_id?: unknown
    } | null
    const clientSecret = typeof payload?.client_secret === "string" ? payload.client_secret : null
    if (!clientSecret) {
      onFailed(attemptId)
      throw new Error("premium sheet checkout session returned no client secret")
    }
    sessionRef.current =
      typeof payload?.session_id === "string" ? { attemptId, sessionId: payload.session_id } : null
    onReady(attemptId)
    return clientSecret
  }, [attemptId, interval, onFailed, onReady, returnPath])

  const onComplete = useCallback(() => {
    const session = sessionRef.current
    // No session id for THIS attempt means the creation response was malformed (or this
    // callback belongs to a superseded mount) — there is nothing the server could verify,
    // so this is a failure, not a silent success.
    if (!session || session.attemptId !== attemptId) {
      onFailed(attemptId)
      return
    }
    onCompleted(session.sessionId, attemptId)
  }, [attemptId, onCompleted, onFailed])

  return (
    <div data-premium-sheet-checkout={interval}>
      <div className="min-h-[320px]">
        <EmbeddedCheckoutProvider
          key={attemptId}
          stripe={stripe}
          options={{ fetchClientSecret, onComplete }}
        >
          <EmbeddedCheckout />
        </EmbeddedCheckoutProvider>
      </div>

      {/* An extra button, visually its own (Nick: „I also like if it's an extra button") —
          below the card form, behind the same „oder" divider the offer page uses. */}
      {isPayPalCheckoutEnabled() ? (
        <div data-premium-sheet-paypal="true" className="mt-4 grid gap-3">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-[11px] font-bold uppercase text-[var(--text-caption)]">
            <span className="h-px bg-border" aria-hidden="true" />
            <span>oder</span>
            <span className="h-px bg-border" aria-hidden="true" />
          </div>
          <div>
            <DynamicPayPalSubscriptionButton
              key={`paypal:${attemptId}`}
              checkoutAttemptId={attemptId}
              interval={interval}
              /**
               * The only prop the offer page does not pass. With it, the verified approval
               * comes back here instead of navigating to `/welcome`, and the sheet finishes
               * the purchase where the buyer already is.
               */
              onApproved={(token) => onCompleted(premiumSheetPayPalReference(token), attemptId)}
              /**
               * Deliberately NOT wired to the sheet's failure state. The button surfaces its
               * own errors inline — a missing client id, a refused intent, a duplicate
               * account — exactly as it does on the offer page, and none of them may replace
               * a live card form with a failure screen. The card lane and the escape stay.
               */
              onCheckoutStarted={() => {}}
              source="premium_sheet"
            />
            <p className="mt-3 text-center text-[11px] leading-relaxed text-[var(--text-caption)]">
              PayPal öffnet sich zur Bestätigung. Danach aktivieren wir dein Konto.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}
