import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  advancePlanChange,
  findPlanChangeByOperationId,
  mergePendingPlanChangeMetadata,
  recordPlanChangePhase,
} from "@/lib/billing/plan-change"
import type { BillingSubscriptionRow } from "@/lib/billing/types"
import {
  PayPalPlanChangeConflictError,
  verifyApprovedPayPalPlanChange,
} from "@/lib/paypal/subscription-plan-change"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin).replace(
    /\/$/,
    "",
  )
  const operationId = new URL(request.url).searchParams.get("operationId")
  if (!operationId) return NextResponse.redirect(`${siteUrl}/profile#mitgliedschaft`)

  const cookieStore = await cookies()
  const auth = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } },
  )
  const {
    data: { user },
  } = await auth.auth.getUser()
  if (!user) {
    const next = encodeURIComponent(
      `/api/billing/change-plan/paypal/return?operationId=${operationId}`,
    )
    return NextResponse.redirect(`${siteUrl}/auth?next=${next}`)
  }

  const admin = createAdminClient()
  const operation = await findPlanChangeByOperationId(admin, operationId, user.id)
  if (!operation || operation.provider !== "paypal") {
    return NextResponse.redirect(`${siteUrl}/profile?plan-change=invalid#mitgliedschaft`)
  }
  if (operation.status === "scheduled" || operation.status === "applied") {
    return NextResponse.redirect(`${siteUrl}/profile?plan-change=scheduled#mitgliedschaft`)
  }
  if (operation.status !== "pending_approval" || !operation.provider_target_id) {
    return NextResponse.redirect(`${siteUrl}/profile?plan-change=reconciling#mitgliedschaft`)
  }

  const subscription = await findSubscription(admin, operation.billing_subscription_id)
  if (!subscription) {
    await advancePlanChange(admin, {
      operationId,
      expectedStatus: "pending_approval",
      status: "reconciling",
      failureCode: "local_subscription_missing",
    })
    return NextResponse.redirect(`${siteUrl}/profile?plan-change=reconciling#mitgliedschaft`)
  }

  try {
    await verifyApprovedPayPalPlanChange({
      subscriptionId: subscription.provider_subscription_id,
      targetPlanId: operation.provider_target_id,
      targetInterval: operation.target_interval,
    })
  } catch (error) {
    if (
      error instanceof PayPalPlanChangeConflictError &&
      error.code === "paypal_revision_not_applied"
    ) {
      return NextResponse.redirect(`${siteUrl}/profile?plan-change=pending#mitgliedschaft`)
    }
    const reconciling = await advancePlanChange(admin, {
      operationId,
      expectedStatus: "pending_approval",
      status: "reconciling",
      failureCode: "paypal_post_approval_verification_failed",
    })
    await mergePendingPlanChangeMetadata(admin, subscription, reconciling)
    await recordPlanChangePhase(admin, reconciling, "approved")
    console.error("[billing:plan-change] PayPal approval requires reconciliation", {
      operationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.redirect(`${siteUrl}/profile?plan-change=reconciling#mitgliedschaft`)
  }

  const scheduled = await advancePlanChange(admin, {
    operationId,
    expectedStatus: "pending_approval",
    status: "scheduled",
  })
  try {
    await mergePendingPlanChangeMetadata(admin, subscription, scheduled)
    await recordPlanChangePhase(admin, scheduled, "approved")
  } catch (error) {
    // Provider approval and the atomic ledger are authoritative. A failure in
    // mirrored metadata or analytics must not tell the buyer the change failed.
    console.error("[billing:plan-change] PayPal scheduled side effects failed", {
      operationId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return NextResponse.redirect(`${siteUrl}/profile?plan-change=scheduled#mitgliedschaft`)
}

async function findSubscription(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
): Promise<BillingSubscriptionRow | null> {
  const { data, error } = await admin
    .from("billing_subscriptions")
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (error) throw error
  return (data as BillingSubscriptionRow | null) ?? null
}
