import { after, NextResponse } from "next/server"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { handlePayPalWebhookEvent } from "@/lib/paypal/webhook-handlers"
import { getBillingTierIds } from "@/lib/billing/tier-ids"
import { linkQuizToProfile } from "@/lib/quiz/link-to-profile"
import type { PaymentFailureReporter } from "@/lib/observability/payment"
import { captureServerPaymentFailure } from "@/lib/observability/payment-server"
import { resolvePaymentRuntime } from "@/lib/billing/payment-runtime-config"

export const runtime = "nodejs"
/**
 * Matches the Stripe webhook's ceiling. The handler now awaits the Premium sheet's freemium
 * provisioning inside the response (`provisionPremiumSheetPurchase`), and its own 20s budget
 * only protects the buyer if the platform does not kill the invocation first: a kill leaves
 * the event CLAIMED — the claim is released in a `catch`, which a kill never reaches — and
 * every redelivery afterwards is dropped as a duplicate. Raising the ceiling can only help
 * the legacy events too, for the same reason.
 */
export const maxDuration = 60

type PayPalVerifyWebhookResponse = {
  verification_status?: string
}

async function getTierIds(supabase: SupabaseClient) {
  return getBillingTierIds(supabase)
}

type PayPalWebhookRouteDeps = {
  createSupabaseClient: () => SupabaseClient
  getTierIds: typeof getTierIds
  handlePayPalWebhookEvent: typeof handlePayPalWebhookEvent
  capturePaymentFailure: PaymentFailureReporter
  verifyPayPalWebhookSignature: typeof verifyPayPalWebhookSignature
}

export async function handlePayPalWebhookPost(
  request: Request,
  overrides: Partial<PayPalWebhookRouteDeps> = {},
) {
  const {
    createSupabaseClient = () =>
      createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
        auth: { persistSession: false },
      }),
    getTierIds: resolveTierIds = getTierIds,
    handlePayPalWebhookEvent: handleEvent = handlePayPalWebhookEvent,
    capturePaymentFailure: capturePayment = captureServerPaymentFailure,
    verifyPayPalWebhookSignature: verifySignature = verifyPayPalWebhookSignature,
  } = overrides
  const startedAt = Date.now()
  const rawBody = await request.text()
  const webhookId = process.env.PAYPAL_WEBHOOK_ID
  if (!webhookId) return new NextResponse("server misconfigured", { status: 500 })

  let event: unknown
  try {
    event = JSON.parse(rawBody)
  } catch {
    return new NextResponse("invalid json", { status: 400 })
  }

  let verified = false
  try {
    verified = await verifySignature(request, webhookId, event)
  } catch (err) {
    console.warn("[paypal:webhook] signature verification failed:", err)
    return new NextResponse("signature verification failed", { status: 400 })
  }
  if (!verified) return new NextResponse("signature verification failed", { status: 400 })

  const supabase = createSupabaseClient()

  try {
    const { premiumTierId, freeTierId } = await resolveTierIds(supabase)
    await handleEvent(event as Parameters<typeof handlePayPalWebhookEvent>[0], {
      supabase,
      premiumTierId,
      freeTierId,
      linkQuizToProfile,
      defer: after,
      recordBillingAnalytics: true,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown"
    const paypalEvent = payPalEventIdentity(event)
    capturePayment({
      signal: "payment_webhook_processing_failed",
      provider: "paypal",
      boundary: "webhook",
      errorFamily: "webhook_processing",
      commerceKind: paypalWebhookCommerceKind(paypalEvent.event_type),
      origin: "webhook",
      method: "paypal",
      truth: "unknown",
      live: paymentRuntime().paypalLive,
      isInternalTest: false,
      providerReferencePresent: Boolean(paypalEvent.id),
    })
    console.error("[paypal:webhook] handler error:", err)
    return new NextResponse(`handler error: ${message}`, { status: 500 })
  }

  const paypalEvent = payPalEventIdentity(event)
  console.info("[paypal:webhook] handled", {
    eventId: paypalEvent.id,
    type: paypalEvent.event_type,
    durationMs: Date.now() - startedAt,
  })

  return NextResponse.json({ received: true })
}

export async function POST(request: Request) {
  return handlePayPalWebhookPost(request)
}

function paypalWebhookCommerceKind(eventType: string | undefined) {
  return eventType?.startsWith("BILLING.SUBSCRIPTION.") ? "subscription" : "unknown"
}

function paymentRuntime() {
  return resolvePaymentRuntime({
    VERCEL_ENV: process.env.VERCEL_ENV,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    PAYPAL_ENVIRONMENT: process.env.PAYPAL_ENVIRONMENT,
  })
}

function payPalEventIdentity(event: unknown): { id?: string; event_type?: string } {
  return event && typeof event === "object" ? (event as { id?: string; event_type?: string }) : {}
}

async function verifyPayPalWebhookSignature(
  request: Request,
  webhookId: string,
  webhookEvent: unknown,
): Promise<boolean> {
  const { paypalRequest } = await import("@/lib/paypal/client")
  const authAlgo = request.headers.get("paypal-auth-algo")
  const certUrl = request.headers.get("paypal-cert-url")
  const transmissionId = request.headers.get("paypal-transmission-id")
  const transmissionSig = request.headers.get("paypal-transmission-sig")
  const transmissionTime = request.headers.get("paypal-transmission-time")

  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
    return false
  }

  const response = await paypalRequest<PayPalVerifyWebhookResponse>(
    "/v1/notifications/verify-webhook-signature",
    {
      method: "POST",
      body: JSON.stringify({
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: webhookId,
        webhook_event: webhookEvent,
      }),
    },
  )

  return response.verification_status === "SUCCESS"
}
