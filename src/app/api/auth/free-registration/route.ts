import { NextResponse } from "next/server"

import { checkEmailDeliverability } from "@/lib/email-deliverability"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import {
  checkRateLimit,
  FREE_REGISTRATION_ADDRESS_RATE_LIMIT,
  FREE_REGISTRATION_IP_RATE_LIMIT,
  FREE_REGISTRATION_RATE_LIMIT,
} from "@/lib/rate-limit"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  requestFreeRegistrationLink,
  type FreeRegistrationDependencies,
  type FreeRegistrationLead,
  type FreeRegistrationRateDimension,
  type FreeRegistrationResult,
} from "@/lib/auth/free-registration"
import { verifyFreeRegistrationCapability } from "@/lib/auth/free-registration-capability"

export const runtime = "nodejs"

/**
 * Free-registration endpoint (freemium scanner-first, T18): quiz lead ->
 * free Supabase account via an OTP magic link (`shouldCreateUser: true`).
 *
 * This is a NEW contract beside `/api/auth/send-magic-link`, which stays the
 * payment-activation endpoint (`shouldCreateUser: false`) and is not touched.
 * Dark unless `FREEMIUM_SCANNER_FIRST_ENABLED === "true"`: the route 404s
 * exactly like a non-existent path while the flag is off.
 */

const NOT_FOUND_ERROR = "Nicht gefunden"
const INVALID_REQUEST_ERROR = "Bitte starte die Haaranalyse noch einmal."
const LEAD_NOT_FOUND_ERROR = "Wir konnten deine Haaranalyse nicht finden."
const LEAD_CLAIMED_ERROR = "Für diese Haaranalyse gibt es schon ein Konto. Bitte melde dich an."
const CORRECTION_NOT_AUTHORIZED_ERROR =
  "Diese Adresse lässt sich hier nicht mehr ändern. Starte die Haaranalyse noch einmal – dann geht der Link an deine neue Adresse."
const RATE_LIMITED_ERROR = "Zu viele Versuche. Bitte warte ein paar Minuten."
const RATE_LIMIT_UNAVAILABLE_ERROR =
  "Der Link kann gerade nicht gesendet werden. Bitte versuche es gleich noch einmal."
const SEND_ERROR = "Der Link konnte nicht gesendet werden. Bitte versuche es noch einmal."
const SERVER_ERROR = "Das hat gerade nicht geklappt. Bitte versuche es noch einmal."

type RouteResult = { status: number; body: Record<string, unknown> }

export function createFreeRegistrationPostHandler(
  overrides: Partial<FreeRegistrationDependencies> & {
    isEnabled?: () => boolean
  } = {},
) {
  return async function POST(request: Request) {
    const isEnabled = overrides.isEnabled ?? isFreemiumScannerFirstEnabled
    if (!isEnabled()) {
      return NextResponse.json({ error: NOT_FOUND_ERROR }, { status: 404 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return toResponse({
        status: 400,
        body: { code: "invalid_request", error: INVALID_REQUEST_ERROR },
      })
    }

    const payload = isRecord(body) ? body : {}
    try {
      const result = await requestFreeRegistrationLink(
        {
          leadId: payload.leadId,
          email: payload.email,
          capability: payload.capability,
          ipAddress: resolveClientIp(request),
        },
        { ...createDefaultDependencies(), ...overrides },
      )
      return toResponse(toRouteResult(result))
    } catch (error) {
      console.error("[free-registration] failed:", error)
      return toResponse({ status: 500, body: { code: "server_error", error: SERVER_ERROR } })
    }
  }
}

export const POST = createFreeRegistrationPostHandler()

export function toRouteResult(result: FreeRegistrationResult): RouteResult {
  switch (result.outcome) {
    case "sent":
      return {
        status: 200,
        body: { ok: true, email: result.email, corrected: result.corrected },
      }
    case "invalid_request":
      return { status: 400, body: { code: "invalid_request", error: INVALID_REQUEST_ERROR } }
    case "lead_not_found":
      return { status: 404, body: { code: "lead_not_found", error: LEAD_NOT_FOUND_ERROR } }
    case "lead_claimed":
      return { status: 409, body: { code: "lead_claimed", error: LEAD_CLAIMED_ERROR } }
    case "correction_not_authorized":
      return {
        status: 403,
        body: {
          code: "correction_not_authorized",
          error: CORRECTION_NOT_AUTHORIZED_ERROR,
        },
      }
    case "rate_limited":
      return { status: 429, body: { code: "rate_limited", error: RATE_LIMITED_ERROR } }
    case "rate_limit_unavailable":
      return {
        status: 503,
        body: { code: "rate_limit_unavailable", error: RATE_LIMIT_UNAVAILABLE_ERROR },
      }
    case "undeliverable_email":
      return {
        status: 422,
        body: {
          code: "undeliverable_email",
          error:
            "Diese E-Mail-Domain kann keine E-Mails empfangen. Prüfe die Adresse oder verwende eine andere.",
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.suggestion ? { suggestion: result.suggestion } : {}),
        },
      }
    case "send_failed":
      return { status: 502, body: { code: "send_failed", error: SEND_ERROR } }
  }
}

function createDefaultDependencies(): FreeRegistrationDependencies {
  // Lazy: a test that overrides every dependency must never need Supabase
  // service-role env just to construct the handler's default wiring.
  let cached: ReturnType<typeof createAdminClient> | null = null
  const admin = () => (cached ??= createAdminClient())

  return {
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
    checkRateLimit: ({ dimension, identifier }) =>
      checkRateLimit(identifier, RATE_LIMITS_BY_DIMENSION[dimension]),
    verifyCorrectionCapability: (token, leadId) => verifyFreeRegistrationCapability(token, leadId),
    async loadLead(leadId): Promise<FreeRegistrationLead | null> {
      const { data, error } = await admin()
        .from("leads")
        .select("id, email, quiz_kind, user_id")
        .eq("id", leadId)
        .maybeSingle()
      if (error) throw new Error(`Lead lookup failed: ${error.message}`)
      if (!data) return null
      const row = data as {
        id: string
        email: string
        quiz_kind: "legacy" | "personal_plan"
        user_id: string | null
      }
      return {
        id: row.id,
        email: row.email,
        quizKind: row.quiz_kind,
        userId: row.user_id,
      }
    },
    async updateLeadEmail(leadId, email) {
      // Guarded by `user_id IS NULL` in the statement itself so a lead that
      // gets claimed between the read and this write is never re-pointed. The
      // `.select()` is what makes that guard OBSERVABLE: without it a lost race
      // returned `ok: true` and the link went to an address the lead no longer
      // carries, dead-ending the resulting account (finding W5).
      const { data, error } = await admin()
        .from("leads")
        .update({ email })
        .eq("id", leadId)
        .is("user_id", null)
        .select("id")
      if (error) throw new Error(`Lead e-mail update failed: ${error.message}`)
      return { updated: Array.isArray(data) ? data.length > 0 : Boolean(data) }
    },
    async markFreeRegistrationLead(leadId) {
      // The provenance `/auth/confirm` branches on (PR6 review, finding V3).
      // Same guarded-and-observable shape as `updateLeadEmail`: `user_id IS NULL`
      // in the statement, `.select("id")` so a lost race is a conflict rather
      // than a link that goes out into a dead end.
      const { data, error } = await admin()
        .from("leads")
        .update({ free_registration_requested_at: new Date().toISOString() })
        .eq("id", leadId)
        .is("user_id", null)
        .select("id")
      if (error) throw new Error(`Lead free-registration mark failed: ${error.message}`)
      return { marked: Array.isArray(data) ? data.length > 0 : Boolean(data) }
    },
    async checkEmailDeliverability(email) {
      const result = await checkEmailDeliverability(email)
      if (result.ok) return { ok: true, normalized: result.normalized }
      return {
        ok: false,
        reason: result.reason,
        ...(result.suggestion ? { suggestion: result.suggestion } : {}),
      }
    },
    async sendMagicLink({ email, emailRedirectTo }) {
      const { error } = await admin().auth.signInWithOtp({
        email,
        options: { emailRedirectTo, shouldCreateUser: true },
      })
      if (error) {
        console.error("[free-registration] signInWithOtp failed:", error.message)
        return { error }
      }
      return { error: null }
    },
  }
}

const RATE_LIMITS_BY_DIMENSION: Record<
  FreeRegistrationRateDimension,
  typeof FREE_REGISTRATION_RATE_LIMIT
> = {
  lead: FREE_REGISTRATION_RATE_LIMIT,
  ip: FREE_REGISTRATION_IP_RATE_LIMIT,
  address: FREE_REGISTRATION_ADDRESS_RATE_LIMIT,
}

function resolveClientIp(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toResponse(result: RouteResult) {
  return NextResponse.json(result.body, { status: result.status })
}
