import { RouteAwareApplicationPage } from "@/components/application/application-page"
import type { ApplicationPageView } from "@/components/application/application-types"
import { toApplicationPageView } from "@/components/application/application-view-adapter"
import { GatedAnwendungExample } from "@/components/gated-preview/gated-anwendung-example"
import { resolveGatedPageMode } from "@/lib/gated-preview/gate"
import {
  loadPersonalPlanKeepsakeContentForUser,
  type PersonalPlanKeepsakeContent,
} from "@/lib/personal-plan/keepsake-content"
import {
  PERSONAL_PLAN_STAGE5_CONTRACT_VERSION,
  type PersonalPlanStage5ContractVersion,
} from "@/lib/personal-plan/stage5-access"
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
import {
  adaptAcceptedActiveRoutineForApplication,
  loadImmutableRoutineProfile,
  type ApplicationRoutineReadClient,
} from "@/lib/personal-plan/routine/application-adapter"
import { loadPersonalPlanActiveRoutineVersion } from "@/lib/personal-plan/routine/load-view"
import type { PersonalPlanRoutineReadClient } from "@/lib/personal-plan/routine/repository"
import { compileApplicationViewV2 } from "@/lib/routines/personal-plan/application/compiler-v2"
import { applicationFamilyTemplateV2Schema } from "@/lib/routines/personal-plan/application/contracts-v2"
import { projectApplicationCadenceByDay } from "@/lib/routines/personal-plan/application/cadence-projector"
import { createServerApplicationGuidanceRepository } from "@/lib/routines/personal-plan/application/repository"
import type { ApplicationDayTypeKey } from "@/lib/routines/personal-plan/application/contracts"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  capturePersonalPlanApplicationFailure,
  type PersonalPlanApplicationFailureDetails,
} from "@/lib/observability/personal-plan-application"
import { reportPersonalPlanTransitionTiming } from "@/lib/personal-plan/transition-performance"
import { CatalogDatabaseReadError } from "@/lib/catalog-authority/product-spec-relationships"

export const dynamic = "force-dynamic"

type AdminReadClient = PersonalPlanRoutineReadClient & ApplicationRoutineReadClient

export type AnwendungResolverDeps = {
  getUserId: () => Promise<string | null>
  loadJourneyAccess: (userId: string) => Promise<PersonalPlanJourneyAccess>
  loadRoutineVersion: (
    userId: string,
    planId: string,
    activeRoutineVersionId: string,
  ) => ReturnType<typeof loadPersonalPlanActiveRoutineVersion>
  adaptRoutine: typeof adaptAcceptedActiveRoutineForApplication
  loadProfile: typeof loadImmutableRoutineProfile
  loadContent: (
    contractVersion: PersonalPlanStage5ContractVersion,
  ) => ReturnType<typeof createServerApplicationGuidanceRepository>
  createReadClient: () => AdminReadClient
  appEnabled: () => boolean
  stage4Enabled: () => boolean
  reportFailure: (details: PersonalPlanApplicationFailureDetails) => void
  /**
   * T17 keepsake: proof that this user owns an accepted Routine version, read WITHOUT
   * the entitlement authority (`loadJourneyAccess`) — see the doc comment on
   * `resolveKeepsakeRoutinePage` in `app/routine/page.tsx` for why widening that loader
   * instead was rejected. Only ever consulted in keepsake mode.
   */
  loadKeepsakeContent?: (userId: string) => Promise<PersonalPlanKeepsakeContent | null>
}

// Only Stage 5's own throw codes may become a Sentry tag. A database or Zod
// message can carry key and received values, and its cardinality is unbounded.
const STABLE_FAILURE_CODES = new Set([
  "accepted_routine_product_unavailable",
  "accepted_routine_product_identity_unavailable",
  "application_v2_product_pointers_unavailable",
  "refined_need_not_found",
])

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  return STABLE_FAILURE_CODES.has(message) ? message : "unknown"
}

function failureReason(error: unknown): PersonalPlanApplicationFailureDetails["reason"] {
  const message = error instanceof Error ? error.message : ""
  if (error instanceof CatalogDatabaseReadError) return "database"
  if (error instanceof Error && error.name === "ZodError") return "schema_contract"
  if (/database|postgres|supabase|relation|query/i.test(message)) return "database"
  if (/zod|schema|invalid|expected|missing active day definition/i.test(message))
    return "schema_contract"
  if (/guidance|protocol/i.test(message)) return "missing_protocol"
  return "unknown"
}

export async function resolveAnwendungPage(
  deps: AnwendungResolverDeps,
  selectedDayType?: ApplicationDayTypeKey,
  options?: {
    /**
     * T17: resolve the Anwendung from KEEPSAKE evidence (a lapsed owner's own accepted
     * Routine) instead of from live journey entitlement. Everything downstream — the
     * routine version read, the adapter, the compiler, the failure reporting — is the
     * identical owner-scoped pipeline; only the source of `{planId, routineVersionId}`
     * differs. Omitted (every pre-T17 caller) the journey path runs verbatim.
     */
    keepsake?: boolean
  },
): Promise<ApplicationPageView> {
  if (!deps.appEnabled() || !deps.stage4Enabled()) {
    return { state: "feature_disabled" }
  }
  const userId = await deps.getUserId()
  if (!userId) return { state: "feature_disabled" }

  const startedAt = Date.now()
  let failureContext: Omit<PersonalPlanApplicationFailureDetails, "reason" | "durationMs"> = {}

  try {
    let source: { personalPlanId: string; activeRoutineVersionId: string }
    if (options?.keepsake) {
      const keepsake = await deps.loadKeepsakeContent?.(userId)
      if (!keepsake) return { state: "no_active_routine" }
      source = keepsake
    } else {
      const journey = await deps.loadJourneyAccess(userId)
      if (!canAccessPersonalPlanJourneyStage(journey, "stage5")) {
        return { state: "feature_disabled" }
      }
      if (journey.kind !== "personal_plan" || !journey.activeRoutineVersionId) {
        return { state: "no_active_routine" }
      }
      source = {
        personalPlanId: journey.personalPlanId,
        activeRoutineVersionId: journey.activeRoutineVersionId,
      }
    }
    const client = deps.createReadClient()
    const contractVersion = PERSONAL_PLAN_STAGE5_CONTRACT_VERSION
    const content = deps.loadContent(contractVersion)
    const [activeVersion, dayDefinitions, protocols] = await Promise.all([
      deps.loadRoutineVersion(userId, source.personalPlanId, source.activeRoutineVersionId),
      content.loadActiveDayTypeDefinitions(),
      content.loadActiveGuidanceProtocols(),
    ])
    if (!activeVersion) return { state: "no_active_routine" }
    failureContext = {
      planId: source.personalPlanId,
      routineVersionId: activeVersion.id,
      refinedVersionId: activeVersion.payload.source.refinedVersionId,
    }
    const [accepted, profile] = await Promise.all([
      deps.adaptRoutine({ client, activeVersion, contractVersion }),
      deps.loadProfile({
        client,
        userId,
        planId: source.personalPlanId,
        refinedVersionId: activeVersion.payload.source.refinedVersionId,
      }),
    ])
    const familyPayloads = protocols.map((protocol) =>
      applicationFamilyTemplateV2Schema.parse(protocol.payload),
    )
    const applicationInput = {
      routineItems: accepted.routineItems,
      unresolvedRoutineItems: accepted.unresolvedRoutineItems,
      profile,
      dayTypes: dayDefinitions.map((day) => ({ key: day.key, sortOrder: day.sortOrder })),
    }
    if (!accepted.applicationPointersV2) {
      throw new Error("application_v2_product_pointers_unavailable")
    }
    const compiled = compileApplicationViewV2({
      input: applicationInput,
      familyTemplates: familyPayloads,
      productPointers: accepted.applicationPointersV2,
    })
    for (const degraded of accepted.degradedItems) {
      deps.reportFailure({
        ...failureContext,
        durationMs: Date.now() - startedAt,
        reason: "product_guidance_unresolved",
        productId: degraded.productId,
        issueCode: degraded.issue,
      })
    }
    const pointerIssues = compiled.pointerIssues
    if (pointerIssues.length > 0) {
      for (const issue of pointerIssues) {
        deps.reportFailure({
          ...failureContext,
          durationMs: Date.now() - startedAt,
          reason: "product_guidance_unresolved",
          productId: issue.productId,
          issueCode: issue.reason,
        })
      }
    }
    const selectedFailure = selectedDayType
      ? compiled.failures.find((failure) => failure.dayType === selectedDayType)
      : undefined
    if (selectedFailure) {
      deps.reportFailure({
        ...failureContext,
        durationMs: Date.now() - startedAt,
        reason:
          selectedFailure.reason === "incomplete_guidance"
            ? "incomplete_guidance"
            : "missing_protocol",
      })
    }
    const view = toApplicationPageView({
      compiled,
      dayDefinitions,
      cadenceByDay: projectApplicationCadenceByDay({
        routineItems: accepted.routineItems,
        compiledDayKeys: compiled.days.map((day) => day.key),
      }),
    })
    if (selectedDayType) {
      if (view.state === "ready" && view.days.some((day) => day.dayType === selectedDayType)) {
        return { ...view, selectedDayType }
      }
      if (view.state === "no_complete_day" && view.restDay.dayType === selectedDayType) {
        return { state: "ready", days: [view.restDay], selectedDayType }
      }
      return { state: "day_unavailable", overviewHref: "/anwendung" }
    }
    return view
  } catch (error) {
    deps.reportFailure({
      ...failureContext,
      durationMs: Date.now() - startedAt,
      reason: failureReason(error),
      failureCode: failureCode(error),
    })
    return { state: "unavailable" }
  }
}

function createAdminReadClient() {
  return createAdminClient() as unknown as AdminReadClient
}
const defaultDeps: AnwendungResolverDeps = {
  getUserId: loadCachedAuthenticatedAppUserId,
  loadJourneyAccess: loadCachedPersonalPlanJourneyAccessForUser,
  loadRoutineVersion: (userId, planId, activeRoutineVersionId) =>
    loadPersonalPlanActiveRoutineVersion({
      client: createAdminReadClient(),
      userId,
      planId,
      activeRoutineVersionId,
    }),
  adaptRoutine: adaptAcceptedActiveRoutineForApplication,
  loadProfile: loadImmutableRoutineProfile,
  loadContent: (contractVersion) => createServerApplicationGuidanceRepository(contractVersion),
  createReadClient: createAdminReadClient,
  appEnabled: isPersonalPlanAppV1Enabled,
  stage4Enabled: isPersonalPlanStage4Enabled,
  reportFailure: capturePersonalPlanApplicationFailure,
  loadKeepsakeContent: loadPersonalPlanKeepsakeContentForUser,
}

async function resolveDefaultAnwendungPage(
  selectedDayType?: ApplicationDayTypeKey,
  options?: { keepsake?: boolean },
) {
  const startedAt = performance.now()
  const view = await resolveAnwendungPage(defaultDeps, selectedDayType, options)
  const durationMs = performance.now() - startedAt
  reportPersonalPlanTransitionTiming({
    layer: "server",
    operation: selectedDayType ? "application_day_resolve" : "application_page_resolve",
    outcome: view.state,
    durationMs,
  })
  return { view, durationMs }
}

export default async function AnwendungPage({
  selectedDayType,
}: { selectedDayType?: ApplicationDayTypeKey } = {}) {
  // T12 (freemium-scanner-first PR3): the free tier gets the framed „Beispiel" Anwendung
  // instead of its own (stage-gated, empty) one — for the overview and for every
  // `/anwendung/[dayType]` deep link, which re-renders this same component.
  //
  // Pre-boundary fix wave (F2): the tier check and `resolveDefaultAnwendungPage` now start
  // CONCURRENTLY instead of the tier gating serially ahead of the resolver — the previous
  // order added one `auth.getUser()` plus a billing/moderator composite in front of every
  // PREMIUM render, which is the common case. The trade is a resolver read a FREE render
  // now performs and discards (never a write — `resolveAnwendungPage` is read-only; its
  // `reportFailure` calls only fire on genuine compile failures, unrelated to the tier) for
  // zero added latency on the premium path. Semantics are unchanged: a free render still
  // never reaches `view`, and `resolveGatedPageMode` itself still fails closed to
  // premium on flag-off or an entitlement-source outage.
  //
  // T17 widens that one branch from two states to three: `"example"` is the never-paid
  // free tier (unchanged), `"keepsake"` is a LAPSED owner reading their OWN Anwendung
  // (same page, same compiler — sourced from their accepted Routine instead of live
  // journey entitlement; the page itself has no mutations to lock), and `"premium"` falls
  // straight through to today's page.
  const [pageMode, { view, durationMs }] = await Promise.all([
    resolveGatedPageMode(),
    resolveDefaultAnwendungPage(selectedDayType),
  ])
  if (pageMode === "keepsake") {
    const keepsake = await resolveDefaultAnwendungPage(selectedDayType, { keepsake: true })
    // A keepsake read that produced nothing renderable falls back to the free tier's own
    // page rather than showing an owner a "feature disabled" dead end.
    if (keepsake.view.state !== "feature_disabled" && keepsake.view.state !== "unavailable") {
      return <RouteAwareApplicationPage view={keepsake.view} />
    }
    return <GatedAnwendungExample />
  }
  const renderGatedExample = pageMode === "example"
  // F3: verified with two production builds + a live network capture — the suspected
  // bundle bloat did not reproduce. `GatedPreview`'s (and therefore `PremiumSheet`'s)
  // client chunk set is IDENTICAL to `ApplicationPage`'s own (see the matching comment in
  // `app/chat/page.tsx`), i.e. that code already ships on this route via a chunk shared
  // for unrelated reasons, so a dynamic import here would move nothing. Kept static.
  if (renderGatedExample) return <GatedAnwendungExample />

  const internalComputeMs =
    process.env.PERSONAL_PLAN_APPLICATION_PERFORMANCE_MARKER_ENABLED === "true"
      ? Math.round(durationMs * 100) / 100
      : undefined
  return <RouteAwareApplicationPage view={view} internalComputeMs={internalComputeMs} />
}
