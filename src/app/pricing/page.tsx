import { redirect } from "next/navigation"

import { hasCurrentAppAccess } from "@/lib/billing/subscriptions"
import { sanitizeReactivationReturnDestination } from "@/lib/reactivation/return-destination"
import { createClient } from "@/lib/supabase/server"

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ lead?: string; interval?: string; next?: string }>
}) {
  const sp = await searchParams
  const leadId = sp.lead?.trim()

  if (leadId) {
    redirect(`/result/${encodeURIComponent(leadId)}?focus=unlock-plan`)
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/quiz")

  let active: boolean
  try {
    active = await hasCurrentAppAccess(supabase, { userId: user.id, email: user.email })
  } catch (error) {
    console.warn("[pricing] app access check failed", error)
    const params = new URLSearchParams({ reason: "access_check_unavailable" })
    params.set("next", sanitizeReactivationReturnDestination(sp.next))
    redirect(`/reactivate?${params.toString()}`)
  }

  if (active) redirect("/profile#mitgliedschaft")

  const params = new URLSearchParams({ reason: "expired" })
  if (sp.interval === "month" || sp.interval === "quarter" || sp.interval === "year") {
    params.set("interval", sp.interval)
  }
  params.set("next", sanitizeReactivationReturnDestination(sp.next))
  redirect(`/reactivate?${params.toString()}`)
}
