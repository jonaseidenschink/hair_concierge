import { after, NextResponse } from "next/server"
import { cookies } from "next/headers"

import { checkEmailDeliverability } from "@/lib/email-deliverability"
import { recordEmailDeliverabilityOutcome } from "@/lib/email-deliverability-observability"
import {
  EMAIL_DELIVERABILITY_REJECTION_MESSAGE,
  type EmailDeliverabilityRejectionResponse,
} from "@/lib/email-deliverability-shared"
import { dispatchCustomerIoProfileSyncForLead } from "@/lib/personal-plan-quiz/customerio-outbox"
import { enqueueMetaLead } from "@/app/api/quiz/lead/route"
import { metaRequestData, resolveBrowserFunnelEventId } from "@/lib/analytics/meta-capi"
import { META_PERSONAL_PLAN_QUIZ_EVENT_SOURCE_URL } from "@/lib/analytics/page-url"
import {
  canonicalizePersonalPlanAnswers,
  hashPersonalPlanAnswers,
  hashPersonalPlanClaimToken,
  normalizePersonalPlanEmail,
  personalPlanLeadRequestSchema,
} from "@/lib/personal-plan-quiz/persistence"
import { checkRateLimit, QUIZ_LEAD_RATE_LIMIT } from "@/lib/rate-limit"
import { createAdminClient } from "@/lib/supabase/admin"
import { FUNNEL_SESSION_COOKIE, FUNNEL_TOUCH_COOKIE } from "@/lib/funnel/cookie"
import {
  recordFunnelEvent,
  resolveFunnelCookieContext,
  resolvePendingFunnelTouchValue,
} from "@/lib/funnel/server"
import { isPersonalPlanQuizV1Enabled, isPersonalPlanResultReturnEnabled } from "@/lib/funnel/flags"
import { issuePersonalPlanResultReturn } from "@/lib/personal-plan-quiz/result-return"
import {
  bindPersonalPlanFieldTestLead,
  PERSONAL_PLAN_FIELD_TEST_CAMPAIGN_COOKIE,
  resolvePersonalPlanFieldTestCampaignCookie,
} from "@/lib/personal-plan-field-test"

import { resolveModeratorJourney } from "@/lib/personal-plan-field-test/moderator-journey"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import { issueFreeRegistrationCapability } from "@/lib/auth/free-registration-capability"

interface PersonalPlanLeadPostDependencies {
  checkRateLimit: typeof checkRateLimit
  checkEmailDeliverability: typeof checkEmailDeliverability
  recordEmailDeliverabilityOutcome: typeof recordEmailDeliverabilityOutcome
  createAdminClient: typeof createAdminClient
  cookies: typeof cookies
  issueResultReturn: typeof issuePersonalPlanResultReturn
  enqueueMetaLead: typeof enqueueMetaLead
  recordFunnelEvent: typeof recordFunnelEvent
  resolveFunnelCookieContext: typeof resolveFunnelCookieContext
  resolvePendingFunnelTouchValue: typeof resolvePendingFunnelTouchValue
  bindPersonalPlanFieldTestLead: typeof bindPersonalPlanFieldTestLead
  resolvePersonalPlanFieldTestCampaignCookie: typeof resolvePersonalPlanFieldTestCampaignCookie
  resolveModeratorJourney: typeof resolveModeratorJourney
  scheduleAfter: typeof after
  isFreemiumScannerFirstEnabled: typeof isFreemiumScannerFirstEnabled
  issueFreeRegistrationCapability: (leadId: string) => string | null
}

export function createPersonalPlanLeadPostHandler(
  overrides: Partial<PersonalPlanLeadPostDependencies> = {},
) {
  const dependencies: PersonalPlanLeadPostDependencies = {
    checkRateLimit,
    checkEmailDeliverability,
    recordEmailDeliverabilityOutcome,
    createAdminClient,
    cookies,
    issueResultReturn: issuePersonalPlanResultReturn,
    enqueueMetaLead,
    recordFunnelEvent,
    resolveFunnelCookieContext,
    resolvePendingFunnelTouchValue,
    bindPersonalPlanFieldTestLead,
    resolvePersonalPlanFieldTestCampaignCookie,
    resolveModeratorJourney,
    scheduleAfter: after,
    isFreemiumScannerFirstEnabled,
    issueFreeRegistrationCapability: (leadId) => issueFreeRegistrationCapability(leadId),
    ...overrides,
  }

  return async function POST(request: Request) {
    if (!isPersonalPlanQuizV1Enabled()) {
      return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 })
    }

    const rateCheck = await dependencies.checkRateLimit(
      request.headers.get("x-forwarded-for") ?? "unknown",
      QUIZ_LEAD_RATE_LIMIT,
    )
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: "Zu viele Anfragen" },
        { status: rateCheck.error === "service_unavailable" ? 503 : 429 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Ungueltige Daten" }, { status: 400 })
    }
    const parseResult = personalPlanLeadRequestSchema.safeParse(body)
    if (!parseResult.success) {
      return NextResponse.json({ error: "Ungueltige Daten" }, { status: 400 })
    }

    try {
      const { browserEventId, funnelEventId } = resolveBrowserFunnelEventId(body)
      const parsed = parseResult.data
      const email = normalizePersonalPlanEmail(parsed.email)

      // Zustellbarkeit pruefen, bevor der Lead gespeichert wird. Tippfehler in
      // der Domain ("gmail.vom", "gmx.den") waren die Hauptursache fuer eine
      // Bounce-Quote von rund 4,6 Prozent, die Gmail den Absender in den
      // Spam-Ordner sortieren laesst. Bei DNS-Problemen laesst die Pruefung
      // bewusst durch, sie darf nie Leads blockieren.
      const deliverability = await dependencies.checkEmailDeliverability(email)
      dependencies.recordEmailDeliverabilityOutcome("personal_plan", deliverability)
      if (!deliverability.ok) {
        const rejection: EmailDeliverabilityRejectionResponse = {
          error: EMAIL_DELIVERABILITY_REJECTION_MESSAGE,
          reason: deliverability.reason,
          suggestion: deliverability.suggestion,
        }
        return NextResponse.json(rejection, { status: 422 })
      }
      const deliverableEmail = deliverability.normalized
      const metaUserRequestData = metaRequestData(request)
      const quizAnswers = canonicalizePersonalPlanAnswers(parsed.answers)
      const answerHash = hashPersonalPlanAnswers(quizAnswers)
      const supabase = dependencies.createAdminClient()
      const cookieStore = await dependencies.cookies()
      const funnelContext = await dependencies.resolveFunnelCookieContext(
        cookieStore.get(FUNNEL_SESSION_COOKIE)?.value,
      )
      const funnelTouch = funnelContext
        ? await dependencies.resolvePendingFunnelTouchValue(
            cookieStore.get(FUNNEL_TOUCH_COOKIE)?.value,
            funnelContext,
          )
        : null
      const fieldTestCookieValue = cookieStore.get(PERSONAL_PLAN_FIELD_TEST_CAMPAIGN_COOKIE)?.value
      const fieldTestCampaign = funnelContext
        ? await dependencies.resolvePersonalPlanFieldTestCampaignCookie(fieldTestCookieValue)
        : { kind: "unavailable" as const, code: "field_test_unavailable" as const }
      const moderator = await dependencies.resolveModeratorJourney({
        cookies: cookieStore,
        funnelContext,
      })
      if (moderator.kind === "unavailable") {
        return NextResponse.json(
          { error: "Dein Zugang kann gerade nicht geprüft werden. Bitte versuche es erneut." },
          { status: 503 },
        )
      }
      if (
        moderator.kind === "authorized" &&
        moderator.email !== deliverableEmail.trim().toLowerCase()
      ) {
        return NextResponse.json(
          { error: "Bitte verwende dein eingeladenes Konto." },
          { status: 403 },
        )
      }
      const { data: savedLeads, error: saveError } = await supabase.rpc(
        moderator.kind === "authorized"
          ? "save_personal_plan_moderator_lead_with_artifact"
          : "save_personal_plan_lead_with_artifact",
        {
          ...(moderator.kind === "authorized"
            ? {
                p_campaign_id: moderator.campaignId,
                p_user_id: moderator.userId,
                p_confirmed_email: moderator.email,
                p_funnel_session_id: moderator.funnelSessionId,
              }
            : { p_email: deliverableEmail }),
          p_marketing_consent: parsed.marketingConsent,
          p_quiz_answers: quizAnswers,
          p_artifact_id: parsed.preparedPlan.artifactId,
          p_claim_token_hash: hashPersonalPlanClaimToken(parsed.preparedPlan.claimToken),
          p_answer_hash: answerHash,
        },
      )
      if (saveError) throw saveError
      const savedLead = savedLeads?.[0]
      const leadId = savedLead?.lead_id
      if (typeof leadId !== "string") {
        throw new Error("Personal-plan lead save returned no lead ID")
      }
      // Both save RPCs report whether they RETURNED AN EXISTING lead instead of
      // inserting one (`reused`). Only an explicit `false` counts as "this
      // browser created this lead" — anything else (true, missing, malformed)
      // is treated as reused, which is the fail-closed direction for the
      // capability minted below.
      const leadWasReused = savedLead?.reused !== false

      const createdAt = new Date().toISOString()
      if (moderator.kind !== "authorized")
        dependencies.scheduleAfter(async () => {
          try {
            const outcome = await dispatchCustomerIoProfileSyncForLead(supabase, leadId)
            if (outcome === "failed") {
              console.warn("[customerio:profile-sync] deferred delivery queued for retry", {
                leadId,
              })
            }
          } catch (error) {
            console.warn("[customerio:profile-sync] deferred dispatch failed", {
              leadId,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        })
      if (fieldTestCampaign.kind !== "eligible") {
        dependencies.enqueueMetaLead({
          browserEventId,
          email: deliverableEmail,
          eventSourceUrl: META_PERSONAL_PLAN_QUIZ_EVENT_SOURCE_URL,
          eventTime: createdAt,
          leadId,
          name: "",
          requestData: metaUserRequestData,
        })
      }
      const attributionAttached = funnelContext
        ? await dependencies
            .recordFunnelEvent({
              context: funnelContext,
              eventId: funnelEventId,
              milestone: "lead_captured",
              leadId,
              touch: funnelTouch,
            })
            .then(() => true)
            .catch((error) => {
              console.warn("[funnel] personal-plan lead attachment failed", error)
              return false
            })
        : false
      const fieldTestAttached =
        moderator.kind === "authorized"
          ? true
          : attributionAttached && funnelContext && fieldTestCampaign.kind === "eligible"
            ? await dependencies.bindPersonalPlanFieldTestLead({
                campaignCookieValue: fieldTestCookieValue,
                funnelContext,
                leadId,
              })
            : false
      // Freemium scanner-first (T18 fix round 1, review finding W1a): quiz
      // completion is the ONE moment only the completing browser can observe,
      // so it is where the capability that authorizes a later e-mail CORRECTION
      // is minted. Returned in the body, carried by the quiz's sessionStorage
      // handoff to `/registrierung`. Flag-gated: with the flag off the response
      // body is byte-identical to before, and a missing signing secret simply
      // omits the field (the correction path then refuses — fail closed).
      //
      // PR6 Codex review, finding V1 (CRITICAL): the save RPC DEDUPLICATES.
      // `save_personal_plan_lead_with_artifact` returns the victim's existing
      // lead for any submission carrying the same e-mail and the same canonical
      // answers within 15 minutes (and for a replayed artifact claim), so an
      // attacker who can guess or observe a victim's answers gets that victim's
      // lead id back. Minting the capability there handed them authority to
      // REPOINT the victim's lead at their own address. The capability is
      // therefore minted ONLY for a genuinely new lead; a reused lead gets none,
      // and `/registrierung`'s correction path answers with its existing honest
      // `correction_not_authorized` refusal. Sending and re-sending the link to
      // the address the lead already holds are unaffected either way.
      const freeRegistrationCapability =
        dependencies.isFreemiumScannerFirstEnabled() && !leadWasReused
          ? dependencies.issueFreeRegistrationCapability(leadId)
          : null
      const responseBody: Record<string, unknown> =
        fieldTestCampaign.kind === "eligible"
          ? { leadId, attributionAttached, fieldTestAttached }
          : { leadId, attributionAttached }
      if (freeRegistrationCapability) {
        responseBody.freeRegistrationCapability = freeRegistrationCapability
      }
      const response = NextResponse.json(responseBody)
      if (isPersonalPlanResultReturnEnabled() && moderator.kind !== "authorized") {
        try {
          const issued = await dependencies.issueResultReturn({
            leadId,
            response,
            admin: supabase as never,
          })
          if (!issued.issued) {
            console.warn("[personal-plan-result-return] capability issuance unavailable")
          }
        } catch {
          console.warn("[personal-plan-result-return] capability issuance unavailable")
        }
      }
      if (attributionAttached && funnelTouch)
        response.cookies.set(FUNNEL_TOUCH_COOKIE, "", { path: "/", maxAge: 0 })
      return response
    } catch (error) {
      console.error("Personal-plan lead API error:", error)
      return NextResponse.json(
        {
          error: isPreparedPlanClaimError(error)
            ? "Plan muss erneut vorbereitet werden"
            : "Speichern fehlgeschlagen",
        },
        { status: isPreparedPlanClaimError(error) ? 409 : 500 },
      )
    }
  }
}

export const POST = createPersonalPlanLeadPostHandler()

function isPreparedPlanClaimError(error: unknown): boolean {
  if (!error || typeof error !== "object" || Array.isArray(error)) return false
  const code = (error as Record<string, unknown>).code
  return code === "22023" || code === "23505" || code === "P0002"
}
