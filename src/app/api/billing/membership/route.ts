import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  findCurrentManualAccessGrant,
  findVisibleBillingSubscriptionForUser,
  hasCurrentLegacyProfileAccess,
} from "@/lib/billing/subscriptions"
import { buildMembershipManagementState, findOpenPlanChange } from "@/lib/billing/plan-change"
import { reconcileStalePayPalPlanChanges } from "@/lib/paypal/stale-plan-change"

export const runtime = "nodejs"

export async function GET() {
  const cookieStore = await cookies()
  const auth = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } },
  )
  const {
    data: { user },
  } = await auth.auth.getUser()
  if (!user) return NextResponse.json({ state: { kind: "uncertain" } }, { status: 401 })

  try {
    const admin = createAdminClient()
    const subscription = await findVisibleBillingSubscriptionForUser(admin, user.id)
    if (subscription) {
      await reconcileStalePayPalPlanChanges(admin, subscription)
      const operation = await findOpenPlanChange(admin, subscription.id)
      return NextResponse.json({
        state: buildMembershipManagementState({ subscription, operation }),
      })
    }

    const manualGrant = await findCurrentManualAccessGrant(
      admin,
      { userId: user.id, email: user.email },
      new Date(),
    )
    if (manualGrant) {
      return NextResponse.json({
        state: buildMembershipManagementState({
          subscription: null,
          manualGrantEnd: manualGrant.expires_at,
        }),
      })
    }

    const { data: profile, error } = await admin
      .from("profiles")
      .select("subscription_status,current_period_end")
      .eq("id", user.id)
      .maybeSingle()
    if (error) throw error
    if (profile && hasCurrentLegacyProfileAccess(profile)) {
      return NextResponse.json({
        state: buildMembershipManagementState({
          subscription: null,
          legacyAccessEnd: profile.current_period_end ?? null,
        }),
      })
    }
    return NextResponse.json({ state: { kind: "uncertain" } }, { status: 503 })
  } catch (error) {
    console.error("[billing:membership] read failed", {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ state: { kind: "uncertain" } }, { status: 503 })
  }
}
