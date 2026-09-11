import { createClient } from "@/lib/supabase/server"
import { linkQuizToProfile, type LinkQuizToProfileOptions } from "@/lib/quiz/link-to-profile"
import { loadPersonalPlanJourneyAccessForUser } from "@/lib/personal-plan/journey-access-loader"
import type { PersonalPlanJourneyAccess } from "@/lib/personal-plan/journey-access"
import { NextResponse } from "next/server"
import type { EmailOtpType } from "@supabase/supabase-js"
import { isModeratorReturnPath } from "@/lib/auth/moderator-return"
import { isPartnerAccessReturnPath } from "@/lib/auth/partner-access-return"
import {
  buildFreeRegistrationBindSkippedLandingPath,
  buildFreeRegistrationRecoveryPath,
  FREE_REGISTRATION_LANDING_PATH,
  isFreeRegistrationLeadId,
  resolveFreeRegistrationBind,
  resolveFreeRegistrationConfirmContext,
  type FreeRegistrationBindEvidence,
} from "@/lib/auth/free-registration"
import { loadFreeRegistrationBindEvidence } from "@/lib/auth/free-registration-bind-evidence"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import { provisionFreeInitialSnapshotForUser } from "@/lib/personal-plan/persistence/free-snapshot-supabase"
import type { ProvisionFreeInitialSnapshotResult } from "@/lib/personal-plan/persistence/free-snapshot-service"
import { reportFreeProvisioningOutcome } from "@/lib/observability/free-registration"

type AuthConfirmUser = { id: string; email?: string }

type AuthConfirmClient = {
  auth: {
    exchangeCodeForSession: (code: string) => Promise<{ error: unknown }>
    verifyOtp: (input: { type: EmailOtpType; token_hash: string }) => Promise<{ error: unknown }>
    getUser: () => Promise<{ data: { user: AuthConfirmUser | null } }>
  }
}

type AuthResult = Promise<{ error: unknown | null }>

export interface AuthConfirmDeps {
  exchangeCodeForSession: (code: string) => AuthResult
  verifyOtp: (params: { type: EmailOtpType; token_hash: string }) => AuthResult
  getUser: () => Promise<{ data: { user: AuthConfirmUser | null } }>
  linkQuizToProfile: (
    userId: string,
    email?: string,
    leadId?: string,
    options?: LinkQuizToProfileOptions,
  ) => Promise<void>
  loadJourneyAccess?: (userId: string) => Promise<PersonalPlanJourneyAccess>
  redirect: (url: string) => Response
  /**
   * Freemium scanner-first (T18). With the flag OFF nothing below is consulted
   * at all, so every pre-existing confirm path is byte-identical. With it ON,
   * `loadFreeBindEvidence` runs for any confirm that names a lead — that read is
   * what establishes the lead's provenance (PR6 review, V3) — while
   * `provisionFreeSnapshot` still runs only for a genuine free registration.
   */
  freemiumScannerFirstEnabled?: () => boolean
  provisionFreeSnapshot?: (input: {
    userId: string
    email?: string
  }) => Promise<ProvisionFreeInitialSnapshotResult>
  /** T18 fix round 1 (W1b) + PR6 V3: bind containment and lead provenance. */
  loadFreeBindEvidence?: (input: {
    userId: string
    leadId: string
  }) => Promise<FreeRegistrationBindEvidence>
  /** T18 fix round 1 (W2): every non-success provisioning outcome is reported. */
  reportFreeProvisioning?: typeof reportFreeProvisioningOutcome
}

export type AuthConfirmRouteDeps = {
  createClient: () => Promise<AuthConfirmClient>
  linkQuizToProfile: (
    userId: string,
    email?: string,
    leadId?: string,
    options?: LinkQuizToProfileOptions,
  ) => Promise<unknown>
  loadJourneyAccess: (userId: string) => Promise<PersonalPlanJourneyAccess>
  freemiumScannerFirstEnabled?: () => boolean
  provisionFreeSnapshot?: (input: {
    userId: string
    email?: string
  }) => Promise<ProvisionFreeInitialSnapshotResult>
  loadFreeBindEvidence?: (input: {
    userId: string
    leadId: string
  }) => Promise<FreeRegistrationBindEvidence>
  reportFreeProvisioning?: typeof reportFreeProvisioningOutcome
}

const defaultDeps: AuthConfirmRouteDeps = {
  createClient: async () => (await createClient()) as unknown as AuthConfirmClient,
  linkQuizToProfile,
  loadJourneyAccess: loadPersonalPlanJourneyAccessForUser,
  freemiumScannerFirstEnabled: isFreemiumScannerFirstEnabled,
  provisionFreeSnapshot: provisionFreeInitialSnapshotForUser,
  loadFreeBindEvidence: loadFreeRegistrationBindEvidence,
  reportFreeProvisioning: reportFreeProvisioningOutcome,
}

const AUTH_ONLY_QUERY_PARAMETERS = new Set([
  "code",
  "error",
  "reason",
  "token",
  "token_hash",
  "type",
])

function sanitizeAuthIntendedPath(rawNext: string | null, origin: string): string | null {
  if (!rawNext) return null
  if (rawNext.startsWith("//") || rawNext.includes("\\") || rawNext.toLowerCase().includes("%5c")) {
    return null
  }

  try {
    const redirectUrl = rawNext.startsWith("/") ? new URL(rawNext, origin) : new URL(rawNext)
    if (redirectUrl.origin !== origin) return null
    if (
      redirectUrl.pathname === "/auth/confirm" ||
      redirectUrl.pathname.startsWith("/auth/confirm/")
    ) {
      return null
    }

    for (const key of [...redirectUrl.searchParams.keys()]) {
      if (AUTH_ONLY_QUERY_PARAMETERS.has(key.toLowerCase())) {
        redirectUrl.searchParams.delete(key)
      }
    }
    const sanitizedDestination = `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`
    if (
      /(?:access|refresh)?_?token|token_hash|code|error/i.test(redirectUrl.hash) &&
      !isPartnerAccessReturnPath(sanitizedDestination)
    ) {
      redirectUrl.hash = ""
    }

    return `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`
  } catch {
    return null
  }
}

export function sanitizeAuthRedirectPath(rawNext: string | null) {
  return sanitizeAuthIntendedPath(rawNext, "https://auth-redirect.invalid") ?? "/chat"
}

export function resolveAuthIntendedRedirectPath(
  searchParams: URLSearchParams,
  origin: string,
): string | null {
  const next = searchParams.get("next")
  if (next) return sanitizeAuthIntendedPath(next, origin)

  const redirectTo = searchParams.get("redirect_to")
  if (!redirectTo) return null

  try {
    const redirectUrl = new URL(redirectTo, origin)
    if (redirectUrl.origin !== origin) return null
    if (redirectUrl.pathname === "/auth/confirm") {
      return sanitizeAuthIntendedPath(redirectUrl.searchParams.get("next"), origin)
    }
    return sanitizeAuthIntendedPath(
      `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`,
      origin,
    )
  } catch {
    return null
  }
}

export function resolveAuthRedirectPath(searchParams: URLSearchParams, origin: string) {
  return resolveAuthIntendedRedirectPath(searchParams, origin) ?? "/chat"
}

function resolveJourneyFrontier(access: PersonalPlanJourneyAccess): string | null {
  return access.kind === "personal_plan" || access.kind === "personal_plan_start"
    ? access.nextHref
    : null
}

async function handleAuthConfirmGet(request: Request, deps: AuthConfirmRouteDeps) {
  const supabase = await deps.createClient()
  return handleAuthConfirm(request, {
    exchangeCodeForSession: (code) => supabase.auth.exchangeCodeForSession(code),
    verifyOtp: (params) => supabase.auth.verifyOtp(params),
    getUser: () => supabase.auth.getUser(),
    linkQuizToProfile: async (userId, email, leadId, options) => {
      await deps.linkQuizToProfile(userId, email, leadId, options)
    },
    loadJourneyAccess: deps.loadJourneyAccess,
    redirect: (url) => NextResponse.redirect(url),
    ...(deps.freemiumScannerFirstEnabled
      ? { freemiumScannerFirstEnabled: deps.freemiumScannerFirstEnabled }
      : {}),
    ...(deps.provisionFreeSnapshot ? { provisionFreeSnapshot: deps.provisionFreeSnapshot } : {}),
    ...(deps.loadFreeBindEvidence ? { loadFreeBindEvidence: deps.loadFreeBindEvidence } : {}),
    ...(deps.reportFreeProvisioning ? { reportFreeProvisioning: deps.reportFreeProvisioning } : {}),
  })
}

function isPersonalPlanReplayDestination(next: string, origin: string) {
  const destination = new URL(next, origin)
  return destination.pathname === "/plan-bereit" || destination.pathname === "/plan-start"
}

function buildExpiredLinkDestination(origin: string, next: string, isRecovery: boolean) {
  const destination = new URL("/auth", origin)
  destination.searchParams.set("error", "link_expired")
  if (isRecovery) {
    destination.searchParams.set("force", "login")
    const recoveryNext = new URL("/auth/update-password", origin)
    if (isModeratorReturnPath(next)) recoveryNext.searchParams.set("next", next)
    destination.searchParams.set("next", `${recoveryNext.pathname}${recoveryNext.search}`)
  } else {
    destination.searchParams.set("next", next)
  }
  return destination.toString()
}

export async function handleAuthConfirm(request: Request, deps: AuthConfirmDeps) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get("code")
  const tokenHash = searchParams.get("token_hash")
  const type = searchParams.get("type") as EmailOtpType | null
  const leadId = searchParams.get("lead") ?? undefined
  const intendedNext = resolveAuthIntendedRedirectPath(searchParams, origin)
  const next = resolveAuthRedirectPath(searchParams, origin)
  const isRecovery = type === "recovery" || next === "/auth/update-password"
  // Freemium scanner-first (T18): a link minted by `/api/auth/free-registration`.
  // Everything below is inert for every other confirm request.
  //
  // Fix round 1 (review finding W3): `?free=1` is caller-supplied, so the marker
  // alone is not evidence of origin — appended to a payment-activation link it
  // used to run the free branch, whose write pins
  // `enrollment_purchase_source_id = null` PERMANENTLY and breaks that user's
  // paid plan forever. The branch therefore requires the exact shape only
  // `buildFreeRegistrationEmailRedirect` produces: `free=1`, a UUID `lead` and
  // the `/scan` landing. A payment token with `?free=1` bolted on carries none.
  //
  // PR6 review, finding V2: that shape is read through
  // `resolveFreeRegistrationConfirmContext`, because the REAL e-mail nests this
  // contract's callback one layer down (`?next=` for signup, `?redirect_to=` for
  // magic link — `supabase/functions/send-email/message-builder.ts`). Reading the
  // outer query alone worked only for hand-built links.
  const freeContext = resolveFreeRegistrationConfirmContext(searchParams, origin)
  const freemiumEnabled = deps.freemiumScannerFirstEnabled?.() ?? false
  const isFreeRegistration = !isRecovery && freeContext !== null && freemiumEnabled
  const freeLeadId = freeContext?.leadId
  let verified = false
  let verificationAttempted = false

  // PKCE flow: Supabase SSR sends a `code` param instead of `token_hash`
  if (code) {
    verificationAttempted = true
    const { error } = await deps.exchangeCodeForSession(code)
    if (!error) verified = true
  }

  // OTP flow: magic-link / email-otp sends `token_hash` + `type`
  if (!verified && tokenHash && type) {
    verificationAttempted = true
    const { error } = await deps.verifyOtp({ type, token_hash: tokenHash })
    if (!error) verified = true
  }

  const {
    data: { user },
  } = await deps.getUser()

  if (verified) {
    // A real free-registration e-mail carries the lead one layer down, so the
    // outer `?lead=` is absent (finding V2) — the free branch links the lead the
    // resolved context names. Every other path keeps the outer parameter.
    const linkLeadId = isFreeRegistration ? freeLeadId : leadId
    // Whatever this request CLAIMS to be, this is the lead it can reach.
    const candidateLeadId = freeLeadId ?? (isFreeRegistrationLeadId(leadId) ? leadId : undefined)

    // T18 fix round 1 (review finding W1b): the free branch must not adopt a
    // lead into an account that already has its own hair profile — see
    // `resolveFreeRegistrationBind`. Resolved BEFORE `linkQuizToProfile`,
    // because that is the call whose existing-row branch would overwrite it.
    //
    // PR6 review, finding V3: the same read now also answers "is this a
    // free-registration lead at all?", from the LEAD ROW, and it runs for every
    // confirm that can reach a lead while the flag is on — not only for one that
    // still carries `free=1`. Stripping the marker or repointing `next` used to
    // skip this containment entirely while `linkQuizToProfile` went on to
    // overwrite an established profile.
    let leadIsFreeRegistration = false
    let evidenceUnavailable = false
    let freeBind: "bind" | "skip" = "bind"
    if (freemiumEnabled && user && candidateLeadId) {
      try {
        const evidence = deps.loadFreeBindEvidence
          ? await deps.loadFreeBindEvidence({ userId: user.id, leadId: candidateLeadId })
          : null
        if (!evidence) evidenceUnavailable = true
        else {
          leadIsFreeRegistration = evidence.leadIsFreeRegistration
          if (leadIsFreeRegistration) freeBind = resolveFreeRegistrationBind(evidence)
        }
      } catch (e) {
        console.error("free-registration bind evidence unavailable:", e)
        evidenceUnavailable = true
      }
    }

    // The free branch needs BOTH halves: the shape only `/api/auth/free-registration`
    // mints, AND a lead that endpoint actually marked. Parameters alone decide
    // nothing any more — which closes the payment-token-plus-crafted-params
    // direction as well as the stripped-marker one.
    const freeBranchActive = isFreeRegistration && leadIsFreeRegistration && !evidenceUnavailable
    // Fail closed for a free-SHAPED request whose evidence could not be read
    // (unchanged from fix round 1). For any other request the read failing is
    // left to behave exactly as before this change, so a Supabase blip cannot
    // silently stop linking quiz answers into a paying customer's profile.
    const suppressLinking =
      (isFreeRegistration && (evidenceUnavailable || freeBind === "skip")) ||
      (leadIsFreeRegistration && freeBind === "skip")

    if (
      user &&
      !suppressLinking &&
      !isModeratorReturnPath(next) &&
      !isPartnerAccessReturnPath(next)
    ) {
      try {
        await deps.linkQuizToProfile(
          user.id,
          user.email,
          linkLeadId,
          // V4: a free-provenance lead never overwrites an existing profile,
          // however this confirm was addressed. Paid/legacy linking passes no
          // options and keeps its current create-or-update behaviour.
          leadIsFreeRegistration ? { profileWrite: "create_only" } : undefined,
        )
      } catch (e) {
        console.error("linkQuizToProfile failed:", e)
      }
    }

    if (isRecovery) {
      const recoveryUrl = new URL("/auth/update-password", origin)
      if (isModeratorReturnPath(next)) recoveryUrl.searchParams.set("next", next)
      return deps.redirect(recoveryUrl.toString())
    }

    // The free account's scanner prerequisite: derive the initial need snapshot
    // from the quiz artifact just linked above, with the AUTH e-mail supplied
    // (T6 carry-forward — the paid-access guard needs it). Failures never block
    // the landing — but they are no longer silent, and the recovery the old
    // comment promised is now real: `/scan` retries provisioning for a free
    // account that has no snapshot yet (see `free-registration-recovery.ts`).
    //
    // Fix round 1 (review finding W2): the service signals most failures as
    // TYPED outcomes that resolve normally, so the `catch` never saw them and
    // nothing was logged. Every outcome other than `provisioned`/`paid_user` is
    // reported now. Skipped entirely on a bind-skip: provisioning over an
    // established account is exactly what W1b refuses.
    if (freeBranchActive && user && !suppressLinking && deps.provisionFreeSnapshot) {
      try {
        const result = await deps.provisionFreeSnapshot({
          userId: user.id,
          ...(user.email ? { email: user.email } : {}),
        })
        deps.reportFreeProvisioning?.(result, { stage: "confirm", userId: user.id })
      } catch (e) {
        console.error("free snapshot provisioning failed:", e)
      }
    }

    // The account kept its own data; say so instead of silently landing them on
    // a scanner that answers with someone else's plan. Only a request that came
    // in as a free registration gets this landing — a stripped-marker confirm is
    // contained above but keeps its own destination.
    if (isFreeRegistration && suppressLinking) {
      return deps.redirect(`${origin}${buildFreeRegistrationBindSkippedLandingPath()}`)
    }

    // The free branch lands on its own CONSTANT destination, never on the
    // resolved `next`: a real signup e-mail's outer `next` is a `/auth/confirm`
    // URL, which `sanitizeAuthIntendedPath` refuses, so `next` would be the
    // `/chat` default and the free account would never reach the scanner
    // (finding V2). A constant is also the only redirect this branch can emit.
    return deps.redirect(`${origin}${freeBranchActive ? FREE_REGISTRATION_LANDING_PATH : next}`)
  }

  // An expired/consumed free-registration link goes back to the registration
  // screen (which explains it in German and can re-send), not to the login
  // form — the account may not exist yet, so `/auth` would be a dead end.
  //
  // Checked FIRST (finding V2): a real signup e-mail resolves no `intendedNext`
  // at all, so an already-signed-in visitor re-clicking an expired free link
  // would otherwise be sent to the paid journey frontier instead of the
  // registration screen. Every other path is unaffected — this arm only ever
  // runs for a request the free-registration shape resolved.
  if (isFreeRegistration) {
    return deps.redirect(`${origin}${buildFreeRegistrationRecoveryPath(freeLeadId ?? null)}`)
  }

  if (!isRecovery && user && isPersonalPlanReplayDestination(next, origin)) {
    return deps.redirect(`${origin}${next}`)
  }

  if (verificationAttempted && user && !intendedNext && deps.loadJourneyAccess) {
    try {
      const access = await deps.loadJourneyAccess(user.id)
      const frontier = resolveJourneyFrontier(access)
      if (frontier) return deps.redirect(`${origin}${frontier}`)
    } catch (error) {
      console.warn("Personal Plan auth replay frontier failed:", error)
    }
  }

  return deps.redirect(buildExpiredLinkDestination(origin, next, isRecovery))
}

export function createAuthConfirmGetHandler(deps: AuthConfirmRouteDeps) {
  return (request: Request) => handleAuthConfirmGet(request, deps)
}

export async function GET(request: Request) {
  return handleAuthConfirmGet(request, defaultDeps)
}
