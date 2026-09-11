"use client"

import { useEffect, useRef, useState } from "react"
import {
  FUNDING,
  PayPalButtons,
  PayPalScriptProvider,
  usePayPalScriptReducer,
} from "@paypal/react-paypal-js"
import type { CreateSubscriptionActions, OnApproveData } from "@paypal/paypal-js"

import { usePaymentRuntime } from "@/components/providers/payment-runtime-provider"
import { PaymentFeedbackCard } from "@/components/checkout/payment-feedback-card"
import { usePaymentSupportReport } from "@/components/checkout/use-payment-support-report"
import { useOfferTrackingContext } from "@/components/quiz/offer-tracking-provider"
import { addCheckoutBreadcrumb } from "@/lib/observability/checkout"
import type { CheckoutStage } from "@/lib/observability/checkout"
import { capturePaymentFailure, type PaymentErrorFamily } from "@/lib/observability/payment-client"
import type { BillingInterval } from "@/lib/stripe/intervals"
import type { PayPalCheckoutSource } from "@/lib/paypal/checkout-intents"
import { createFunnelEventId } from "@/lib/funnel/client"
import { paymentFeedback } from "@/lib/checkout/payment-feedback"
import { isPaymentFeedbackV2Enabled, isPaymentSupportUiEnabled } from "@/lib/funnel/flags"
import type { CheckoutFailure } from "./payment-method-checkout"
import type { CheckoutContext } from "@/lib/analytics/events"
import { reportPayPalScriptFailureOnce } from "./paypal-script-failure"
import {
  createCheckoutWatchdog,
  createCheckoutWatchdogRegistry,
} from "@/lib/observability/checkout-watchdog"
import {
  ActiveSubscriptionDialog,
  checkoutAccessAlreadyExistsError,
  isCheckoutAccessAlreadyExistsResponse,
  readCheckoutAccessAlreadyExistsEmail,
} from "./active-subscription-dialog"

const paypalStartError = "PayPal-Zahlung konnte nicht gestartet werden. Bitte versuche es erneut."

function capturePayPalSubscriptionCustomerPaymentError({
  checkoutAttemptId,
  errorFamily,
  interval,
  isInternalTest,
  leadId,
  live,
  providerReferencePresent = false,
  retryable = "true",
  signal = "customer_payment_error_observed",
  source,
  stage,
  status,
  durationMs,
}: {
  checkoutAttemptId?: string
  errorFamily: PaymentErrorFamily
  interval: BillingInterval
  isInternalTest: boolean
  leadId?: string | null
  live: boolean
  providerReferencePresent?: boolean
  retryable?: "true" | "false"
  signal?: "checkout_experience_degraded" | "customer_payment_error_observed"
  source: PayPalCheckoutSource
  stage: CheckoutStage
  status?: string | number | null
  durationMs?: number
}) {
  capturePaymentFailure({
    signal,
    provider: "paypal",
    stage,
    errorFamily,
    commerceKind: "subscription",
    origin: "browser",
    method: "paypal",
    truth: "unknown",
    live,
    isInternalTest,
    retryable,
    checkoutAttemptId,
    interval,
    leadId,
    source,
    status,
    durationMs,
    providerReferencePresent,
  })
}

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
  checkoutAttemptId,
  interval,
  isInternalTest,
  leadId,
  live,
  onCheckoutFailed,
  source,
  visible,
}: {
  checkoutAttemptId?: string
  interval: BillingInterval
  isInternalTest: boolean
  leadId?: string | null
  live: boolean
  onCheckoutFailed?: (failure: CheckoutFailure) => void
  source: PayPalCheckoutSource
  visible: boolean
}) {
  const [{ isRejected }] = usePayPalScriptReducer()
  const reportedRef = useRef(false)

  useEffect(() => {
    if (!visible) return
    reportPayPalScriptFailureOnce(reportedRef, isRejected, (failure) => {
      capturePayPalSubscriptionCustomerPaymentError({
        checkoutAttemptId,
        errorFamily: "provider_unavailable",
        interval,
        isInternalTest,
        leadId,
        live,
        source,
        stage: "paypal_create_subscription",
        status: failure.errorCode,
      })
      onCheckoutFailed?.(failure)
    })
  }, [
    checkoutAttemptId,
    interval,
    isInternalTest,
    isRejected,
    leadId,
    live,
    onCheckoutFailed,
    source,
    visible,
  ])

  return null
}

export function PayPalSubscriptionButton({
  checkoutAttemptId,
  checkoutContext,
  interval,
  leadId,
  onApproved,
  onCheckoutCancelled,
  onCheckoutFailed,
  onClientMounted,
  onReady,
  onCheckoutStarted,
  onConfirmStarted,
  onPaymentMethodSelected,
  onCheckoutLifecycle,
  returnDestination,
  source,
  visible = true,
}: {
  checkoutAttemptId?: string
  checkoutContext?: CheckoutContext
  interval: BillingInterval
  leadId?: string | null
  /**
   * Completion routing override (docket rework R1). PayPal's approval comes back through
   * this component's own `onApprove` CALLBACK, not a redirect — so the single thing that
   * decides where the buyer ends up is the last line of that callback.
   *
   * Absent (the offer page, the payment modal, every existing mount): the server-verified
   * approval navigates to `/welcome?provider=paypal&token=…`, byte-identical to before.
   *
   * Present (the Premium sheet): the same verified approval is handed back instead, with
   * the intent token, and the caller finishes in place. Nothing else about the button —
   * intent creation, approval, duplicate handling, observability, the error surfaces —
   * differs between the two mounts.
   */
  onApproved?: (token: string) => void
  onCheckoutCancelled?: () => void
  onCheckoutFailed?: (failure: CheckoutFailure) => void
  onClientMounted?: () => void
  onReady?: () => void
  onCheckoutStarted: (funnelEventId: string) => void
  onConfirmStarted?: () => void
  onPaymentMethodSelected?: (provider: "stripe" | "paypal") => boolean | void
  onCheckoutLifecycle?: (claim: {
    failureReason?:
      | "malformed_provider_response"
      | "provider_load_error"
      | "provider_ready_timeout"
      | "provider_request_timeout"
    option: "paypal"
    provider: "paypal"
    transition: "provider_cancelled" | "provider_load_error" | "provider_load_timeout"
  }) => void
  returnDestination?: string
  source: PayPalCheckoutSource
  visible?: boolean
}) {
  const clientId = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID?.trim()
  const [error, setError] = useState<string | null>(null)
  const [duplicateEmail, setDuplicateEmail] = useState<string | null>(null)
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false)
  const duplicateFeedback = duplicateDialogOpen
    ? paymentFeedback("access_already_active", {
        provider: "paypal",
        method: "paypal",
        accessAction: checkoutContext === "membership_reactivation" ? "profile" : "login",
      })
    : null
  const paymentErrorFeedback = error
    ? paymentFeedback("payment_not_completed", {
        provider: "paypal",
        method: "paypal",
        confirmationPhase: "after_confirm",
      })
    : null
  const paypalLoadFeedback = !clientId
    ? paymentFeedback("checkout_not_loaded", {
        provider: "paypal",
        method: "paypal",
        confirmationPhase: "before_confirm",
      })
    : null
  const activeFeedback = duplicateFeedback ?? paymentErrorFeedback ?? paypalLoadFeedback
  const supportReport = usePaymentSupportReport({
    checkoutAttemptId,
    checkoutContext:
      checkoutContext === "membership_reactivation" ? "reactivation" : "result_membership",
    feedback: activeFeedback,
  })
  const intentTokenRef = useRef<string | null>(null)
  const suppressNextPayPalErrorRef = useRef(false)
  const configurationReportedRef = useRef(false)
  const clientMountedReportedRef = useRef(false)
  const readyReportedRef = useRef(false)
  const confirmStartedReportedRef = useRef(false)
  const clearSdkWatchdogRef = useRef<(() => void) | null>(null)
  const watchdogsRef = useRef(createCheckoutWatchdogRegistry())
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const { paypalLive } = usePaymentRuntime()
  const offerContext = useOfferTrackingContext()
  const isInternalTest = offerContext?.isInternalTest ?? false

  useEffect(() => {
    clientMountedReportedRef.current = false
    readyReportedRef.current = false
    confirmStartedReportedRef.current = false
  }, [checkoutAttemptId])

  useEffect(() => {
    if (!clientId || !visible) return
    const watchdogs = watchdogsRef.current
    const watchdog = watchdogs.track(
      createCheckoutWatchdog({
        onTimeout: (durationMs) => {
          if (clientMountedReportedRef.current) return
          capturePayPalSubscriptionCustomerPaymentError({
            checkoutAttemptId,
            durationMs,
            errorFamily: "timeout",
            interval,
            isInternalTest,
            leadId,
            live: paypalLive,
            signal: "checkout_experience_degraded",
            source,
            stage: "paypal_create_subscription_intent",
            status: "paypal_sdk_ready_timeout",
          })
          onCheckoutLifecycle?.({
            failureReason: "provider_ready_timeout",
            option: "paypal",
            provider: "paypal",
            transition: "provider_load_timeout",
          })
        },
      }),
    )
    clearSdkWatchdogRef.current = () => watchdogs.settle(watchdog)
    return () => {
      watchdogs.settle(watchdog)
      if (clearSdkWatchdogRef.current) clearSdkWatchdogRef.current = null
    }
  }, [
    checkoutAttemptId,
    clientId,
    interval,
    isInternalTest,
    leadId,
    onCheckoutLifecycle,
    paypalLive,
    source,
    visible,
  ])

  useEffect(() => {
    if (visible) return
    watchdogsRef.current.settleAll()
    clearSdkWatchdogRef.current = null
  }, [visible])

  useEffect(() => {
    const watchdogs = watchdogsRef.current
    return () => watchdogs.settleAll()
  }, [])

  useEffect(() => {
    if (clientId || configurationReportedRef.current) return
    configurationReportedRef.current = true
    capturePayPalSubscriptionCustomerPaymentError({
      checkoutAttemptId,
      errorFamily: "configuration",
      interval,
      isInternalTest,
      leadId,
      live: paypalLive,
      retryable: "false",
      source,
      stage: "paypal_create_subscription_intent",
      status: "paypal_client_id_missing",
    })
    onCheckoutFailed?.({
      errorCode: "paypal_client_id_missing",
      failureStage: "configuration",
      retryable: false,
    })
  }, [
    checkoutAttemptId,
    clientId,
    interval,
    isInternalTest,
    leadId,
    onCheckoutFailed,
    paypalLive,
    source,
  ])

  if (!clientId) {
    if (isPaymentFeedbackV2Enabled() && paypalLoadFeedback) {
      return (
        <PaymentFeedbackCard
          feedback={paypalLoadFeedback}
          onAction={() => window.location.reload()}
          onReportProblem={
            checkoutAttemptId && isPaymentSupportUiEnabled() ? supportReport.report : undefined
          }
          reportState={supportReport.state}
        />
      )
    }
    return (
      <div className="rounded-[14px] border border-destructive/30 bg-destructive/10 p-4 text-center">
        <p className="text-sm text-destructive">{paypalStartError}</p>
      </div>
    )
  }

  if (duplicateFeedback && isPaymentFeedbackV2Enabled()) {
    return (
      <PaymentFeedbackCard
        feedback={duplicateFeedback}
        onAction={() => {
          const href =
            checkoutContext === "membership_reactivation"
              ? "/profile"
              : duplicateEmail
                ? `/auth?email=${encodeURIComponent(duplicateEmail)}`
                : "/auth"
          window.location.assign(href)
        }}
        onReportProblem={
          checkoutAttemptId && isPaymentSupportUiEnabled() ? supportReport.report : undefined
        }
        reportState={supportReport.state}
      />
    )
  }

  return (
    <div>
      {!isPaymentFeedbackV2Enabled() ? (
        <ActiveSubscriptionDialog
          email={duplicateEmail}
          onOpenChange={setDuplicateDialogOpen}
          open={duplicateDialogOpen}
        />
      ) : null}
      <PayPalScriptProvider
        options={{
          clientId,
          components: "buttons",
          currency: "EUR",
          intent: "subscription",
          vault: true,
        }}
      >
        <PayPalScriptFailureObserver
          checkoutAttemptId={checkoutAttemptId}
          interval={interval}
          isInternalTest={isInternalTest}
          leadId={leadId}
          live={paypalLive}
          onCheckoutFailed={onCheckoutFailed}
          source={source}
          visible={visible}
        />
        <PayPalButtons
          className="w-full"
          fundingSource={FUNDING.PAYPAL}
          onInit={() => {
            clearSdkWatchdogRef.current?.()
            if (!clientMountedReportedRef.current) {
              clientMountedReportedRef.current = true
              onClientMounted?.()
            }
            if (!readyReportedRef.current) {
              readyReportedRef.current = true
              onReady?.()
            }
          }}
          createSubscription={async (
            _data: Record<string, unknown>,
            actions: CreateSubscriptionActions,
          ) => {
            setError(null)
            suppressNextPayPalErrorRef.current = false
            if (onPaymentMethodSelected?.("paypal") === false) {
              suppressNextPayPalErrorRef.current = true
              throw new Error("another payment provider is already active")
            }
            const funnelEventId = createFunnelEventId()
            addCheckoutBreadcrumb({
              provider: "paypal",
              stage: "paypal_create_subscription_intent",
              source,
              interval,
              leadId,
            })
            let intent: Awaited<ReturnType<typeof createSubscriptionIntent>>
            try {
              if (!confirmStartedReportedRef.current) {
                confirmStartedReportedRef.current = true
                onConfirmStarted?.()
              }
              const watchdog = watchdogsRef.current.track(
                createCheckoutWatchdog({
                  onTimeout: (durationMs) => {
                    capturePayPalSubscriptionCustomerPaymentError({
                      checkoutAttemptId,
                      durationMs,
                      errorFamily: "timeout",
                      interval,
                      isInternalTest,
                      leadId,
                      live: paypalLive,
                      signal: "checkout_experience_degraded",
                      source,
                      stage: "paypal_create_subscription_intent",
                      status: "paypal_create_subscription_intent_timeout",
                    })
                    onCheckoutLifecycle?.({
                      failureReason: "provider_request_timeout",
                      option: "paypal",
                      provider: "paypal",
                      transition: "provider_load_timeout",
                    })
                  },
                }),
              )
              try {
                intent = await createSubscriptionIntent({
                  checkoutAttemptId,
                  checkoutContext,
                  interval,
                  leadId,
                  returnDestination,
                  source,
                  funnelEventId,
                })
              } finally {
                watchdogsRef.current.settle(watchdog)
              }
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
              suppressNextPayPalErrorRef.current = true
              capturePayPalSubscriptionCustomerPaymentError({
                checkoutAttemptId,
                errorFamily: "provider_session",
                interval,
                isInternalTest,
                source,
                leadId,
                live: paypalLive,
                stage: "paypal_create_subscription_intent",
                status: "intent_failed",
              })
              onCheckoutFailed?.({
                errorCode: "paypal_intent_failed",
                failureStage: "provider_intent",
                retryable: true,
              })
              throw err
            }
            onCheckoutStarted(funnelEventId)
            intentTokenRef.current = intent.token
            addCheckoutBreadcrumb({
              provider: "paypal",
              stage: "paypal_create_subscription",
              source,
              interval,
              leadId,
            })
            try {
              const watchdog = watchdogsRef.current.track(
                createCheckoutWatchdog({
                  onTimeout: (durationMs) => {
                    capturePayPalSubscriptionCustomerPaymentError({
                      checkoutAttemptId,
                      durationMs,
                      errorFamily: "timeout",
                      interval,
                      isInternalTest,
                      leadId,
                      live: paypalLive,
                      signal: "checkout_experience_degraded",
                      source,
                      stage: "paypal_create_subscription",
                      status: "paypal_subscription_create_timeout",
                    })
                    onCheckoutLifecycle?.({
                      failureReason: "provider_request_timeout",
                      option: "paypal",
                      provider: "paypal",
                      transition: "provider_load_timeout",
                    })
                  },
                }),
              )
              try {
                return await actions.subscription.create({
                  plan_id: intent.planId,
                  custom_id: intent.token,
                  application_context: {
                    shipping_preference: "NO_SHIPPING",
                  },
                } as Parameters<CreateSubscriptionActions["subscription"]["create"]>[0])
              } finally {
                watchdogsRef.current.settle(watchdog)
              }
            } catch (err) {
              setError(paypalStartError)
              suppressNextPayPalErrorRef.current = true
              capturePayPalSubscriptionCustomerPaymentError({
                checkoutAttemptId,
                errorFamily: "provider_session",
                interval,
                isInternalTest,
                source,
                leadId,
                live: paypalLive,
                stage: "paypal_create_subscription",
                status: "subscription_create_failed",
              })
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
              capturePayPalSubscriptionCustomerPaymentError({
                checkoutAttemptId,
                errorFamily: "provider_session",
                interval,
                isInternalTest,
                source,
                leadId,
                live: paypalLive,
                stage: "paypal_approve_subscription",
                status: "approval_payload_incomplete",
                providerReferencePresent: Boolean(data.subscriptionID),
              })
              onCheckoutFailed?.({
                errorCode: "paypal_approval_payload_incomplete",
                failureStage: "provider_approval",
                retryable: true,
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
              const watchdog = watchdogsRef.current.track(
                createCheckoutWatchdog({
                  onTimeout: (durationMs) => {
                    capturePayPalSubscriptionCustomerPaymentError({
                      checkoutAttemptId,
                      durationMs,
                      errorFamily: "timeout",
                      interval,
                      isInternalTest,
                      leadId,
                      live: paypalLive,
                      providerReferencePresent: true,
                      signal: "checkout_experience_degraded",
                      source,
                      stage: "paypal_approve_subscription",
                      status: "paypal_approve_subscription_timeout",
                    })
                    onCheckoutLifecycle?.({
                      failureReason: "provider_request_timeout",
                      option: "paypal",
                      provider: "paypal",
                      transition: "provider_load_timeout",
                    })
                  },
                }),
              )
              try {
                approved = await approveSubscriptionIntent(token, data.subscriptionID)
              } finally {
                watchdogsRef.current.settle(watchdog)
              }
            } catch {
              setError(paypalStartError)
              capturePayPalSubscriptionCustomerPaymentError({
                checkoutAttemptId,
                errorFamily: "network",
                interval,
                isInternalTest,
                source,
                leadId,
                live: paypalLive,
                stage: "paypal_approve_subscription",
                status: "approval_request_failed",
                providerReferencePresent: true,
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
              capturePayPalSubscriptionCustomerPaymentError({
                checkoutAttemptId,
                errorFamily: "provider_session",
                interval,
                isInternalTest,
                source,
                leadId,
                live: paypalLive,
                stage: "paypal_approve_subscription",
                status: approved.status,
                providerReferencePresent: true,
              })
              setError(paypalStartError)
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
            // The ONLY divergence between the offer page's mount and the Premium sheet's
            // (docket rework R1). Without the override this is the historical navigation.
            if (onApproved) onApproved(token)
            else window.location.assign(buildPayPalWelcomeUrl(token))
          }}
          onCancel={() => {
            onCheckoutLifecycle?.({
              option: "paypal",
              provider: "paypal",
              transition: "provider_cancelled",
            })
            onCheckoutCancelled?.()
          }}
          onError={() => {
            if (!visibleRef.current) return
            if (suppressNextPayPalErrorRef.current) {
              suppressNextPayPalErrorRef.current = false
              return
            }
            setError(paypalStartError)
            capturePayPalSubscriptionCustomerPaymentError({
              checkoutAttemptId,
              errorFamily: "unknown",
              interval,
              isInternalTest,
              source,
              leadId,
              live: paypalLive,
              stage: "paypal_create_subscription",
              status: "paypal_button_error",
            })
            onCheckoutLifecycle?.({
              failureReason: "provider_load_error",
              option: "paypal",
              provider: "paypal",
              transition: "provider_load_error",
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
      {error && paymentErrorFeedback && isPaymentFeedbackV2Enabled() ? (
        <div className="mt-3">
          <PaymentFeedbackCard
            feedback={paymentErrorFeedback}
            onAction={() => setError(null)}
            onReportProblem={
              checkoutAttemptId && isPaymentSupportUiEnabled() ? supportReport.report : undefined
            }
            reportState={supportReport.state}
          />
        </div>
      ) : error ? (
        <p className="mt-3 text-center text-sm text-destructive">{error}</p>
      ) : null}
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
  { ok: true } | { ok: false; duplicate: boolean; email?: string | null; status: number }
> {
  const response = await fetch("/api/paypal/approve-subscription", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, subscription_id: subscriptionId }),
  })
  if (response.ok) return { ok: true }

  const body = await response.json().catch(() => ({}))
  return {
    ok: false,
    duplicate: isCheckoutAccessAlreadyExistsResponse(response, body),
    email: readCheckoutAccessAlreadyExistsEmail(body),
    status: response.status,
  }
}
