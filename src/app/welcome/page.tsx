import { redirect } from "next/navigation"
import { createHash } from "node:crypto"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { captureCheckoutException } from "@/lib/observability/checkout"
import { linkQuizToProfile } from "@/lib/quiz/link-to-profile"
import {
  ensurePayPalCheckoutAccountForToken,
  PayPalCheckoutActivationError,
} from "@/lib/paypal/checkout-activation"
import { getPremiumTierId } from "@/lib/billing/tier-ids"
import { getAuthenticatedCheckoutSuccessRedirect } from "@/lib/billing/checkout-success-redirect"
import { findPayPalCheckoutIntentByToken } from "@/lib/paypal/checkout-intents"
import { sanitizeReactivationReturnDestination } from "@/lib/reactivation/return-destination"
import { markMembershipReactivationCheckoutCompleted } from "@/lib/reactivation/checkout-reservations"
import { getStripe } from "@/lib/stripe/client"
import {
  CheckoutActivationError,
  ensureCheckoutAccount,
  verifyCheckoutSessionForActivation,
} from "@/lib/stripe/checkout-activation"
import { buildCheckoutPurchaseAnalytics } from "@/lib/stripe/purchase-analytics"
import { WelcomeClient } from "./welcome-client"

export const dynamic = "force-dynamic"

export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string; session_id?: string; token?: string }>
}) {
  const { provider, session_id, token } = await searchParams
  if (provider === "paypal") {
    return renderPayPalWelcome(token)
  }

  if (!session_id) redirect("/")
  return renderStripeWelcome(session_id)
}

async function renderStripeWelcome(session_id: string) {
  const stripe = getStripe()
  let session
  try {
    session = await verifyCheckoutSessionForActivation(session_id, stripe)
  } catch (err) {
    if (err instanceof CheckoutActivationError) {
      captureCheckoutException(err, {
        provider: "stripe",
        stage: "checkout_return",
        source: "welcome",
        stripeSessionId: session_id,
        reason: err.code,
      })
      redirect("/pricing")
    }
    throw err
  }

  const email = session.customer_details?.email
  if (!email) redirect("/")
  const purchaseAnalytics = await buildCheckoutPurchaseAnalytics(session, stripe).catch((err) => {
    console.error("[welcome] purchase analytics unavailable:", err)
    captureCheckoutException(err, {
      provider: "stripe",
      stage: "checkout_return",
      source: "welcome",
      stripeSessionId: session_id,
      reason: "purchase_analytics_unavailable",
    })
    return null
  })

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user?.email?.toLowerCase() === email.toLowerCase()) {
    const admin = createAdminClient()
    await ensureCheckoutAccount(session, {
      supabase: admin,
      stripe,
      premiumTierId: await getPremiumTierId(admin),
      linkQuizToProfile,
    })
    if (
      session.metadata?.checkout_context === "membership_reactivation" &&
      session.metadata.reactivation_reservation_id
    ) {
      await markMembershipReactivationCheckoutCompleted(
        admin,
        session.metadata.reactivation_reservation_id,
        user.id,
      ).catch((error) => {
        console.warn("[welcome] Stripe reactivation reservation completion failed", error)
      })
    }
    const returnDestination =
      session.metadata?.checkout_context === "membership_reactivation"
        ? sanitizeReactivationReturnDestination(session.metadata.return_destination)
        : null
    const redirectTo = await resolveAuthenticatedCheckoutRedirect(
      supabase,
      user.id,
      returnDestination,
    )
    return (
      <WelcomeClient
        activationSource={{ provider: "stripe", sessionId: session_id }}
        email={email}
        purchase={purchaseAnalytics}
        redirectTo={redirectTo}
        sessionId={session_id}
      />
    )
  }

  return (
    <WelcomeClient
      activationSource={{ provider: "stripe", sessionId: session_id }}
      email={email}
      purchase={purchaseAnalytics}
      sessionId={session_id}
    />
  )
}

async function renderPayPalWelcome(token: string | undefined) {
  if (!token) redirect("/")

  const admin = createAdminClient()
  const activation = await ensurePayPalCheckoutAccountForToken(token, {
    supabase: admin,
    premiumTierId: await getPremiumTierId(admin),
    linkQuizToProfile,
  }).catch((err) => {
    if (err instanceof PayPalCheckoutActivationError) {
      captureCheckoutException(err, {
        provider: "paypal",
        stage: "checkout_return",
        source: "welcome",
        paypalTokenPresent: true,
        reason: err.code,
      })
      redirect("/pricing")
    }
    throw err
  })

  if (activation.status === "duplicate") {
    return (
      <WelcomeClient
        activationSource={{ provider: "paypal", token }}
        analyticsId={paypalCheckoutAnalyticsId(token)}
        mode="duplicate"
        purchase={null}
      />
    )
  }

  if (activation.status === "pending") {
    return (
      <WelcomeClient
        activationSource={{ provider: "paypal", token }}
        analyticsId={paypalCheckoutAnalyticsId(token)}
        mode="pending"
        purchase={null}
      />
    )
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user?.email?.toLowerCase() === activation.email.toLowerCase()) {
    const intent = await findPayPalCheckoutIntentByToken(admin, token)
    const returnDestination =
      intent?.metadata?.checkout_context === "membership_reactivation"
        ? sanitizeReactivationReturnDestination(
            typeof intent.metadata.return_destination === "string"
              ? intent.metadata.return_destination
              : null,
          )
        : null
    if (
      intent?.metadata?.checkout_context === "membership_reactivation" &&
      typeof intent.metadata.reactivation_reservation_id === "string"
    ) {
      await markMembershipReactivationCheckoutCompleted(
        admin,
        intent.metadata.reactivation_reservation_id,
        user.id,
      ).catch((error) => {
        console.warn("[welcome] PayPal reactivation reservation completion failed", error)
      })
    }
    const redirectTo = await resolveAuthenticatedCheckoutRedirect(
      supabase,
      user.id,
      returnDestination,
    )
    return (
      <WelcomeClient
        activationSource={{ provider: "paypal", token }}
        analyticsId={paypalCheckoutAnalyticsId(token)}
        email={activation.email}
        providerSubscriberEmail={activation.providerSubscriberEmail}
        purchase={null}
        redirectTo={redirectTo}
      />
    )
  }

  return (
    <WelcomeClient
      activationSource={{ provider: "paypal", token }}
      analyticsId={paypalCheckoutAnalyticsId(token)}
      email={activation.email}
      providerSubscriberEmail={activation.providerSubscriberEmail}
      purchase={null}
    />
  )
}

async function resolveAuthenticatedCheckoutRedirect(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  reactivationReturnDestination: string | null,
) {
  const { data, error } = await supabase
    .from("profiles")
    .select("onboarding_completed")
    .eq("id", userId)
    .maybeSingle()

  if (error) {
    console.warn("[welcome] could not resolve existing onboarding state", error)
    return "/onboarding"
  }

  return getAuthenticatedCheckoutSuccessRedirect(
    data?.onboarding_completed,
    reactivationReturnDestination,
  )
}

function paypalCheckoutAnalyticsId(token: string): string {
  return `paypal:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`
}
