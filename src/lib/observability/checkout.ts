import * as Sentry from "@sentry/nextjs"

export { scrubSentryBreadcrumb, scrubSentryEvent } from "@/lib/observability/sentry-scrubbing"

export type CheckoutProvider = "stripe" | "paypal"
export type CheckoutInterval = "month" | "quarter" | "year"
export type CheckoutSource =
  | "pricing_page"
  | "quiz_result_offer"
  | "welcome"
  | "reactivation"
  // freemium-scanner-first T14: checkout started inside the Premium sheet.
  | "premium_sheet"

export type CheckoutStage =
  | "stripe_checkout_session_create"
  | "stripe_embedded_checkout_client_secret"
  | "stripe_embedded_checkout_load"
  | "stripe_express_checkout_confirm"
  | "stripe_prepared_checkout_sync"
  | "stripe_webhook_activation"
  | "paypal_create_subscription_intent"
  | "paypal_create_subscription"
  | "paypal_approve_subscription"
  | "paypal_activation_status_poll"
  | "paypal_webhook_ingestion"
  | "checkout_return"
  | "checkout_password_activation"
  | "checkout_magic_link_activation"

type BreadcrumbLevel = "debug" | "info" | "warning" | "error"
type RateLimitSource = "app" | "supabase_auth"
type PayPalOneTimeSdkCallbackPhase = "on_error"
type PayPalOneTimeSdkRecoveryOutcome =
  | "no_token"
  | "pending"
  | "pending_access"
  | "succeeded"
  | "failed_permanent"
  | "revoked"
type CheckoutBrowserFamily = "chrome" | "safari" | "firefox" | "edge" | "other" | "unknown"
type CheckoutViewportClass = "mobile" | "tablet" | "desktop" | "unknown"
type CheckoutStandaloneWebViewHint = "standalone" | "webview" | "browser" | "unknown"

export interface CheckoutSentryDetails {
  provider: CheckoutProvider
  stage: CheckoutStage
  source?: CheckoutSource
  interval?: CheckoutInterval
  leadId?: string | null
  checkoutAttemptId?: string | null
  preparationId?: string | null
  durationMs?: number
  stripeSessionId?: string | null
  stripeCustomerId?: string | null
  stripeSubscriptionId?: string | null
  paypalSubscriptionId?: string | null
  paypalEventId?: string | null
  paypalEventType?: string | null
  paypalTokenPresent?: boolean
  paypalCallbackPhase?: PayPalOneTimeSdkCallbackPhase
  paypalRecoveryOutcome?: PayPalOneTimeSdkRecoveryOutcome
  release?: string | null
  browserFamily?: CheckoutBrowserFamily
  viewportClass?: CheckoutViewportClass
  standaloneWebViewHint?: CheckoutStandaloneWebViewHint
  status?: number | string
  reason?: string | null
  rateLimitSource?: RateLimitSource
}

export interface CheckoutSentryPayload {
  tags: Record<string, string>
  context: Record<string, unknown>
}

const REDACTED_VALUE = "[Filtered]"

interface CheckoutScopeLike {
  setContext(name: string, context: Record<string, unknown>): void
  setLevel?(level: BreadcrumbLevel): void
  setTag(key: string, value: string): void
}

interface CheckoutSentrySink {
  addBreadcrumb(breadcrumb: {
    category: string
    data: Record<string, unknown>
    level: BreadcrumbLevel
    message: string
  }): void
  captureException(error: unknown): void
  withScope(callback: (scope: CheckoutScopeLike) => void): void
}

export function buildCheckoutSentryPayload(details: CheckoutSentryDetails): CheckoutSentryPayload {
  const context: Record<string, unknown> = {
    provider: details.provider,
    stage: details.stage,
  }
  const tags: Record<string, string> = {
    "checkout.provider": details.provider,
    "checkout.stage": details.stage,
  }

  addOptional(context, "source", details.source)
  addOptional(context, "interval", details.interval)
  addOptional(context, "lead_id", details.leadId)
  addOptional(context, "checkout_attempt_id", details.checkoutAttemptId)
  addOptional(context, "preparation_id", details.preparationId)
  addOptional(context, "duration_ms", details.durationMs)
  addOptional(context, "stripe_session_id", details.stripeSessionId ? REDACTED_VALUE : null)
  addOptional(context, "stripe_customer_id", details.stripeCustomerId)
  addOptional(context, "stripe_subscription_id", details.stripeSubscriptionId)
  addOptional(context, "paypal_subscription_id", details.paypalSubscriptionId)
  addOptional(context, "paypal_event_id", details.paypalEventId)
  addOptional(context, "paypal_event_type", details.paypalEventType)
  addOptional(context, "paypal_token_present", details.paypalTokenPresent)
  addOptional(context, "paypal_callback_phase", details.paypalCallbackPhase)
  addOptional(context, "paypal_recovery_outcome", details.paypalRecoveryOutcome)
  addOptional(context, "release", details.release)
  addOptional(context, "browser_family", details.browserFamily)
  addOptional(context, "viewport_class", details.viewportClass)
  addOptional(context, "standalone_webview_hint", details.standaloneWebViewHint)
  addOptional(context, "status", details.status)
  addOptional(context, "reason", details.reason)
  addOptional(context, "rate_limit_source", details.rateLimitSource)

  addTag(tags, "checkout.source", details.source)
  addTag(tags, "checkout.interval", details.interval)
  addTag(tags, "checkout.status", details.status)
  addTag(tags, "checkout.reason", details.reason)
  addTag(tags, "checkout.rate_limit_source", details.rateLimitSource)
  addTag(tags, "checkout.paypal_recovery_outcome", details.paypalRecoveryOutcome)
  addTag(tags, "checkout.browser_family", details.browserFamily)
  addTag(tags, "checkout.viewport_class", details.viewportClass)
  addTag(tags, "checkout.standalone_webview_hint", details.standaloneWebViewHint)

  return { tags, context }
}

export function getCheckoutRateLimitReason(
  error: unknown,
): "supabase_auth_email_rate_limit" | null {
  const combined = `${getErrorText(error, "message")} ${getErrorText(error, "msg")} ${getErrorText(
    error,
    "error_code",
  )} ${getErrorText(error, "code")}`.toLowerCase()

  const status = getErrorNumber(error, "status")
  if (
    status === 429 ||
    combined.includes("over_email_send_rate_limit") ||
    combined.includes("email rate limit") ||
    combined.includes("email send rate")
  ) {
    return "supabase_auth_email_rate_limit"
  }

  return null
}

export function addCheckoutBreadcrumb(
  details: CheckoutSentryDetails,
  level: BreadcrumbLevel = "info",
  sink: CheckoutSentrySink = Sentry,
) {
  const payload = buildCheckoutSentryPayload(details)
  sink.addBreadcrumb({
    category: "checkout",
    data: payload.context,
    level,
    message: `checkout.${details.stage}`,
  })
}

export function captureCheckoutException(
  error: unknown,
  details: CheckoutSentryDetails,
  sink: CheckoutSentrySink = Sentry,
) {
  const payload = buildCheckoutSentryPayload(details)
  sink.withScope((scope) => {
    for (const [key, value] of Object.entries(payload.tags)) {
      scope.setTag(key, value)
    }
    scope.setContext("checkout", payload.context)
    scope.setLevel?.("error")
    sink.captureException(error)
  })
}

export function capturePayPalOneTimeSdkRecoveryWarning(
  details: {
    checkoutAttemptId: string
    isInternalTest: boolean
    live: boolean
    paypalTokenPresent: boolean
    paypalRecoveryOutcome: PayPalOneTimeSdkRecoveryOutcome
    release?: string | null
    browserFamily?: CheckoutBrowserFamily
    viewportClass?: CheckoutViewportClass
    standaloneWebViewHint?: CheckoutStandaloneWebViewHint
  },
  sink: CheckoutSentrySink = Sentry,
) {
  const payload = buildCheckoutSentryPayload({
    provider: "paypal",
    stage: "paypal_activation_status_poll",
    source: "quiz_result_offer",
    checkoutAttemptId: details.checkoutAttemptId,
    paypalCallbackPhase: "on_error",
    paypalTokenPresent: details.paypalTokenPresent,
    paypalRecoveryOutcome: details.paypalRecoveryOutcome,
    release: details.release,
    browserFamily: details.browserFamily,
    viewportClass: details.viewportClass,
    standaloneWebViewHint: details.standaloneWebViewHint,
    reason: "paypal_sdk_onerror",
    status: details.paypalRecoveryOutcome,
  })
  sink.withScope((scope) => {
    for (const [key, value] of Object.entries(payload.tags)) {
      scope.setTag(key, value)
    }
    scope.setTag("payment.signal", "customer_payment_error_observed")
    scope.setTag("payment.provider", "paypal")
    scope.setTag("payment.boundary", "provider_session")
    scope.setTag("payment.origin", "browser")
    scope.setTag("payment.method", "paypal")
    scope.setTag("payment.truth", "unknown")
    scope.setTag("payment.retryable", "true")
    scope.setTag("payment.commerce_kind", "one_time")
    scope.setTag("payment.is_internal_test", String(details.isInternalTest))
    scope.setTag("payment.live", String(details.live))
    scope.setContext("checkout", payload.context)
    scope.setLevel?.("warning")
    sink.captureException(new Error("paypal_sdk_onerror_recovery_warning"))
  })
}

function addOptional(
  target: Record<string, unknown>,
  key: string,
  value: string | number | boolean | null | undefined,
) {
  if (value === null || value === undefined || value === "") return
  target[key] = value
}

function addTag(
  target: Record<string, string>,
  key: string,
  value: string | number | null | undefined,
) {
  if (value === null || value === undefined || value === "") return
  target[key] = String(value)
}

function getErrorText(error: unknown, key: string): string {
  if (typeof error !== "object" || error === null || !(key in error)) return ""
  const value = (error as Record<string, unknown>)[key]
  return typeof value === "string" ? value : ""
}

function getErrorNumber(error: unknown, key: string): number | null {
  if (typeof error !== "object" || error === null || !(key in error)) return null
  const value = (error as Record<string, unknown>)[key]
  return typeof value === "number" ? value : null
}
