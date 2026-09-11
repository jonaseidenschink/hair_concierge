import type { Metadata } from "next"
import { cookies } from "next/headers"
import { notFound, redirect } from "next/navigation"
import { renderLandingVariant } from "@/funnels/landing/registry"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import {
  isPersonalPlanQuizCrossBrowserResumeEnabled,
  isPersonalPlanQuizV1Enabled,
  isPersonalPlanResultReturnEnabled,
} from "@/lib/funnel/flags"
import { getFunnelPackageBySlug } from "@/lib/funnel/packages"
import {
  PERSONAL_PLAN_QUIZ_DRAFT_COOKIE,
  PERSONAL_PLAN_QUIZ_RESUME_QUERY_KEY,
  resolvePersonalPlanQuizDraftLandingState,
} from "@/lib/personal-plan-quiz/server-draft"
import {
  type PersonalPlanResultReturnResolution,
  PERSONAL_PLAN_RESULT_RETURN_COOKIE,
  resolvePersonalPlanResultReturn,
  resolvePersonalPlanReturnLanding,
} from "@/lib/personal-plan-quiz/result-return"
import { LandingTracking } from "@/providers/tracking-providers"
import {
  PERSONAL_PLAN_FIELD_TEST_CAMPAIGN_COOKIE,
  resolvePersonalPlanFieldTestCampaignCookie,
} from "@/lib/personal-plan-field-test"
import { resolveModeratorJourney } from "@/lib/personal-plan-field-test/moderator-journey"
import { FUNNEL_SESSION_COOKIE } from "@/lib/funnel/cookie"
import { resolveFunnelCookieContext } from "@/lib/funnel/server"
import { createClient } from "@/lib/supabase/server"
import { PersonalPlanFieldTestEnded } from "@/components/personal-plan-field-test/personal-plan-field-test-ended"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default async function CampaignLandingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ slug }, resolvedSearchParams] = await Promise.all([params, searchParams])
  const funnelPackage = getFunnelPackageBySlug(slug)
  if (!funnelPackage) notFound()
  if (funnelPackage.key === "meta_routine_v1") {
    redirect(buildRetiredRoutineRedirect(resolvedSearchParams))
  }
  if (funnelPackage.status === "archived") notFound()
  if (funnelPackage.key === "meta_personal_plan_v1" && !isPersonalPlanQuizV1Enabled()) {
    notFound()
  }

  const resumeToken = getSingleSearchParam(
    resolvedSearchParams[PERSONAL_PLAN_QUIZ_RESUME_QUERY_KEY],
  )
  const resumeEnabled = isPersonalPlanQuizCrossBrowserResumeEnabled()
  let personalPlanQuizResume
  let personalPlanFieldTest = false
  let moderatorQuiz: { scope: string; email: string } | null = null

  if (funnelPackage.key === "meta_personal_plan_v1") {
    const cookieStore = await cookies()
    const fieldTest = await resolvePersonalPlanFieldTestCampaignCookie(
      cookieStore.get(PERSONAL_PLAN_FIELD_TEST_CAMPAIGN_COOKIE)?.value,
    )
    const moderator = await resolveModeratorJourney({
      cookies: cookieStore,
      funnelContext: await resolveFunnelCookieContext(
        cookieStore.get(FUNNEL_SESSION_COOKIE)?.value,
      ),
    })
    if (moderator.kind === "unavailable") return <PersonalPlanFieldTestEnded unavailable />
    if (moderator.kind === "authorized")
      moderatorQuiz = { scope: moderator.funnelSessionId, email: moderator.email }
    personalPlanFieldTest = fieldTest.kind === "eligible"
    if (personalPlanFieldTest) {
      const supabase = await createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (user && !moderatorQuiz) {
        return <PersonalPlanFieldTestExistingSessionNotice />
      }
    }
    const resultCookie = cookieStore.get(PERSONAL_PLAN_RESULT_RETURN_COOKIE)?.value
    let resultReturn: PersonalPlanResultReturnResolution = {
      leadId: null,
      status: "invalid",
    }

    if (isPersonalPlanResultReturnEnabled() && resultCookie) {
      resultReturn = await resolvePersonalPlanResultReturn(resultCookie)
    }

    const initialReturnDecision = resolvePersonalPlanReturnLanding({
      resultReturn,
      resumeToken,
    })
    if (!personalPlanFieldTest && initialReturnDecision.kind === "result") {
      redirect(`/result/${encodeURIComponent(initialReturnDecision.leadId)}?entry=quiz_return`)
    }

    if (resumeToken && (!resumeEnabled || moderatorQuiz)) {
      redirect("/lp/haarplan")
    }

    if (resumeEnabled && !moderatorQuiz) {
      const landingState = await resolvePersonalPlanQuizDraftLandingState({
        cookieValue: cookieStore.get(PERSONAL_PLAN_QUIZ_DRAFT_COOKIE)?.value,
        resumeToken,
      })

      if (landingState.shouldExchange && resumeToken) {
        redirect(
          `/api/quiz/personal-plan-draft/resume?${PERSONAL_PLAN_QUIZ_RESUME_QUERY_KEY}=${encodeURIComponent(resumeToken)}`,
        )
      }

      personalPlanQuizResume = { enabled: true, snapshot: landingState.snapshot }
    }
  }

  const landingVariant = renderLandingVariant(funnelPackage.landingVariant, {
    personalPlanFieldTest,
    personalPlanQuizResume,
    moderatorQuiz,
    freemiumScannerFirst: isFreemiumScannerFirstEnabled(),
  })
  if (!landingVariant) notFound()

  return (
    <>
      <LandingTracking />
      {landingVariant}
    </>
  )
}

function PersonalPlanFieldTestExistingSessionNotice() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#fcfaf7] px-4 text-center text-[var(--brand-plum-darkest)]">
      <section className="max-w-lg rounded-[2rem] border border-[var(--brand-plum-light)] bg-white p-7 shadow-[0_22px_54px_-40px_rgba(var(--brand-plum-rgb),0.55)]">
        <p className="text-sm font-semibold text-[var(--brand-plum)]">
          Produkttest separat starten
        </p>
        <h1 className="mt-3 font-header text-3xl">
          Dieser Test braucht eine separate Browser-Sitzung.
        </h1>
        <p className="mt-4 leading-7 text-[var(--text-sub)]">
          Dein bestehendes Chaarlie-Konto bleibt getrennt. Öffne den Testlink in einem anderen
          Browser oder nach dem Abmelden erneut.
        </p>
        <a
          className="mt-6 inline-flex rounded-full bg-[var(--brand-plum)] px-6 py-3 font-bold text-white"
          href="/profile"
        >
          Zu meinem Konto
        </a>
      </section>
    </main>
  )
}

const SAFE_RETIRED_ROUTINE_QUERY_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "fbclid",
] as const

export function buildRetiredRoutineRedirect(
  searchParams: Record<string, string | string[] | undefined>,
) {
  const params = new URLSearchParams()
  for (const key of SAFE_RETIRED_ROUTINE_QUERY_KEYS) {
    const value = getSingleSearchParam(searchParams[key])
    if (value) params.set(key, value)
  }
  const query = params.toString()
  return query ? `/?${query}` : "/"
}

function getSingleSearchParam(value: string | string[] | undefined) {
  return typeof value === "string" && value.length > 0 ? value : null
}
