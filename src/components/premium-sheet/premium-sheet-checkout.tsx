"use client"

import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js"
import { useCallback, useMemo, useRef } from "react"

import type { BillingInterval } from "@/lib/stripe/intervals"
import { getOfferStripePromise } from "@/lib/stripe/offer-client-loader"

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
  /** Fires with the Session id once Stripe reports the payment form finished. */
  onCompleted: (sessionId: string, attemptId: string) => void
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
    <div data-premium-sheet-checkout={interval} className="min-h-[320px]">
      <EmbeddedCheckoutProvider
        key={attemptId}
        stripe={stripe}
        options={{ fetchClientSecret, onComplete }}
      >
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  )
}
