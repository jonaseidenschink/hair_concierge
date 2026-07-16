import type { SupabaseClient } from "@supabase/supabase-js"
import { assertCanStartCheckout, assertCanStartCheckoutForEmail } from "@/lib/billing/subscriptions"
import {
  markPayPalCheckoutIntentDuplicate,
  type PayPalCheckoutIntentRow,
} from "@/lib/paypal/checkout-intents"
import type { PayPalSubscription } from "@/lib/paypal/subscription-shapes"

export const PAYPAL_DUPLICATE_CHECKOUT_COPY =
  "Für diese E-Mail gibt es bereits ein aktives Abo. Wir haben die neue PayPal-Zahlung gestoppt. Bitte melde dich mit deinem bestehenden Konto an."

export function buildPayPalDuplicateCheckoutBody(
  intent: Pick<PayPalCheckoutIntentRow, "email" | "lead_id">,
): {
  error: "checkout_access_already_exists"
  email?: string
  message: typeof PAYPAL_DUPLICATE_CHECKOUT_COPY
} {
  return {
    error: "checkout_access_already_exists",
    ...(canExposePayPalDuplicateEmail(intent) ? { email: intent.email } : {}),
    message: PAYPAL_DUPLICATE_CHECKOUT_COPY,
  }
}

export class PayPalDuplicateCancellationError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = "PayPalDuplicateCancellationError"
  }
}

type DuplicateReason = "user_already_has_access" | "intent_email_already_has_access"

type CancelPayPalSubscription = (subscriptionId: string, reason: string) => Promise<void>
type RetrievePayPalSubscription = (
  subscriptionId: string,
) => Promise<Pick<PayPalSubscription, "status">>

export async function findPayPalCheckoutDuplicateReason(
  supabase: Pick<SupabaseClient, "from">,
  intent: Pick<PayPalCheckoutIntentRow, "user_id" | "email">,
  subscription: PayPalSubscription,
  options: { fallbackAccountEmail?: string | null } = {},
): Promise<DuplicateReason | null> {
  if (intent.user_id && (await hasCurrentAccessForUser(supabase, intent.user_id))) {
    return "user_already_has_access"
  }

  const intentEmail = normalizeEmail(intent.email)
  if (intentEmail && (await hasCurrentAccessForEmail(supabase, intentEmail))) {
    return "intent_email_already_has_access"
  }

  const fallbackAccountEmail = normalizeEmail(options.fallbackAccountEmail)
  const paypalEmail = normalizeEmail(subscription.subscriber?.email_address)
  if (
    !intentEmail &&
    fallbackAccountEmail &&
    fallbackAccountEmail === paypalEmail &&
    (await hasCurrentAccessForEmail(supabase, fallbackAccountEmail))
  ) {
    return "intent_email_already_has_access"
  }

  return null
}

export async function cancelAndMarkPayPalDuplicate({
  cancelPayPalSubscription,
  reason,
  retrievePayPalSubscription = retrievePayPalSubscriptionAfterCancelFailure,
  subscriptionId,
  supabase,
  token,
}: {
  cancelPayPalSubscription: CancelPayPalSubscription
  reason: string
  retrievePayPalSubscription?: RetrievePayPalSubscription
  subscriptionId: string
  supabase: Pick<SupabaseClient, "from">
  token: string
}) {
  try {
    await cancelPayPalSubscription(
      subscriptionId,
      "Duplicate active Chaarlie subscription detected before activation",
    )
  } catch (error) {
    const terminal = isAlreadyInactivePayPalSubscriptionError(error)
      ? await isTerminalPayPalSubscription(retrievePayPalSubscription, subscriptionId)
      : false
    if (!terminal) {
      throw new PayPalDuplicateCancellationError(
        "PayPal duplicate subscription could not be cancelled",
        error,
      )
    }
  }

  await markPayPalCheckoutIntentDuplicate(supabase, token, reason, subscriptionId)
}

async function hasCurrentAccessForUser(
  supabase: Pick<SupabaseClient, "from">,
  userId: string,
): Promise<boolean> {
  try {
    await assertCanStartCheckout(supabase, userId)
    return false
  } catch (error) {
    if (isAlreadyHasAccessError(error)) return true
    throw error
  }
}

async function hasCurrentAccessForEmail(
  supabase: Pick<SupabaseClient, "from">,
  email: string,
): Promise<boolean> {
  try {
    await assertCanStartCheckoutForEmail(supabase, email)
    return false
  } catch (error) {
    if (isAlreadyHasAccessError(error)) return true
    throw error
  }
}

function isAlreadyHasAccessError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("already has access")
}

function isAlreadyInactivePayPalSubscriptionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const text = error.message.toLowerCase()
  return (
    text.includes("subscription_status_invalid") ||
    text.includes("already cancelled") ||
    text.includes("already canceled") ||
    text.includes("not active")
  )
}

async function isTerminalPayPalSubscription(
  retrievePayPalSubscription: RetrievePayPalSubscription,
  subscriptionId: string,
): Promise<boolean> {
  try {
    const subscription = await retrievePayPalSubscription(subscriptionId)
    return isTerminalPayPalStatus(subscription.status)
  } catch {
    return false
  }
}

function isTerminalPayPalStatus(status: string | null | undefined): boolean {
  const normalized = status?.trim().toUpperCase()
  return normalized === "CANCELLED" || normalized === "CANCELED" || normalized === "EXPIRED"
}

function canExposePayPalDuplicateEmail(
  intent: Pick<PayPalCheckoutIntentRow, "email" | "lead_id">,
): intent is Pick<PayPalCheckoutIntentRow, "email" | "lead_id"> & { email: string } {
  return Boolean(intent.email && !intent.lead_id)
}

async function retrievePayPalSubscriptionAfterCancelFailure(subscriptionId: string) {
  const { retrievePayPalSubscription } = await import("@/lib/paypal/subscriptions")
  return retrievePayPalSubscription(subscriptionId)
}

function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase()
  return normalized || null
}
