import { redirect } from "next/navigation"

import { MembershipReactivationPage } from "@/components/reactivation/membership-reactivation-page"
import { hasCurrentAppAccess } from "@/lib/billing/subscriptions"
import { buildQuizOfferPreview } from "@/lib/quiz/offer-preview"
import { buildQuizAnswersFromHairProfile } from "@/lib/reactivation/profile-quiz-answers"
import { sanitizeReactivationReturnDestination } from "@/lib/reactivation/return-destination"
import type { BillingInterval } from "@/lib/stripe/intervals"
import { DEFAULT_PRICING_INTERVAL } from "@/lib/stripe/pricing-plans"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

export default async function ReactivatePage({
  searchParams,
}: {
  searchParams: Promise<{ interval?: string; next?: string }>
}) {
  const params = await searchParams
  const returnDestination = sanitizeReactivationReturnDestination(params.next)
  const initialInterval = parseInterval(params.interval)
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    const authParams = new URLSearchParams({
      next: `/reactivate?next=${encodeURIComponent(returnDestination)}`,
    })
    redirect(`/auth?${authParams.toString()}`)
  }

  let accessState: "active" | "expired" | "uncertain"
  try {
    accessState = (await hasCurrentAppAccess(supabase, {
      userId: user.id,
      email: user.email,
    }))
      ? "active"
      : "expired"
  } catch (error) {
    console.warn("[reactivate] app access check failed", error)
    accessState = "uncertain"
  }

  if (accessState === "active") redirect(returnDestination)

  const [{ data: profile, error: profileError }, { data: hairProfile, error: hairProfileError }] =
    await Promise.all([
      supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
      supabase
        .from("hair_profiles")
        .select(
          "hair_texture, thickness, density, hair_length, cuticle_condition, protein_moisture_balance, scalp_type, scalp_condition, chemical_treatment, concerns, goals",
        )
        .eq("user_id", user.id)
        .maybeSingle(),
    ])

  if (profileError) console.warn("[reactivate] profile preview name unavailable", profileError)
  if (hairProfileError)
    console.warn("[reactivate] saved hair profile unavailable", hairProfileError)

  const routinePreview = buildQuizOfferPreview(buildQuizAnswersFromHairProfile(hairProfile))
  const fullName = typeof profile?.full_name === "string" ? profile.full_name.trim() : ""
  const firstName = fullName ? fullName.split(/\s+/)[0] : null

  return (
    <MembershipReactivationPage
      firstName={firstName}
      initialInterval={initialInterval}
      returnDestination={returnDestination}
      routinePreview={routinePreview}
      showCheckout={accessState === "expired"}
    />
  )
}

function parseInterval(value: string | undefined): BillingInterval {
  return value === "month" || value === "quarter" || value === "year"
    ? value
    : DEFAULT_PRICING_INTERVAL
}
