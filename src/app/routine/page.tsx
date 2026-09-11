import Link from "next/link"
import type { ReactNode } from "react"

import { GatedRoutineExample } from "@/components/gated-preview/gated-routine-example"
import { PersonalPlanRoutineClient } from "@/components/routine/personal-plan"
import type { RoutineRefinementBannerViewModel } from "@/components/routine/personal-plan/routine-refinement-banner"
import { RoutinePageClient } from "@/components/routine/routine-page-client"
import { RetryRefreshButton } from "@/components/ui/retry-refresh-button"
import { shouldRenderGatedExample } from "@/lib/gated-preview/gate"
import { loadPersonalPlanRoutineView } from "@/lib/personal-plan/routine/load-view"
import type { PersonalPlanRoutineReadClient } from "@/lib/personal-plan/routine/repository"
import {
  loadOwnerPortfolioPresentation,
  type PortfolioPresentation,
} from "@/lib/personal-plan/routine/portfolio-presentation"
import { loadRefinementStatusForUser } from "@/lib/personal-plan/refinement/refinement-status-loader"
import {
  isPersonalPlanAppV1Enabled,
  isPersonalPlanStage4Enabled,
} from "@/lib/personal-plan/release"
import {
  canAccessPersonalPlanJourneyStage,
  type PersonalPlanJourneyAccess,
} from "@/lib/personal-plan/journey-access"
import {
  loadCachedAuthenticatedAppUserId,
  loadCachedPersonalPlanJourneyAccessForUser,
} from "@/lib/personal-plan/navigation-access"
import { createAdminClient } from "@/lib/supabase/admin"
import { reportPersonalPlanTransitionTiming } from "@/lib/personal-plan/transition-performance"

export const dynamic = "force-dynamic"

export type RoutinePageResolverDeps = {
  getUserId: () => Promise<string | null>
  loadJourneyAccess: (userId: string) => Promise<PersonalPlanJourneyAccess>
  readView: (input: {
    userId: string
    enabled: boolean
  }) => ReturnType<typeof loadPersonalPlanRoutineView>
  stage4Enabled: () => boolean
  readPortfolioPresentation?: (
    userId: string,
    planId: string,
    portfolioVersionId: string,
  ) => Promise<PortfolioPresentation | null>
  /**
   * The Routine refinement banner's data (Task 2.3): module, progress, and
   * visibility straight from the refinement-status API contract (Task 1.7).
   * Optional and failure-tolerant like `readPortfolioPresentation` above — a
   * missing dep or a failed read just means no banner, never a broken page.
   */
  readRefinementBanner?: (userId: string) => Promise<RoutineRefinementBannerViewModel | null>
}

export async function resolveRoutinePage(deps: RoutinePageResolverDeps) {
  const userId = await deps.getUserId()
  if (!userId) return { kind: "legacy" as const }

  try {
    const journey = await deps.loadJourneyAccess(userId)
    if (journey.kind === "legacy") return { kind: "legacy" as const }
    if (!canAccessPersonalPlanJourneyStage(journey, "stage4")) {
      return { kind: "unavailable" as const }
    }

    const enabled = deps.stage4Enabled()
    const view = await deps.readView({ userId, enabled })
    if (view.status === "no_personal_plan") return { kind: "legacy" as const }
    const routinePayload =
      view.status === "proposal" ? view.pendingProposal?.candidate : view.activeVersion?.payload
    const portfolioVersionId = routinePayload?.source.productPortfolioVersionId
    let portfolioPresentation: PortfolioPresentation | null = null
    if (portfolioVersionId && deps.readPortfolioPresentation) {
      try {
        portfolioPresentation = await deps.readPortfolioPresentation(
          userId,
          view.personalPlanId,
          portfolioVersionId,
        )
      } catch {
        // Presentation must not substitute or hide an otherwise valid Routine.
      }
    }
    let refinementBanner: RoutineRefinementBannerViewModel | null = null
    if (deps.readRefinementBanner) {
      try {
        refinementBanner = await deps.readRefinementBanner(userId)
      } catch {
        // Cosmetic and deliberately failure-tolerant, like the presentation
        // load above: a failed banner read must never hide or break the
        // Routine itself.
      }
    }
    return {
      kind: "personal_plan" as const,
      view,
      enabled,
      portfolioPresentation,
      refinementBanner,
    }
  } catch {
    // The legacy Routine is not a safe substitute once a Personal Plan exists.
    // Preserve the scoped recovery state instead of silently presenting it as confirmed.
    return { kind: "unavailable" as const }
  }
}

const defaultDeps: RoutinePageResolverDeps = {
  getUserId: loadCachedAuthenticatedAppUserId,
  loadJourneyAccess: loadCachedPersonalPlanJourneyAccessForUser,
  readView: ({ userId, enabled }) =>
    loadPersonalPlanRoutineView({
      client: createAdminClient() as unknown as PersonalPlanRoutineReadClient,
      userId,
      enabled,
    }),
  stage4Enabled: () => isPersonalPlanAppV1Enabled() && isPersonalPlanStage4Enabled(),
  readPortfolioPresentation: (userId, planId, portfolioVersionId) =>
    loadOwnerPortfolioPresentation(
      createAdminClient() as unknown as PersonalPlanRoutineReadClient,
      userId,
      planId,
      portfolioVersionId,
    ),
  readRefinementBanner: async (userId) => {
    const result = await loadRefinementStatusForUser(
      createAdminClient() as unknown as Parameters<typeof loadRefinementStatusForUser>[0],
      userId,
    )
    if (result.status !== "ok" || !result.data.banner.visible || !result.data.banner.module) {
      return null
    }
    return {
      module: result.data.banner.module,
      completedSteps: result.data.progress.completedSteps,
      totalSteps: result.data.progress.totalSteps,
    }
  },
}

export function RoutineUnavailableState({
  retryAction = <RetryRefreshButton label="Erneut laden" />,
}: {
  retryAction?: ReactNode
} = {}) {
  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-4 py-8">
      <section aria-live="polite" className="space-y-3 rounded-[8px] border border-border p-5">
        <h1 className="text-xl font-semibold">Deine Routine ist gerade nicht verfügbar</h1>
        <p className="text-sm text-muted-foreground">
          Bitte lade diese Seite erneut. Deine bestätigte Routine bleibt unverändert.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          {retryAction}
          <Link
            href="/plan-start"
            className="inline-flex min-h-[44px] items-center justify-center rounded-[12px] border-[1.5px] border-primary px-5 text-sm font-semibold text-primary hover:bg-muted"
          >
            Zum Plan
          </Link>
        </div>
      </section>
    </main>
  )
}

async function resolveDefaultRoutinePage() {
  const startedAt = performance.now()
  const resolved = await resolveRoutinePage(defaultDeps)
  reportPersonalPlanTransitionTiming({
    layer: "server",
    operation: "routine_page_resolve",
    outcome: resolved.kind,
    durationMs: performance.now() - startedAt,
  })
  return resolved
}

export default async function RoutinePage() {
  // T12 (freemium-scanner-first PR3): the free tier gets the framed „Beispiel" Routine
  // instead of its own (empty, stage-gated) one — the only branch this page gained;
  // premium and flag-off fall straight through to today's behaviour below.
  //
  // Pre-boundary fix wave (F2): the tier check and `resolveDefaultRoutinePage` now start
  // CONCURRENTLY instead of the tier gating serially ahead of the resolver — the previous
  // order added one `auth.getUser()` plus a billing/moderator composite in front of every
  // PREMIUM render, which is the common case. The trade is a resolver read a FREE render
  // now performs and discards (never a write — `resolveRoutinePage` is read-only and
  // catches its own errors) for zero added latency on the premium path. Semantics are
  // unchanged: a free render still never reaches `resolved`'s output, and
  // `shouldRenderGatedExample` itself still fails closed to premium on flag-off or an
  // entitlement-source outage.
  const [renderGatedExample, resolved] = await Promise.all([
    shouldRenderGatedExample(),
    resolveDefaultRoutinePage(),
  ])
  // F3: verified with two production builds + a live network capture — the suspected
  // bundle bloat did not reproduce. `GatedPreview`'s (and therefore `PremiumSheet`'s)
  // client chunk set is IDENTICAL to `RoutinePageClient`'s own (see the matching comment
  // in `app/chat/page.tsx`), i.e. that code already ships on this route via a chunk shared
  // for unrelated reasons, so a dynamic import here would move nothing. Kept static.
  if (renderGatedExample) return <GatedRoutineExample />

  if (resolved.kind === "legacy") return <RoutinePageClient />

  if (resolved.kind === "unavailable") {
    return <RoutineUnavailableState />
  }

  return (
    <PersonalPlanRoutineClient
      initialView={resolved.view}
      enabled={resolved.enabled}
      portfolioPresentation={resolved.portfolioPresentation}
      initialRefinementBanner={resolved.refinementBanner}
    />
  )
}
