"use client"

import { useEffect, useRef, useState } from "react"
import {
  FUNDING,
  PayPalButtons,
  PayPalScriptProvider,
  usePayPalScriptReducer,
} from "@paypal/react-paypal-js"
import type { CreateSubscriptionActions, OnApproveData } from "@paypal/paypal-js"

import { addCheckoutBreadcrumb, captureCheckoutException } from "@/lib/observability/checkout"
import type { BillingInterval } from "@/lib/stripe/intervals"
import type { PayPalCheckoutSource } from "@/lib/paypal/checkout-intents"
import { createFunnelEventId } from "@/lib/funnel/client"
import type { CheckoutFailure } from "./payment-method-checkout"
import type { CheckoutContext } from "@/lib/analytics/events"
import { reportPayPalScriptFailureOnce } from "./paypal-script-failure"
import {
  ActiveSubscriptionDialog,
  checkoutAccessAlreadyExistsError,
  isCheckoutAccessAlreadyExistsResponse,
  readCheckoutAccessAlreadyExistsEmail,
} from "./active-subscription-dialog"

const paypalStartError = "PayPal-Zahlung konnte nicht gestartet werden. Bitte versuche es erneut."

class CheckoutAccessAlreadyExistsError extends Error {
  constructor(readonly email?: string | null) {
    super(checkoutAccessAlreadyExistsError)
    this.name = "CheckoutAccessAlreadyExistsError"
  }
}

export function buildPayPalWelcomeUrl(token: string) {
  const params = new URLSearchParams({
    provider: "paypal",
    token,
  })
  return `/welcome?${params.toString()}`
}

function PayPalScriptFailureObserver({
  onCheckoutFailed,
}: {
  onCheckoutFailed?: (failure: CheckoutFailure) => void
}) {
  const [{ isRejected }] = usePayPalScriptReducer()
  const reportedRef = useRef(false)

  useEffect(() => {
    reportPayPalScriptFailureOnce(reportedRef, isRejected, onCheckoutFailed)
  }, [isRejected, onCheckoutFailed])

  return null
}

export function PayPalSubscriptionButton({
  checkoutAttemptId,
  checkoutContext,
  interval,
  leadId,
  onCheckoutFailed,
  onCheckoutStarted,
  onPaymentMethodSelected,
  returnDestination,
  source,
}: {
  checkoutAttemptId?: string
  checkoutContext?: CheckoutContext
  interval: BillingInterval
  leadId?: string | null
  onCheckoutFailed?: (failure: CheckoutFailure) => void
  onCheckoutStarted: (funnelEventId: string) => void
  onPaymentMethodSelected?: (provider: "stripe" | "paypal") => void
  returnDestination?: string
  source: PayPalCheckoutSource
}) {
  const [error, setError] = useState<string | null>(null)
  const [duplicateEmail, setDuplicateEmail] = useState<string | null>(null)
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false)
  const intentTokenRef = useRef<string | null>(null)
  const suppressNextPayPalErrorRef = useRef(false)
  const clientId = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID?.trim()

  useEffect(() => {
    if (clientId) return
    onCheckoutFailed?.({
      errorCode: "paypal_client_id_missing",
      failureStage: "configuration",
      retryable: false,
    })
  }, [clientId, onCheckoutFailed])

  if (!clientId) {
    return (
      <div className="rounded-[14px] border border-destructive/30 bg-destructive/10 p-4 text-center">
        <p className="text-sm text-destructive">{paypalStartError}</p>
      </div>
    )
  }

  return (
    <div>
      <ActiveSubscriptionDialog
        email={duplicateEmail}
        onOpenChange={setDuplicateDialogOpen}
        open={duplicateDialogOpen}
      />
      <PayPalScriptProvider
        options={{
          clientId,
          components: "buttons",
          currency: "EUR",
          intent: "subscription",
          vault: true,
        }}
      >
        <PayPalScriptFailureObserver onCheckoutFailed={onCheckoutFailed} />
        <PayPalButtons
          className="w-full"
          fundingSource={FUNDING.PAYPAL}
          createSubscription={async (
            _data: Record<string, unknown>,
            actions: CreateSubscriptionActions,
          ) => {
            setError(null)
            suppressNextPayPalErrorRef.current = false
            onPaymentMethodSelected?.("paypal")
            const funnelEventId = createFunnelEventId()
            addCheckoutBreadcrumb({
              provider: "paypal",
              stage: "paypal_create_subscription",
              source,
              interval,
              leadId,
            })
            try {
              const intent = await createSubscriptionIntent({
                checkoutAttemptId,
                checkoutContext,
                interval,
                leadId,
                returnDestination,
                source,
                funnelEventId,
              })
              onCheckoutStarted(funnelEventId)
              intentTokenRef.current = intent.token
              return actions.subscription.create({
                plan_id: intent.planId,
                custom_id: intent.token,
                application_context: {
                  shipping_preference: "NO_SHIPPING",
                },
              } as Parameters<CreateSubscriptionActions["subscription"]["create"]>[0])
            } catch (err) {
              if (err instanceof CheckoutAccessAlreadyExistsError) {
                suppressNextPayPalErrorRef.current = true
                setDuplicateEmail(err.email ?? null)
                setDuplicateDialogOpen(true)
                onCheckoutFailed?.({
                  errorCode: "access_already_exists",
                  failureStage: "duplicate_access",
                  retryable: false,
                })
                throw err
              }
              setError(err instanceof Error ? err.message : paypalStartError)
              captureCheckoutException(err, {
                provider: "paypal",
                stage: "paypal_create_subscription",
                source,
                interval,
                leadId,
              })
              suppressNextPayPalErrorRef.current = true
              onCheckoutFailed?.({
                errorCode: "paypal_intent_failed",
                failureStage: "provider_intent",
                retryable: true,
              })
              throw err
            }
          }}
          onApprove={async (data: OnApproveData) => {
            const token = intentTokenRef.current
            if (!data.subscriptionID || !token) {
              setError(paypalStartError)
              onCheckoutFailed?.({
                errorCode: "paypal_approval_payload_incomplete",
                failureStage: "provider_approval",
                retryable: true,
              })
              captureCheckoutException(new Error("PayPal approval missing subscription or token"), {
                provider: "paypal",
                stage: "paypal_approve_subscription",
                source,
                interval,
                leadId,
                paypalSubscriptionId: data.subscriptionID,
                paypalTokenPresent: Boolean(token),
                reason: "approve_payload_incomplete",
              })
              return
            }
            addCheckoutBreadcrumb({
              provider: "paypal",
              stage: "paypal_approve_subscription",
              source,
              interval,
              leadId,
              paypalSubscriptionId: data.subscriptionID,
              paypalTokenPresent: true,
            })
            let approved: Awaited<ReturnType<typeof approveSubscriptionIntent>>
            try {
              approved = await approveSubscriptionIntent(token, data.subscriptionID)
            } catch (err) {
              setError(paypalStartError)
              captureCheckoutException(err, {
                provider: "paypal",
                stage: "paypal_approve_subscription",
                source,
                interval,
                leadId,
                paypalSubscriptionId: data.subscriptionID,
                paypalTokenPresent: true,
                reason: "approval_request_failed",
              })
              onCheckoutFailed?.({
                errorCode: "paypal_approval_network_error",
                failureStage: "provider_approval",
                retryable: true,
              })
              return
            }
            if (!approved.ok) {
              if (approved.duplicate) {
                addCheckoutBreadcrumb(
                  {
                    provider: "paypal",
                    stage: "checkout_return",
                    source,
                    interval,
                    leadId,
                    paypalSubscriptionId: data.subscriptionID,
                    paypalTokenPresent: true,
                    status: approved.status,
                    reason: "duplicate_access",
                  },
                  "warning",
                )
                setError(null)
                setDuplicateEmail(approved.email ?? null)
                setDuplicateDialogOpen(true)
                onCheckoutFailed?.({
                  errorCode: "access_already_exists",
                  failureStage: "duplicate_access",
                  retryable: false,
                })
                return
              }
              captureCheckoutException(new Error("PayPal subscription approval failed"), {
                provider: "paypal",
                stage: "paypal_approve_subscription",
                source,
                interval,
                leadId,
                paypalSubscriptionId: data.subscriptionID,
                paypalTokenPresent: true,
                status: approved.status,
              })
              setError(approved.message)
              onCheckoutFailed?.({
                errorCode: "paypal_approval_failed",
                failureStage: "provider_approval",
                retryable: true,
              })
              return
            }
            addCheckoutBreadcrumb({
              provider: "paypal",
              stage: "checkout_return",
              source,
              interval,
              leadId,
              paypalSubscriptionId: data.subscriptionID,
              paypalTokenPresent: true,
            })
            window.location.assign(buildPayPalWelcomeUrl(token))
          }}
          onError={(err) => {
            if (suppressNextPayPalErrorRef.current) {
              suppressNextPayPalErrorRef.current = false
              return
            }
            setError(paypalStartError)
            captureCheckoutException(err, {
              provider: "paypal",
              stage: "paypal_create_subscription",
              source,
              interval,
              leadId,
              reason: "paypal_button_error",
            })
            onCheckoutFailed?.({
              errorCode: "paypal_button_error",
              failureStage: "provider_intent",
              retryable: true,
            })
          }}
          style={{
            borderRadius: 999,
            color: "gold",
            height: 52,
            label: "paypal",
            layout: "vertical",
            shape: "pill",
            tagline: false,
          }}
        />
      </PayPalScriptProvider>
      {error ? <p className="mt-3 text-center text-sm text-destructive">{error}</p> : null}
    </div>
  )
}

async function createSubscriptionIntent({
  checkoutAttemptId,
  checkoutContext,
  interval,
  leadId,
  returnDestination,
  source,
  funnelEventId,
}: {
  checkoutAttemptId?: string
  checkoutContext?: CheckoutContext
  interval: BillingInterval
  leadId?: string | null
  returnDestination?: string
  source: PayPalCheckoutSource
  funnelEventId: string
}): Promise<{ token: string; planId: string }> {
  const response = await fetch("/api/paypal/create-subscription-intent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      checkoutAttemptId,
      checkoutContext,
      interval,
      leadId: leadId ?? null,
      returnDestination,
      source,
      funnelEventId,
    }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (isCheckoutAccessAlreadyExistsResponse(response, body)) {
      throw new CheckoutAccessAlreadyExistsError(readCheckoutAccessAlreadyExistsEmail(body))
    }
    throw new Error(paypalStartError)
  }

  const token = typeof body.token === "string" ? body.token : null
  const planId = typeof body.planId === "string" ? body.planId : null
  if (!token || !planId) throw new Error(paypalStartError)

  return { token, planId }
}

async function approveSubscriptionIntent(
  token: string,
  subscriptionId: string,
): Promise<
  | { ok: true }
  | { ok: false; duplicate: boolean; email?: string | null; message: string; status: number }
> {
  const response = await fetch("/api/paypal/approve-subscription", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, subscription_id: subscriptionId }),
  })
  if (response.ok) return { ok: true }

  const body = await response.json().catch(() => ({}))
  const message = typeof body.message === "string" ? body.message : paypalStartError
  return {
    ok: false,
    duplicate: isCheckoutAccessAlreadyExistsResponse(response, body),
    email: readCheckoutAccessAlreadyExistsEmail(body),
    message,
    status: response.status,
  }
}
