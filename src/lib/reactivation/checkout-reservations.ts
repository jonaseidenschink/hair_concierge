import type { SupabaseClient } from "@supabase/supabase-js"

import type { BillingInterval } from "@/lib/stripe/intervals"

export type MembershipReactivationProvider = "stripe" | "paypal"
export type MembershipReactivationReservationStatus =
  | "open"
  | "provider_selected"
  | "provider_created"
  | "completed"
  | "expired"
  | "reconciliation_required"

export type MembershipReactivationCheckoutReservation = {
  id: string
  user_id: string
  checkout_attempt_id: string
  interval: BillingInterval
  return_destination: string
  provider: MembershipReactivationProvider | null
  provider_reference: string | null
  status: MembershipReactivationReservationStatus
  expires_at: string
  created_at: string
  updated_at: string
}

type ReservationClient = Pick<SupabaseClient, "from" | "rpc">

export class MembershipReactivationCheckoutConflictError extends Error {
  constructor(message = "membership reactivation checkout already in progress") {
    super(message)
    this.name = "MembershipReactivationCheckoutConflictError"
  }
}

export async function acquireMembershipReactivationCheckout(
  supabase: ReservationClient,
  input: {
    userId: string
    checkoutAttemptId: string
    interval: BillingInterval
    returnDestination: string
  },
): Promise<MembershipReactivationCheckoutReservation> {
  const { data, error } = await supabase.rpc("acquire_membership_reactivation_checkout", {
    p_user_id: input.userId,
    p_checkout_attempt_id: input.checkoutAttemptId,
    p_interval: input.interval,
    p_return_destination: input.returnDestination,
  })

  if (error) {
    if (isReservationConflict(error)) throw new MembershipReactivationCheckoutConflictError()
    throw error
  }
  return normalizeReservation(data)
}

export async function claimMembershipReactivationProvider(
  supabase: ReservationClient,
  reservationId: string,
  userId: string,
  provider: MembershipReactivationProvider,
): Promise<MembershipReactivationCheckoutReservation> {
  const { data, error } = await supabase.rpc("claim_membership_reactivation_checkout_provider", {
    p_reservation_id: reservationId,
    p_user_id: userId,
    p_provider: provider,
  })
  if (error) {
    if (isReservationConflict(error)) throw new MembershipReactivationCheckoutConflictError()
    throw error
  }
  return normalizeReservation(data)
}

export async function bindMembershipReactivationProviderReference(
  supabase: ReservationClient,
  reservationId: string,
  providerReference: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("membership_reactivation_checkout_reservations")
    .update({
      provider_reference: providerReference,
      status: "provider_created",
      updated_at: new Date().toISOString(),
    })
    .eq("id", reservationId)
    .is("provider_reference", null)
    .in("status", ["provider_selected", "provider_created", "reconciliation_required"])
    .select("id, provider_reference")
    .maybeSingle()

  if (!error && data) return

  const { data: currentReservation, error: readError } = await supabase
    .from("membership_reactivation_checkout_reservations")
    .select("provider_reference")
    .eq("id", reservationId)
    .maybeSingle()

  if (currentReservation?.provider_reference === providerReference) return

  await markMembershipReactivationReconciliationRequired(supabase, reservationId).catch(() => {})
  if (error) throw error
  if (readError) throw readError
  throw new MembershipReactivationCheckoutConflictError(
    "reactivation checkout provider reference could not be bound",
  )
}

export async function markMembershipReactivationReconciliationRequired(
  supabase: ReservationClient,
  reservationId: string,
): Promise<void> {
  const { error } = await supabase
    .from("membership_reactivation_checkout_reservations")
    .update({ status: "reconciliation_required", updated_at: new Date().toISOString() })
    .eq("id", reservationId)
  if (error) throw error
}

export async function expireMembershipReactivationCheckoutReservation(
  supabase: ReservationClient,
  input: {
    reservationId: string
    userId: string
    providerReference: string
  },
): Promise<void> {
  const { data, error } = await supabase
    .from("membership_reactivation_checkout_reservations")
    .update({ status: "expired", updated_at: new Date().toISOString() })
    .eq("id", input.reservationId)
    .eq("user_id", input.userId)
    .eq("provider_reference", input.providerReference)
    .in("status", ["provider_created", "reconciliation_required"])
    .select("id")
    .maybeSingle()
  if (error) throw error
  if (!data) {
    throw new MembershipReactivationCheckoutConflictError(
      "reactivation checkout reservation could not be expired",
    )
  }
}

export async function markMembershipReactivationCheckoutCompleted(
  supabase: ReservationClient,
  reservationId: string,
  userId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("membership_reactivation_checkout_reservations")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("id", reservationId)
    .eq("user_id", userId)
    .in("status", ["provider_created", "reconciliation_required"])
    .select("id")
    .maybeSingle()
  if (error) throw error
  if (!data) {
    throw new MembershipReactivationCheckoutConflictError(
      "reactivation checkout reservation could not be completed",
    )
  }
}

function isReservationConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as { code?: unknown; message?: unknown }
  const message = typeof candidate.message === "string" ? candidate.message : ""
  return candidate.code === "P0001" || message.includes("reactivation checkout")
}

function normalizeReservation(data: unknown): MembershipReactivationCheckoutReservation {
  const reservation = Array.isArray(data) ? data[0] : data
  if (!reservation || typeof reservation !== "object") {
    throw new Error("reactivation checkout reservation response missing")
  }
  return reservation as MembershipReactivationCheckoutReservation
}
