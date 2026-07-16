import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  advancePlanChange,
  clearPendingPlanChangeMetadata,
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
    const callback = `/api/billing/change-plan/paypal/cancel?operationId=${encodeURIComponent(operationId)}`
    return NextResponse.redirect(`${siteUrl}/auth?next=${encodeURIComponent(callback)}`)
  }

  const admin = createAdminClient()
  const operation = await findPlanChangeByOperationId(admin, operationId, user.id)
  if (operation?.provider === "paypal" && operation.status === "pending_approval") {
    const { data: subscriptionData, error: subscriptionError } = await admin
      .from("billing_subscriptions")
      .select("*")
      .eq("id", operation.billing_subscription_id)
      .maybeSingle()
    if (subscriptionError) throw subscriptionError
    const subscription = (subscriptionData as BillingSubscriptionRow | null) ?? null
    if (!subscription || !operation.provider_target_id) {
      await advancePlanChange(admin, {
        operationId,
        expectedStatus: "pending_approval",
        status: "reconciling",
        failureCode: "paypal_cancel_verification_unavailable",
      })
      return NextResponse.redirect(`${siteUrl}/profile?plan-change=reconciling#mitgliedschaft`)
    }

    try {
      await verifyApprovedPayPalPlanChange({
        subscriptionId: subscription.provider_subscription_id,
        targetPlanId: operation.provider_target_id,
        targetInterval: operation.target_interval,
      })
      const scheduled = await advancePlanChange(admin, {
        operationId,
        expectedStatus: "pending_approval",
        status: "scheduled",
      })
      await mergePendingPlanChangeMetadata(admin, subscription, scheduled).catch(() => undefined)
      await recordPlanChangePhase(admin, scheduled, "approved").catch(() => undefined)
      return NextResponse.redirect(`${siteUrl}/profile?plan-change=scheduled#mitgliedschaft`)
    } catch (error) {
      const definitelyNotApplied =
        error instanceof PayPalPlanChangeConflictError &&
        error.code === "paypal_revision_not_applied"
      if (!definitelyNotApplied) {
        const reconciling = await advancePlanChange(admin, {
          operationId,
          expectedStatus: "pending_approval",
          status: "reconciling",
          failureCode: "paypal_cancel_verification_ambiguous",
        })
        await mergePendingPlanChangeMetadata(admin, subscription, reconciling).catch(
          () => undefined,
        )
        return NextResponse.redirect(`${siteUrl}/profile?plan-change=reconciling#mitgliedschaft`)
      }
    }

    const failed = await advancePlanChange(admin, {
      operationId,
      expectedStatus: "pending_approval",
      status: "failed",
      failureCode: "buyer_cancelled_approval",
    })
    await recordPlanChangePhase(admin, failed, "failed")
    try {
      await clearPendingPlanChangeMetadata(admin, subscription)
    } catch (error) {
      // The failed ledger row closes the change. Stale mirrored metadata can be
      // reconciled later and should not strand the buyer on a callback error.
      console.error("[billing:plan-change] PayPal cancel cleanup failed", {
        operationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return NextResponse.redirect(`${siteUrl}/profile?plan-change=cancelled#mitgliedschaft`)
}
