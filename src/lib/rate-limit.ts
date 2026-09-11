import { createAdminClient } from "@/lib/supabase/admin"

export interface RateLimitConfig {
  prefix: string
  limit: number
  windowMs: number
}

export function fixedWindowRetryAfterSeconds(config: RateLimitConfig, nowMs = Date.now()): number {
  const remainingMs = config.windowMs - (nowMs % config.windowMs)
  return Math.max(1, Math.ceil(remainingMs / 1000))
}

/**
 * Check rate limit using Supabase RPC (persistent, cross-instance).
 * Fails closed: if the DB call fails, the request is rejected (503).
 */
export async function checkRateLimit(
  identifier: string,
  config: RateLimitConfig,
): Promise<{ allowed: boolean; error?: string }> {
  const supabase = createAdminClient()
  return checkRateLimitWithRpc(identifier, config, (args) => supabase.rpc("check_rate_limit", args))
}

export async function checkRateLimitWithRpc(
  identifier: string,
  config: RateLimitConfig,
  rpc: (args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<{ allowed: boolean; error?: string }> {
  const key = `${config.prefix}:${identifier.trim().toLowerCase()}`
  const { data, error } = await rpc({
    p_key: key,
    p_limit: config.limit,
    p_window_ms: config.windowMs,
  })

  if (error) {
    console.error("Rate limit check failed:", error)
    return { allowed: false, error: "service_unavailable" }
  }

  return { allowed: data as boolean }
}

export const CHAT_RATE_LIMIT: RateLimitConfig = {
  prefix: "chat",
  limit: 30,
  windowMs: 60_000,
}

export const QUIZ_LEAD_RATE_LIMIT: RateLimitConfig = {
  prefix: "quiz-lead",
  limit: 20,
  windowMs: 3_600_000,
}

export const PERSONAL_PLAN_PREPARE_JOURNEY_RATE_LIMIT: RateLimitConfig = {
  // Normal preparation uses one request plus at most one bounded recovery.
  prefix: "personal-plan-prepare-journey",
  limit: 10,
  windowMs: 10_000,
}

export const PERSONAL_PLAN_PREPARE_IP_RATE_LIMIT: RateLimitConfig = {
  // High-headroom emergency cost ceiling; verified journeys use the tighter bucket above.
  prefix: "personal-plan-prepare-ip",
  limit: 100,
  windowMs: 10_000,
}

/**
 * Eigener Topf fuer die Zustellbarkeits-Vorabpruefung: Sie loest einen
 * ausgehenden DNS-Lookup aus, darf aber niemals das Lead-Budget eines echten
 * Nutzers aufbrauchen. Grosszuegig bemessen, weil der Client bei 429 ohnehin
 * durchlaesst und der Lead-Endpunkt erneut prueft.
 */
export const QUIZ_EMAIL_PRECHECK_RATE_LIMIT: RateLimitConfig = {
  prefix: "quiz-email-precheck",
  limit: 60,
  windowMs: 60_000,
}

export const FUNNEL_EVENT_RATE_LIMIT: RateLimitConfig = {
  prefix: "funnel-event",
  limit: 60,
  windowMs: 60_000,
}

export const PERSONAL_PLAN_QUIZ_DRAFT_IP_RATE_LIMIT: RateLimitConfig = {
  prefix: "personal-plan-quiz-draft-ip",
  limit: 120,
  windowMs: 60_000,
}

export const PERSONAL_PLAN_QUIZ_DRAFT_WRITE_RATE_LIMIT: RateLimitConfig = {
  prefix: "personal-plan-quiz-draft-write",
  limit: 120,
  windowMs: 60_000,
}

export const PERSONAL_PLAN_QUIZ_DRAFT_RESUME_IP_RATE_LIMIT: RateLimitConfig = {
  prefix: "personal-plan-quiz-draft-resume-ip",
  limit: 30,
  windowMs: 60_000,
}

export const PERSONAL_PLAN_QUIZ_DRAFT_CREDENTIAL_RATE_LIMIT: RateLimitConfig = {
  prefix: "personal-plan-quiz-draft-credential",
  limit: 12,
  windowMs: 60_000,
}

// 3 sends per 5 minutes per Stripe session_id (conservative — most users send 1)
export const SEND_AUTH_LINK_RATE_LIMIT: RateLimitConfig = {
  prefix: "send-auth-link",
  limit: 3,
  windowMs: 5 * 60_000,
}

// Free-registration magic link (freemium scanner-first T18): 4 sends per 10
// minutes per quiz lead — one initial send plus room for a resend and one
// e-mail correction without the user ever hitting the wall in a normal run.
export const FREE_REGISTRATION_RATE_LIMIT: RateLimitConfig = {
  prefix: "free-registration",
  limit: 4,
  windowMs: 10 * 60_000,
}

// T18 fix round 1 (review finding W4): the per-lead bucket bounds nothing on its
// own — completing the quiz is free and scriptable, so a caller mints as many
// lead ids (and therefore as many budgets) as it likes. These two dimensions
// bound the two things that actually cost: outbound mail per caller, and mail
// per destination inbox. Both are sized well above a real user's worst run
// (one person, one address, at most a handful of resends).
export const FREE_REGISTRATION_IP_RATE_LIMIT: RateLimitConfig = {
  prefix: "free-registration-ip",
  limit: 20,
  windowMs: 10 * 60_000,
}

export const FREE_REGISTRATION_ADDRESS_RATE_LIMIT: RateLimitConfig = {
  prefix: "free-registration-address",
  limit: 5,
  windowMs: 60 * 60_000,
}

// 8 password attempts per 10 minutes per Stripe checkout session_id.
export const SET_CHECKOUT_PASSWORD_RATE_LIMIT: RateLimitConfig = {
  prefix: "set-checkout-password",
  limit: 8,
  windowMs: 10 * 60_000,
}

export const PAYMENT_SUPPORT_IP_RATE_LIMIT: RateLimitConfig = {
  prefix: "payment-support-ip",
  limit: 5,
  windowMs: 10 * 60_000,
}

// Shared budget across every user-facing scan route (resolve, search, submit, save,
// wishlist) — one bucket per user, not per route.
export const SCAN_RATE_LIMIT: RateLimitConfig = {
  prefix: "scan",
  limit: 30,
  windowMs: 60_000,
}
