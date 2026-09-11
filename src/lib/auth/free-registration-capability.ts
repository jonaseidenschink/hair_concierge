import { createHmac, timingSafeEqual } from "node:crypto"

import { isFreeRegistrationLeadId } from "./free-registration"

/**
 * Free-registration CORRECTION capability (T18 fix round 1, review finding W1a).
 *
 * The problem it closes: `requestFreeRegistrationLink`'s correction branch used
 * to authorize a rewrite of `leads.email` on possession of an unclaimed lead id
 * alone — and unclaimed lead ids are published by design (`/result/<leadId>/reveal`
 * is the paid funnel's standing quiz-completion destination, and
 * `/registrierung?lead=<uuid>` accepts one straight from the URL). Possession was
 * therefore a two-click lead-takeover primitive in both directions: redirect a
 * stranger's lead to your own address, or point your own lead at a victim's
 * address so their „login" click overwrites their existing hair profile.
 *
 * The control: at QUIZ COMPLETION — the one moment only the completing browser
 * can observe — `/api/quiz/personal-plan-lead` mints a short-lived signed
 * capability over `{ leadId, iat }` and returns it in its response body. The quiz
 * puts it in the same sessionStorage handoff it already writes, `/registrierung`
 * reads it back, and the correction branch REQUIRES it. Resends to the lead's own
 * address keep bare-leadId auth — they can only ever mail the address the lead
 * already holds, so they are not a takeover primitive.
 *
 * Stateless verification with an expiry: no table, no migration, nothing to clean
 * up. The signature is domain-separated from every other use of the shared
 * `FUNNEL_COOKIE_SIGNING_SECRET` (same idiom as `partner-access/intent.ts`), so no
 * new environment variable is introduced. With the secret UNSET the capability
 * cannot be minted or verified and corrections are refused — fail closed.
 */

export const FREE_REGISTRATION_CAPABILITY_TTL_MS = 60 * 60 * 1000

/** Tolerance for a signer/verifier clock skew across instances. */
const CLOCK_SKEW_MS = 60 * 1000

const DOMAIN = "free-registration-correction:v1"

type CapabilityPayload = { leadId: string; iat: number }

function resolveSecret(raw = process.env.FUNNEL_COOKIE_SIGNING_SECRET): string | null {
  return typeof raw === "string" && raw.length >= 16 ? `${raw}:${DOMAIN}` : null
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url")
}

/**
 * Mints the capability for a freshly saved lead. Returns `null` when the signing
 * secret is not configured — the caller simply omits the field, and the
 * correction path then refuses with its honest German copy.
 */
export function issueFreeRegistrationCapability(
  leadId: string,
  options: { now?: number; secret?: string | undefined } = {},
): string | null {
  const secret = resolveSecret(options.secret)
  if (!secret || !isFreeRegistrationLeadId(leadId)) return null
  const value: CapabilityPayload = { leadId, iat: options.now ?? Date.now() }
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
  return `${payload}.${sign(payload, secret)}`
}

/**
 * True only for a well-formed, correctly signed, unexpired capability minted for
 * exactly this lead. Every other input — missing, malformed, forged, replayed for
 * a different lead, or aged out — is false.
 */
export function verifyFreeRegistrationCapability(
  token: unknown,
  leadId: string,
  options: { now?: number; secret?: string | undefined } = {},
): boolean {
  const secret = resolveSecret(options.secret)
  if (!secret || typeof token !== "string" || !isFreeRegistrationLeadId(leadId)) return false

  const [payload, signature, extra] = token.split(".")
  if (!payload || !signature || extra !== undefined) return false

  const expected = sign(payload, secret)
  if (signature.length !== expected.length) return false
  try {
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false
  } catch {
    return false
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return false
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return false
  const claim = decoded as Record<string, unknown>
  if (claim.leadId !== leadId) return false
  if (typeof claim.iat !== "number" || !Number.isFinite(claim.iat)) return false

  const now = options.now ?? Date.now()
  if (claim.iat > now + CLOCK_SKEW_MS) return false
  return now - claim.iat <= FREE_REGISTRATION_CAPABILITY_TTL_MS
}
