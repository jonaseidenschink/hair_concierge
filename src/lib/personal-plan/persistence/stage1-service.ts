import { computeNeedPlan } from "../compute-stage1"
import { buildLegacyQuizStage1Source } from "../input"
import type { QuizAnswers } from "@/lib/quiz/types"
import { hashPersonalPlanNeedVersionInput, type JsonValue } from "./index"

export const PERSONAL_PLAN_STAGE1_COMPUTATION_VERSION = "stage1-v1"

export type Stage1Entitlement = {
  accessState: "active" | "paid_pending" | "none" | "revoked"
  enrollmentSourceId: string | null
  qualifiedAt: string | null
  artifactLeadId: string | null
  quizSourceKind?: "personal_plan" | "legacy" | null
  /**
   * `"freemium"` is the T14 Premium-sheet admission (see
   * `src/lib/personal-plan/freemium-enrollment.ts`); it is cohort-qualified for the same
   * reason `"field_test"`/`"partner"`/`"migration"` are — there is no historical cohort of
   * freemium buyers the new-buyer cutoff needs to keep out.
   */
  sourceKind?:
    | "one_time"
    | "launch_subscription"
    | "field_test"
    | "partner"
    | "migration"
    | "freemium"
    | null
}

export type Stage1PreparedArtifact = {
  id: string
  quizAnswers: unknown
}

export type Stage1LegacyLead = {
  id: string
  quizAnswers: QuizAnswers
}

export type CreateInitialNeedRequest = {
  userId: string
  enrollmentPurchaseSourceId: string
  preparedArtifactSourceId: string | null
  stage1SourceKind: "personal_plan_artifact" | "legacy_quiz_lead"
  stage1SourceLeadId: string | null
  schemaVersion: number
  computationVersion: string
  inputHash: string
  inputSnapshot: JsonValue
  outputSnapshot: JsonValue
}

export type CreateInitialNeedResult =
  | {
      outcome: "completed"
      personalPlanId: string
      needVersionId: string
      outputSnapshot: JsonValue
    }
  | { outcome: "invalid_source"; reasonCode?: string }
  | { outcome: "temporarily_unavailable" }

export type Stage1PersistenceDependencies = {
  isEnabled: () => boolean
  migrationEnabled?: () => boolean
  cohortCutoff: () => Date | null
  findEntitlement: (userId: string) => Promise<Stage1Entitlement>
  loadExistingMigrationPlan?: (
    userId: string,
    enrollmentId: string,
  ) => Promise<Extract<Stage1LoadOrCreateResult, { status: "completed" }> | null>
  loadArtifact: (userId: string, artifactLeadId: string) => Promise<Stage1PreparedArtifact | null>
  loadLegacyLead?: (userId: string, leadId: string) => Promise<Stage1LegacyLead | null>
  createOrReuseInitialNeed: (request: CreateInitialNeedRequest) => Promise<CreateInitialNeedResult>
  now?: () => Date
}

export type Stage1LoadOrCreateResult =
  | {
      status: "completed"
      personalPlanId: string
      needVersionId: string
      outputSnapshot: JsonValue
    }
  | {
      status:
        | "personal_plan_not_available"
        | "activation_pending"
        | "invalid_source"
        | "temporarily_unavailable"
    }

export function createStage1PersistenceService(deps: Stage1PersistenceDependencies) {
  return {
    async loadOrCreate({ userId }: { userId: string }): Promise<Stage1LoadOrCreateResult> {
      // The disabled feature must be inert: no entitlement/artifact reads and no writes.
      if (!deps.isEnabled()) return { status: "personal_plan_not_available" }

      let entitlement: Stage1Entitlement
      try {
        entitlement = await deps.findEntitlement(userId)
      } catch {
        return { status: "temporarily_unavailable" }
      }

      if (entitlement.accessState === "paid_pending") return { status: "activation_pending" }
      if (
        !isEligibleQualifiedOwner(
          entitlement,
          deps.cohortCutoff(),
          deps.migrationEnabled?.() ?? false,
        )
      ) {
        return { status: "personal_plan_not_available" }
      }

      if (entitlement.sourceKind === "migration" && deps.loadExistingMigrationPlan) {
        try {
          const existing = await deps.loadExistingMigrationPlan(
            userId,
            entitlement.enrollmentSourceId!,
          )
          if (existing) return existing
        } catch {
          return { status: "temporarily_unavailable" }
        }
      }

      let artifact: Stage1PreparedArtifact | null = null
      let legacyLead: Stage1LegacyLead | null = null
      try {
        if (entitlement.quizSourceKind === "legacy") {
          legacyLead = (await deps.loadLegacyLead?.(userId, entitlement.artifactLeadId!)) ?? null
        } else {
          artifact = await deps.loadArtifact(userId, entitlement.artifactLeadId!)
        }
      } catch {
        return { status: "temporarily_unavailable" }
      }
      if (!artifact && !legacyLead) return { status: "activation_pending" }

      const stage1Source = legacyLead
        ? buildLegacyQuizStage1Source({ leadId: legacyLead.id, answers: legacyLead.quizAnswers })
        : artifact!.quizAnswers
      const sourceId = legacyLead?.id ?? artifact!.id

      const computed = computeNeedPlan({
        rawEnvelope: stage1Source,
        artifactId: sourceId,
        projection: "initial_quiz",
        computationVersion: PERSONAL_PLAN_STAGE1_COMPUTATION_VERSION,
        createdAt: (deps.now ?? (() => new Date()))().toISOString(),
      })
      if (computed.status !== "ready") return { status: "invalid_source" }

      const inputSnapshot = computed.snapshot.sourceQuiz as unknown as JsonValue
      const outputSnapshot = computed.snapshot as unknown as JsonValue
      const request: CreateInitialNeedRequest = {
        userId,
        enrollmentPurchaseSourceId: entitlement.enrollmentSourceId!,
        preparedArtifactSourceId: artifact?.id ?? null,
        stage1SourceKind: legacyLead ? "legacy_quiz_lead" : "personal_plan_artifact",
        stage1SourceLeadId: legacyLead?.id ?? null,
        schemaVersion: computed.snapshot.schemaVersion,
        computationVersion: computed.snapshot.computationVersion,
        inputHash: hashPersonalPlanNeedVersionInput({
          schemaVersion: computed.snapshot.schemaVersion,
          computationVersion: computed.snapshot.computationVersion,
          inputSnapshot,
        }),
        inputSnapshot,
        outputSnapshot,
      }

      let result: CreateInitialNeedResult
      try {
        result = await deps.createOrReuseInitialNeed(request)
      } catch {
        return { status: "temporarily_unavailable" }
      }
      if (result.outcome === "completed") {
        return {
          status: "completed",
          personalPlanId: result.personalPlanId,
          needVersionId: result.needVersionId,
          outputSnapshot: result.outputSnapshot,
        }
      }
      return { status: result.outcome }
    },
  }
}

function isEligibleQualifiedOwner(
  entitlement: Stage1Entitlement,
  cutoff: Date | null,
  migrationEnabled: boolean,
): boolean {
  if (
    entitlement.accessState !== "active" ||
    !entitlement.enrollmentSourceId ||
    !entitlement.qualifiedAt ||
    !entitlement.artifactLeadId
  )
    return false
  const qualifiedAt = new Date(entitlement.qualifiedAt)
  if (Number.isNaN(qualifiedAt.getTime())) return false
  return entitlement.sourceKind === "field_test" ||
    entitlement.sourceKind === "partner" ||
    entitlement.sourceKind === "migration" ||
    entitlement.sourceKind === "freemium"
    ? true
    : isMigrationPaidSource(entitlement.sourceKind) && migrationEnabled
      ? true
      : Boolean(cutoff && qualifiedAt.getTime() >= cutoff.getTime())
}

function isMigrationPaidSource(sourceKind: Stage1Entitlement["sourceKind"]): boolean {
  return sourceKind === "one_time" || sourceKind === "launch_subscription"
}
