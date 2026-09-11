import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import { isFreeRegistrationLeadId } from "@/lib/auth/free-registration"

import { FreeRegistrationClient } from "./free-registration-client"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

/**
 * Free-registration screen (freemium scanner-first, T18). Reached right after
 * the quiz saved its lead, and again from `/auth/confirm` when a
 * free-registration link has expired. Dark while the flag is off — the whole
 * route 404s, so the current funnel is untouched.
 */
export default async function FreeRegistrationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if (!isFreemiumScannerFirstEnabled()) notFound()

  const params = await searchParams
  const rawLead = params.lead
  const leadParam = typeof rawLead === "string" ? rawLead : null
  const rawError = params.error
  const expired = (typeof rawError === "string" ? rawError : null) === "link_expired"

  return (
    <FreeRegistrationClient
      leadIdFromUrl={isFreeRegistrationLeadId(leadParam) ? leadParam : null}
      expired={expired}
    />
  )
}
