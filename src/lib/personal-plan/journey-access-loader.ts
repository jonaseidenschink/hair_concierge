import "server-only"

import { createAdminClient } from "@/lib/supabase/admin"
import { reportPersonalPlanTransitionTiming } from "./transition-performance"
import { buildStage3EntryContext } from "./products/stage2-entry-adapter"
import { requireCurrentAuthoritySnapshot } from "./products/authority/snapshot"
import type { Stage3AuthorityDraftInput, Stage3ProductDraft } from "./products/contracts"
import type { InitialNeedPlanSnapshot } from "./types"
import {
  getPersonalPlanNewBuyerCohortCutoff,
  canAccessPersonalPlanAppV1Rollout,
  isPersonalPlanAppV1Enabled,
  isPersonalPlanStage2Enabled,
  isPersonalPlanStage3Enabled,
  isPersonalPlanStage4Enabled,
  resolvePersonalPlanAppV1Rollout,
  type PersonalPlanAppV1Rollout,
} from "./release"
import { canAccessPersonalPlanStage5 } from "./stage5-access"
import { isPersonalPlanInternalUser, type PersonalPlanInternalUserClient } from "./rollout-access"
import {
  resolvePersonalPlanJourneyAccess,
  type PersonalPlanJourneyAccess,
  type PersonalPlanJourneyAccessInput,
} from "./journey-access"
import {
  findPersonalPlanEnrollmentForUser,
  type PersonalPlanEnrollmentSourceKind,
} from "./enrollment"
import { isPersonalPlanLegacyMigrationEnabled } from "./migration-admission"

type AccessState = PersonalPlanJourneyAccessInput["accessState"]

type JourneyPlanRow = NonNullable<PersonalPlanJourneyAccessInput["plan"]>

type JourneyDraft = Stage3AuthorityDraftInput & Pick<Stage3ProductDraft, "status">

export type PersonalPlanJourneyAccessLoaderDeps = {
  loadEntitlement: (userId: string) => Promise<{
    accessState: AccessState
    qualifiedAt: string | null
    artifactLeadId: string | null
    quizSourceKind?: "personal_plan" | "legacy" | null
    sourceKind?: PersonalPlanEnrollmentSourceKind | null
  }>
  cohortCutoff: () => Date | null
  migrationEnabled?: () => boolean
  appEnabled: () => boolean
  appRollout: () => PersonalPlanAppV1Rollout
  stage2Enabled: () => boolean
  stage3Enabled: () => boolean
  stage4Enabled: () => boolean
  loadPreparedArtifact: (
    userId: string,
    leadId: string,
    quizSourceKind?: "personal_plan" | "legacy" | null,
  ) => Promise<{ id: string } | null>
  loadPlan: (userId: string) => Promise<JourneyPlanRow | null>
  loadCurrentRefinedNeed: (
    userId: string,
    planId: string,
    refinedVersionId: string,
  ) => Promise<InitialNeedPlanSnapshot | null>
  loadCurrentProductDraft: (
    userId: string,
    planId: string,
    refinedVersionId: string,
  ) => Promise<JourneyDraft | null>
  loadIsInternal: (userId: string) => Promise<boolean>
  /**
   * Server-only, non-identifying phase timing. It is intentionally optional so
   * deterministic loaders and the narrow Stage 2 authorization read stay silent.
   */
  reportStage3AccessTiming?: (timing: PersonalPlanStage3AccessTiming) => void
  now?: () => number
}

export type PersonalPlanStage3AccessTiming = {
  operation:
    | "stage3_access_entitlement"
    | "stage3_access_artifact_plan"
    | "stage3_access_refined_draft"
  outcome: string
  durationMs: number
}

export type PersonalPlanStage2Access = { allowed: boolean }

type JourneyAuthorizationPrefix =
  | { excludedByAppRollout: true }
  | {
      excludedByAppRollout: false
      appEnabled: boolean
      accessState: AccessState
      isNewBuyerCohort: boolean
      preparedSourceReady: boolean
      plan: JourneyPlanRow | null
    }

type JourneyAccessPhaseReporter = Pick<
  PersonalPlanJourneyAccessLoaderDeps,
  "reportStage3AccessTiming" | "now"
>

function reportJourneyAccessPhase(
  reporter: JourneyAccessPhaseReporter | undefined,
  timing: PersonalPlanStage3AccessTiming,
) {
  try {
    reporter?.reportStage3AccessTiming?.(timing)
  } catch {
    // Observability must never affect owner authorization or routing.
  }
}

function phaseStartedAt(reporter: JourneyAccessPhaseReporter | undefined): number {
  return reporter?.now?.() ?? performance.now()
}

function phaseElapsed(reporter: JourneyAccessPhaseReporter | undefined, startedAt: number): number {
  return (reporter?.now?.() ?? performance.now()) - startedAt
}

function isQualifiedOwnerCohort(
  qualifiedAt: string | null,
  cutoff: Date | null,
  sourceKind?: PersonalPlanEnrollmentSourceKind | null,
  migrationEnabled = false,
): boolean {
  if (!qualifiedAt) return false
  const parsed = new Date(qualifiedAt)
  if (Number.isNaN(parsed.getTime())) return false
  // `"freemium"` (T14) joins the non-billing-cohort kinds: the new-buyer cutoff exists to
  // keep pre-Personal-Plan *purchasers* out of the app journey, and a Premium-sheet
  // admission can only be created by this program's own post-cutoff code path — there is no
  // historical freemium cohort for it to admit by accident.
  return sourceKind === "field_test" ||
    sourceKind === "partner" ||
    sourceKind === "migration" ||
    sourceKind === "freemium"
    ? true
    : isMigrationPaidSource(sourceKind) && migrationEnabled
      ? true
      : Boolean(cutoff && parsed.getTime() >= cutoff.getTime())
}

function isMigrationPaidSource(sourceKind?: PersonalPlanEnrollmentSourceKind | null): boolean {
  return sourceKind === "one_time" || sourceKind === "launch_subscription"
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  )
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  )
  return sameJson(leftEntries, rightEntries)
}

function hasCurrentAuthority(
  draft: JourneyDraft | null,
  context: ReturnType<typeof buildStage3EntryContext>,
): boolean {
  if (!draft || draft.status === "stale" || !draft.authoritySnapshot) return false
  try {
    requireCurrentAuthoritySnapshot(draft)
  } catch {
    return false
  }

  const expected = context.authoritySnapshot
  const actual = draft.authoritySnapshot
  return (
    actual.refinedNeedVersionId === expected.refinedNeedVersionId &&
    actual.refinedInputHash === expected.refinedInputHash &&
    sameJson(actual.orderedCategories, expected.orderedCategories) &&
    sameJson(actual.categoryDecisions, expected.categoryDecisions) &&
    sameJson(actual.coverage, expected.coverage) &&
    sameStringRecord(actual.authorityVersions, expected.authorityVersions)
  )
}

/**
 * Shared owner-scoped authorization prefix. It intentionally reaches only the
 * facts common to Stage 2 and the full journey; later-stage authority work is
 * layered by the full loader below.
 */
async function loadJourneyAuthorizationPrefixWithDeps(
  deps: PersonalPlanJourneyAccessLoaderDeps,
  userId: string,
  reporter?: JourneyAccessPhaseReporter,
): Promise<JourneyAuthorizationPrefix> {
  if (!userId.trim() || userId === "user-id-required") {
    throw new Error("journey_access_user_required")
  }
  const appEnabled = deps.appEnabled()
  const appRollout = deps.appRollout()
  if (appEnabled && appRollout !== "all") {
    const isInternal = appRollout === "internal" ? await deps.loadIsInternal(userId) : false
    if (!canAccessPersonalPlanAppV1Rollout({ appEnabled, rollout: appRollout, isInternal })) {
      return { excludedByAppRollout: true }
    }
  }

  const entitlementStartedAt = phaseStartedAt(reporter)
  let entitlement: Awaited<ReturnType<PersonalPlanJourneyAccessLoaderDeps["loadEntitlement"]>>
  try {
    entitlement = await deps.loadEntitlement(userId)
  } catch (error) {
    reportJourneyAccessPhase(reporter, {
      operation: "stage3_access_entitlement",
      outcome: "error",
      durationMs: phaseElapsed(reporter, entitlementStartedAt),
    })
    throw error
  }
  const isNewBuyerCohort = isQualifiedOwnerCohort(
    entitlement.qualifiedAt,
    deps.cohortCutoff(),
    entitlement.sourceKind,
    deps.migrationEnabled?.() ?? false,
  )
  const entitlementEligible =
    entitlement.accessState === "active" && isNewBuyerCohort && Boolean(entitlement.artifactLeadId)
  reportJourneyAccessPhase(reporter, {
    operation: "stage3_access_entitlement",
    outcome: entitlementEligible ? "eligible" : "denied",
    durationMs: phaseElapsed(reporter, entitlementStartedAt),
  })
  if (!entitlementEligible) {
    return {
      excludedByAppRollout: false,
      appEnabled,
      accessState: entitlement.accessState,
      // Preserve the full journey's legacy classification for an enrollment
      // that is not attached to a prepared source, while Stage 2 still sees a
      // simple denied fact either way.
      isNewBuyerCohort:
        entitlement.accessState === "active"
          ? isNewBuyerCohort && Boolean(entitlement.artifactLeadId)
          : isNewBuyerCohort,
      preparedSourceReady: false,
      plan: null,
    }
  }

  // Start the independent owner reads together. Like the previous loader, an
  // unavailable artifact denies access without requiring the unused plan read.
  const artifactPlanStartedAt = phaseStartedAt(reporter)
  const planPending = deps.loadPlan(userId).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  )
  let artifact: { id: string } | null
  try {
    artifact = await deps.loadPreparedArtifact(
      userId,
      entitlement.artifactLeadId!,
      entitlement.quizSourceKind,
    )
  } catch (error) {
    reportJourneyAccessPhase(reporter, {
      operation: "stage3_access_artifact_plan",
      outcome: "error",
      durationMs: phaseElapsed(reporter, artifactPlanStartedAt),
    })
    throw error
  }
  if (!artifact) {
    reportJourneyAccessPhase(reporter, {
      operation: "stage3_access_artifact_plan",
      outcome: "artifact_missing",
      durationMs: phaseElapsed(reporter, artifactPlanStartedAt),
    })
    return {
      excludedByAppRollout: false,
      appEnabled,
      accessState: "active",
      isNewBuyerCohort: true,
      preparedSourceReady: false,
      plan: null,
    }
  }
  const planResult = await planPending
  if (planResult.status === "rejected") {
    reportJourneyAccessPhase(reporter, {
      operation: "stage3_access_artifact_plan",
      outcome: "error",
      durationMs: phaseElapsed(reporter, artifactPlanStartedAt),
    })
    throw planResult.reason
  }
  reportJourneyAccessPhase(reporter, {
    operation: "stage3_access_artifact_plan",
    outcome: planResult.value ? "ready" : "plan_missing",
    durationMs: phaseElapsed(reporter, artifactPlanStartedAt),
  })
  return {
    excludedByAppRollout: false,
    appEnabled,
    accessState: "active",
    isNewBuyerCohort: true,
    preparedSourceReady: true,
    plan: planResult.value ? { ...planResult.value } : null,
  }
}

/** Minimal per-request fact for Stage 2 routes. */
export async function loadPersonalPlanStage2AccessWithDeps(
  deps: PersonalPlanJourneyAccessLoaderDeps,
  userId = "user-id-required",
): Promise<PersonalPlanStage2Access> {
  const prefix = await loadJourneyAuthorizationPrefixWithDeps(deps, userId)
  if (prefix.excludedByAppRollout) return { allowed: false }
  return {
    allowed:
      prefix.appEnabled &&
      prefix.accessState === "active" &&
      prefix.isNewBuyerCohort &&
      prefix.preparedSourceReady &&
      Boolean(prefix.plan?.currentInitialNeedVersionId) &&
      deps.stage2Enabled(),
  }
}

/**
 * Server-only, owner-scoped source of journey reachability. This intentionally
 * throws on database or malformed-source failures so routes cannot accidentally
 * turn an unavailable authorization read into access.
 */
export async function loadPersonalPlanJourneyAccessWithDeps(
  deps: PersonalPlanJourneyAccessLoaderDeps,
  userId = "user-id-required",
): Promise<PersonalPlanJourneyAccess> {
  const reporter: JourneyAccessPhaseReporter = deps
  const prefix = await loadJourneyAuthorizationPrefixWithDeps(deps, userId, reporter)
  if (prefix.excludedByAppRollout) return { kind: "legacy" }

  if (prefix.accessState !== "active") {
    return resolvePersonalPlanJourneyAccess({
      accessState: prefix.accessState,
      isNewBuyerCohort: prefix.isNewBuyerCohort,
      appEnabled: prefix.appEnabled,
      stage2Enabled: deps.stage2Enabled(),
      stage3Enabled: deps.stage3Enabled(),
      stage4Enabled: deps.stage4Enabled(),
      stage5Allowed: false,
      preparedSourceReady: false,
      plan: null,
    })
  }

  if (!prefix.isNewBuyerCohort || !prefix.preparedSourceReady) {
    return resolvePersonalPlanJourneyAccess({
      accessState: "active",
      isNewBuyerCohort: prefix.isNewBuyerCohort,
      appEnabled: prefix.appEnabled,
      stage2Enabled: deps.stage2Enabled(),
      stage3Enabled: deps.stage3Enabled(),
      stage4Enabled: deps.stage4Enabled(),
      stage5Allowed: false,
      preparedSourceReady: false,
      plan: null,
    })
  }

  const plan = prefix.plan
  const stage2Enabled = deps.stage2Enabled()
  const stage3Enabled = deps.stage3Enabled()
  const stage4Enabled = deps.stage4Enabled()
  const stage5Allowed = canAccessPersonalPlanStage5({
    isEligiblePersonalPlanOwner: true,
  })

  let stage3AuthorityReady = false
  if (stage2Enabled && stage3Enabled && plan?.currentRefinedNeedVersionId) {
    const refinedDraftStartedAt = phaseStartedAt(reporter)
    try {
      const [refined, draft] = await Promise.all([
        deps.loadCurrentRefinedNeed(userId, plan.id, plan.currentRefinedNeedVersionId),
        deps.loadCurrentProductDraft(userId, plan.id, plan.currentRefinedNeedVersionId),
      ])
      if (!refined) throw new Error("journey_access_current_refined_unavailable")
      const context = buildStage3EntryContext(refined, {
        personalPlanId: plan.id,
        refinedVersionId: plan.currentRefinedNeedVersionId,
      })
      stage3AuthorityReady = !draft || hasCurrentAuthority(draft, context)
      plan.productDraftCompleted = draft?.status === "completed" && stage3AuthorityReady
      reportJourneyAccessPhase(reporter, {
        operation: "stage3_access_refined_draft",
        outcome: stage3AuthorityReady ? "ready" : "authority_stale",
        durationMs: phaseElapsed(reporter, refinedDraftStartedAt),
      })
    } catch (error) {
      reportJourneyAccessPhase(reporter, {
        operation: "stage3_access_refined_draft",
        outcome: "error",
        durationMs: phaseElapsed(reporter, refinedDraftStartedAt),
      })
      // A Routine that was explicitly accepted is immutable evidence for
      // Stage 4/5. A broken later successor must degrade Stage 3 only; an
      // unaccepted pending proposal remains fail-closed.
      if (!plan.activeRoutineVersionId) throw error
    }
  }

  return resolvePersonalPlanJourneyAccess({
    accessState: "active",
    isNewBuyerCohort: true,
    appEnabled: prefix.appEnabled,
    stage2Enabled,
    stage3Enabled,
    stage4Enabled,
    stage5Allowed,
    preparedSourceReady: true,
    stage3AuthorityReady,
    plan,
  })
}

type QueryResult = Promise<{ data: unknown; error: unknown }>
type QueryBuilder = {
  select: (columns: string) => QueryBuilder
  eq: (column: string, value: unknown) => QueryBuilder
  neq: (column: string, value: unknown) => QueryBuilder
  maybeSingle: () => QueryResult
}
export type PersonalPlanJourneyAccessSupabaseClient = {
  from: (table: string) => QueryBuilder
}

function required(result: QueryResult) {
  return result.then(({ data, error }) => {
    if (error) throw error
    return data as Record<string, unknown> | null
  })
}

export function createSupabasePersonalPlanJourneyAccessLoader(
  admin: PersonalPlanJourneyAccessSupabaseClient,
): PersonalPlanJourneyAccessLoaderDeps {
  return {
    reportStage3AccessTiming: (timing) =>
      reportPersonalPlanTransitionTiming({
        layer: "server",
        operation: timing.operation,
        outcome: timing.outcome,
        durationMs: timing.durationMs,
      }),
    async loadEntitlement(userId) {
      const enrollment = await findPersonalPlanEnrollmentForUser(admin as never, userId)
      return {
        accessState: enrollment.accessState,
        qualifiedAt: enrollment.qualifiedAt,
        artifactLeadId: enrollment.artifactLeadId,
        quizSourceKind: enrollment.quizSourceKind,
        sourceKind: enrollment.sourceKind,
      }
    },
    cohortCutoff: getPersonalPlanNewBuyerCohortCutoff,
    migrationEnabled: isPersonalPlanLegacyMigrationEnabled,
    appEnabled: isPersonalPlanAppV1Enabled,
    appRollout: resolvePersonalPlanAppV1Rollout,
    stage2Enabled: isPersonalPlanStage2Enabled,
    stage3Enabled: isPersonalPlanStage3Enabled,
    stage4Enabled: isPersonalPlanStage4Enabled,
    async loadPreparedArtifact(userId, leadId, quizSourceKind) {
      if (quizSourceKind === "legacy") {
        const lead = await required(
          admin
            .from("leads")
            .select("id")
            .eq("id", leadId)
            .eq("user_id", userId)
            .eq("quiz_kind", "legacy")
            .maybeSingle(),
        )
        return lead && typeof lead.id === "string" ? { id: lead.id } : null
      }
      const data = await required(
        admin
          .from("personal_plan_prepared_artifacts")
          .select("id")
          .eq("user_id", userId)
          .eq("lead_id", leadId)
          .eq("status", "attached")
          .maybeSingle(),
      )
      return data && typeof data.id === "string" ? { id: data.id } : null
    },
    async loadPlan(userId) {
      const data = await required(
        admin
          .from("personal_plans")
          .select(
            "id,current_initial_need_version_id,current_refined_need_version_id,pending_routine_proposal_id,active_routine_version_id",
          )
          .eq("user_id", userId)
          .maybeSingle(),
      )
      if (!data) return null
      if (typeof data.id !== "string") throw new Error("journey_access_plan_malformed")
      return {
        id: data.id,
        currentInitialNeedVersionId:
          typeof data.current_initial_need_version_id === "string"
            ? data.current_initial_need_version_id
            : null,
        currentRefinedNeedVersionId:
          typeof data.current_refined_need_version_id === "string"
            ? data.current_refined_need_version_id
            : null,
        productDraftCompleted: false,
        pendingRoutineProposalId:
          typeof data.pending_routine_proposal_id === "string"
            ? data.pending_routine_proposal_id
            : null,
        activeRoutineVersionId:
          typeof data.active_routine_version_id === "string"
            ? data.active_routine_version_id
            : null,
      }
    },
    async loadCurrentRefinedNeed(userId, planId, refinedVersionId) {
      const data = await required(
        admin
          .from("personal_plan_need_versions")
          .select("output_snapshot")
          .eq("id", refinedVersionId)
          .eq("user_id", userId)
          .eq("personal_plan_id", planId)
          .eq("kind", "refined")
          .maybeSingle(),
      )
      return (data?.output_snapshot as InitialNeedPlanSnapshot | undefined) ?? null
    },
    async loadCurrentProductDraft(userId, planId, refinedVersionId) {
      const data = await required(
        admin
          .from("personal_plan_product_drafts")
          .select("status,refined_need_version_id,category_authority_versions,payload")
          .eq("user_id", userId)
          .eq("personal_plan_id", planId)
          .eq("refined_need_version_id", refinedVersionId)
          .neq("status", "stale")
          .maybeSingle(),
      )
      if (!data) return null
      const payload = data.payload
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("journey_access_draft_malformed")
      }
      const status = data.status
      if (status !== "active" && status !== "completed" && status !== "stale") {
        throw new Error("journey_access_draft_malformed")
      }
      const refined = data.refined_need_version_id
      if (typeof refined !== "string") throw new Error("journey_access_draft_malformed")
      const payloadRecord = payload as Record<string, unknown>
      return {
        status,
        refinedVersionId: refined,
        orderedCategories: Array.isArray(payloadRecord.orderedCategories)
          ? (payloadRecord.orderedCategories as Stage3ProductDraft["orderedCategories"])
          : [],
        authorityVersions: (data.category_authority_versions ??
          {}) as Stage3ProductDraft["authorityVersions"],
        authoritySnapshot: (payloadRecord.authoritySnapshot ??
          undefined) as Stage3ProductDraft["authoritySnapshot"],
        productLoadResolution: payloadRecord.productLoadResolution as
          | Stage3ProductDraft["productLoadResolution"]
          | undefined,
        products: Array.isArray(payloadRecord.products)
          ? (payloadRecord.products as Stage3ProductDraft["products"])
          : [],
        roleAssignments: Array.isArray(payloadRecord.roleAssignments)
          ? (payloadRecord.roleAssignments as Stage3ProductDraft["roleAssignments"])
          : [],
      }
    },
    async loadIsInternal(userId) {
      return isPersonalPlanInternalUser(userId, admin as unknown as PersonalPlanInternalUserClient)
    },
  }
}

export function loadPersonalPlanJourneyAccessForUser(
  userId: string,
): Promise<PersonalPlanJourneyAccess> {
  return loadPersonalPlanJourneyAccessWithDeps(
    createSupabasePersonalPlanJourneyAccessLoader(
      createAdminClient() as unknown as PersonalPlanJourneyAccessSupabaseClient,
    ),
    userId,
  )
}

export function loadPersonalPlanStage2AccessForUser(
  userId: string,
): Promise<PersonalPlanStage2Access> {
  return loadPersonalPlanStage2AccessWithDeps(
    createSupabasePersonalPlanJourneyAccessLoader(
      createAdminClient() as unknown as PersonalPlanJourneyAccessSupabaseClient,
    ),
    userId,
  )
}
