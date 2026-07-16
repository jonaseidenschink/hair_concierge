import { randomBytes } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { BillingInterval } from "@/lib/billing/types"

export type PayPalCheckoutIntentStatus =
  | "created"
  | "approved"
  | "duplicate"
  | "activated"
  | "expired"

export type PayPalCheckoutSource = "pricing_page" | "quiz_result_offer"

export interface PayPalCheckoutIntentRow {
  id: string
  token: string
  interval: BillingInterval
  source: PayPalCheckoutSource
  lead_id: string | null
  email: string | null
  user_id: string | null
  reactivation_reservation_id: string | null
  provider_subscription_id: string | null
  status: PayPalCheckoutIntentStatus
  duplicate_reason: string | null
  expires_at: string
  created_at: string
  updated_at: string
  metadata: Record<string, unknown>
}

export interface CreatePayPalCheckoutIntentInput {
  interval: BillingInterval
  source: PayPalCheckoutSource
  leadId?: string | null
  email?: string | null
  userId?: string | null
  expiresAt?: Date
  metadata?: Record<string, unknown>
}

export interface CreatePayPalReactivationCheckoutIntentInput extends CreatePayPalCheckoutIntentInput {
  reactivationReservationId: string
}

export type PayPalCheckoutIntentClient = Pick<SupabaseClient, "from">

const PAYPAL_CHECKOUT_INTENT_TTL_HOURS = 24

export class PayPalCheckoutIntentBindingError extends Error {
  constructor(
    message: string,
    readonly currentIntent: PayPalCheckoutIntentRow | null,
  ) {
    super(message)
    this.name = "PayPalCheckoutIntentBindingError"
  }
}

export function createPayPalCheckoutIntentToken(): string {
  return randomBytes(24).toString("base64url")
}

export function defaultPayPalCheckoutIntentExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + PAYPAL_CHECKOUT_INTENT_TTL_HOURS * 60 * 60 * 1000)
}

export async function createPayPalCheckoutIntent(
  supabase: PayPalCheckoutIntentClient,
  input: CreatePayPalCheckoutIntentInput,
): Promise<PayPalCheckoutIntentRow> {
  const { data, error } = await supabase
    .from("paypal_checkout_intents")
    .insert({
      token: createPayPalCheckoutIntentToken(),
      interval: input.interval,
      source: input.source,
      lead_id: input.leadId ?? null,
      email: input.email?.toLowerCase() ?? null,
      user_id: input.userId ?? null,
      expires_at: (input.expiresAt ?? defaultPayPalCheckoutIntentExpiresAt()).toISOString(),
      metadata: input.metadata ?? {},
    })
    .select("*")
    .single()

  if (error) throw error
  return data as PayPalCheckoutIntentRow
}

export async function createOrAdoptPayPalReactivationCheckoutIntent(
  supabase: PayPalCheckoutIntentClient,
  input: CreatePayPalReactivationCheckoutIntentInput,
): Promise<PayPalCheckoutIntentRow> {
  const { data, error } = await supabase
    .from("paypal_checkout_intents")
    .insert({
      token: createPayPalCheckoutIntentToken(),
      interval: input.interval,
      source: input.source,
      lead_id: input.leadId ?? null,
      email: input.email?.toLowerCase() ?? null,
      user_id: input.userId ?? null,
      reactivation_reservation_id: input.reactivationReservationId,
      expires_at: (input.expiresAt ?? defaultPayPalCheckoutIntentExpiresAt()).toISOString(),
      metadata: {
        ...(input.metadata ?? {}),
        reactivation_reservation_id: input.reactivationReservationId,
      },
    })
    .select("*")
    .single()

  if (!error) return data as PayPalCheckoutIntentRow
  if (!isUniqueViolation(error)) throw error

  const canonicalIntent = await findPayPalCheckoutIntentByReactivationReservationId(
    supabase,
    input.reactivationReservationId,
  )
  if (canonicalIntent) return canonicalIntent

  throw error
}

export async function findPayPalCheckoutIntentByToken(
  supabase: PayPalCheckoutIntentClient,
  token: string,
): Promise<PayPalCheckoutIntentRow | null> {
  const { data, error } = await supabase
    .from("paypal_checkout_intents")
    .select("*")
    .eq("token", token)
    .maybeSingle()

  if (error) throw error
  return (data as PayPalCheckoutIntentRow | null) ?? null
}

export async function findPayPalCheckoutIntentByProviderSubscriptionId(
  supabase: PayPalCheckoutIntentClient,
  providerSubscriptionId: string,
): Promise<PayPalCheckoutIntentRow | null> {
  const { data, error } = await supabase
    .from("paypal_checkout_intents")
    .select("*")
    .eq("provider_subscription_id", providerSubscriptionId)
    .maybeSingle()

  if (error) throw error
  return (data as PayPalCheckoutIntentRow | null) ?? null
}

export async function findPayPalCheckoutIntentByReactivationReservationId(
  supabase: PayPalCheckoutIntentClient,
  reservationId: string,
): Promise<PayPalCheckoutIntentRow | null> {
  const { data, error } = await supabase
    .from("paypal_checkout_intents")
    .select("*")
    .eq("reactivation_reservation_id", reservationId)
    .maybeSingle()

  if (error) throw error
  return (data as PayPalCheckoutIntentRow | null) ?? null
}

export async function bindPayPalCheckoutIntentToSubscription(
  supabase: PayPalCheckoutIntentClient,
  token: string,
  providerSubscriptionId: string,
  email?: string | null,
): Promise<PayPalCheckoutIntentRow> {
  const { data, error } = await supabase
    .from("paypal_checkout_intents")
    .update({
      provider_subscription_id: providerSubscriptionId,
      email: email?.toLowerCase() ?? null,
      status: "approved",
      updated_at: new Date().toISOString(),
    })
    .eq("token", token)
    .is("provider_subscription_id", null)
    .in("status", ["created", "approved"])
    .select("*")
    .maybeSingle()

  if (error) throw error
  if (data) return data as PayPalCheckoutIntentRow

  const currentIntent = await findPayPalCheckoutIntentByToken(supabase, token)
  if (currentIntent?.provider_subscription_id === providerSubscriptionId) return currentIntent

  throw new PayPalCheckoutIntentBindingError(
    "PayPal checkout intent is already bound to another provider subscription",
    currentIntent,
  )
}

export async function markPayPalCheckoutIntentDuplicate(
  supabase: PayPalCheckoutIntentClient,
  token: string,
  reason: string,
  providerSubscriptionId?: string,
): Promise<void> {
  const { error } = await supabase
    .from("paypal_checkout_intents")
    .update({
      status: "duplicate",
      duplicate_reason: reason,
      ...(providerSubscriptionId ? { provider_subscription_id: providerSubscriptionId } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("token", token)

  if (error) throw error
}

export async function markPayPalCheckoutIntentActivated(
  supabase: PayPalCheckoutIntentClient,
  token: string,
): Promise<void> {
  const { error } = await supabase
    .from("paypal_checkout_intents")
    .update({
      status: "activated",
      updated_at: new Date().toISOString(),
    })
    .eq("token", token)

  if (error) throw error
}

export async function markPayPalCheckoutIntentExpired(
  supabase: PayPalCheckoutIntentClient,
  token: string,
): Promise<void> {
  const { error } = await supabase
    .from("paypal_checkout_intents")
    .update({
      status: "expired",
      updated_at: new Date().toISOString(),
    })
    .eq("token", token)

  if (error) throw error
}

export function isPayPalCheckoutIntentExpired(
  intent: Pick<PayPalCheckoutIntentRow, "expires_at">,
  now: Date = new Date(),
): boolean {
  const expiresAt = Date.parse(intent.expires_at)
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime()
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: unknown }).code === "23505",
  )
}
