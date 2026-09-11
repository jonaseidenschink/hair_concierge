import "server-only"

import {
  acceptIdealPlan,
  DirectAcceptanceError,
} from "@/lib/personal-plan/direct-acceptance/accept"
import { FREEMIUM_PLAN_ADMISSIONS_TABLE } from "@/lib/personal-plan/freemium-enrollment"
import { createSupabaseStage2RefinementPersistence } from "@/lib/personal-plan/persistence/stage2-refinement-supabase"
import type { CreateInitialNeedResult } from "@/lib/personal-plan/persistence/stage1-service"
import { createProductionStage3ProductsGateway } from "@/lib/personal-plan/products/production-persistence-gateway"
import { createSupabaseStage3ProductionPersistence } from "@/lib/personal-plan/products/stage3-persistence-supabase"
import {
  isPersonalPlanStage2Enabled,
  isPersonalPlanStage3Enabled,
  isPersonalPlanStage4Enabled,
} from "@/lib/personal-plan/release"
import { createInitialRoutineCandidateCompiler } from "@/lib/personal-plan/routine-candidate-compiler"
import {
  createRoutineProposalStagerRpcAdapter,
  type RoutineProposalRpcClient,
} from "@/lib/personal-plan/routine-proposal-stager"
import {
  createSupabaseRoutineCadenceAuthorityReader,
  type RoutineCadenceAuthorityReadClient,
} from "@/lib/personal-plan/routine/cadence-authority"

import type {
  AcceptInitialRoutineResult,
  FreemiumPlanArtifact,
  FreemiumProvisioningDependencies,
  PinEnrollmentSourceResult,
} from "./plan-provisioning"

/**
 * Server-only wiring for `createFreemiumProvisioningService`. Nothing here decides policy —
 * see the ownership contract at the top of `plan-provisioning.ts`.
 */

type QueryResult = { data: unknown; error: unknown }

/**
 * The narrow, self-returning slice of the Supabase builder this file actually uses — the
 * same hand-rolled-shape convention as `stage1-supabase.ts` / `free-snapshot-supabase.ts`,
 * so the admin client is bridged with one cast at the call site instead of `any` here.
 */
type ProvisioningQuery = {
  select: (columns: string) => ProvisioningQuery
  insert: (values: Record<string, unknown>) => ProvisioningQuery
  update: (values: Record<string, unknown>) => ProvisioningQuery
  eq: (column: string, value: unknown) => ProvisioningQuery
  is: (column: string, value: unknown) => ProvisioningQuery
  order: (column: string, options: { ascending: boolean }) => ProvisioningQuery
  limit: (count: number) => ProvisioningQuery
  maybeSingle: () => Promise<QueryResult>
  then: (
    onfulfilled: (value: QueryResult) => unknown,
    onrejected?: (reason: unknown) => unknown,
  ) => Promise<unknown>
}

type ProvisioningAdminClient = {
  from: (table: string) => ProvisioningQuery
  rpc: (name: string, args: Record<string, unknown>) => Promise<QueryResult>
}

export function createFreemiumProvisioningSupabaseDependencies(
  admin: ProvisioningAdminClient,
): FreemiumProvisioningDependencies {
  return {
    async loadLinkedQuizArtifact(userId): Promise<FreemiumPlanArtifact | null> {
      // Same read T6's free path uses (`free-snapshot-supabase.ts`), plus `lead_id`, which
      // admission has to record for the journey loader's artifact lookup.
      const { data, error } = await admin
        .from("personal_plan_prepared_artifacts")
        .select("id, lead_id, quiz_answers")
        .eq("user_id", userId)
        .eq("status", "attached")
        .order("attached_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) throw error
      if (!data || typeof data !== "object") return null
      const row = data as { id?: unknown; lead_id?: unknown; quiz_answers?: unknown }
      if (typeof row.id !== "string" || typeof row.lead_id !== "string") return null
      return { id: row.id, leadId: row.lead_id, quizAnswers: row.quiz_answers }
    },

    async ensureAdmission({ userId, provider, providerReference, leadId }) {
      // Idempotent by the table's UNIQUE(user_id): a webhook replay, a repeated completion
      // callback and a refresh-during-pending all converge on the same row — and therefore
      // the same enrollment source id, which is what keeps the plan's pin stable.
      const existing = await readAdmissionId(admin, userId)
      if (existing) return { id: existing }
      const { data, error } = await admin
        .from(FREEMIUM_PLAN_ADMISSIONS_TABLE)
        .insert({
          user_id: userId,
          provider,
          provider_reference: providerReference,
          lead_id: leadId,
        })
        .select("id")
        .maybeSingle()
      if (!error && data && typeof (data as { id?: unknown }).id === "string") {
        return { id: (data as { id: string }).id }
      }
      // A concurrent writer won the unique index — re-read rather than fail the purchase.
      const recovered = await readAdmissionId(admin, userId)
      if (recovered) return { id: recovered }
      throw error ?? new Error("freemium_admission_unavailable")
    },

    async pinEnrollmentSource({ userId, enrollmentSourceId }): Promise<PinEnrollmentSourceResult> {
      // One conditional statement, not read-then-write: `.is(…, null)` makes the UPDATE
      // itself the race winner, so two concurrent provisioning runs cannot both "pin".
      const { data: updated, error: updateError } = await admin
        .from("personal_plans")
        .update({ enrollment_purchase_source_id: enrollmentSourceId })
        .eq("user_id", userId)
        .is("enrollment_purchase_source_id", null)
        .select("id")
      if (updateError) throw updateError
      if (Array.isArray(updated) && updated.length > 0) return "pinned"

      const { data, error } = await admin
        .from("personal_plans")
        .select("enrollment_purchase_source_id")
        .eq("user_id", userId)
        .maybeSingle()
      if (error) throw error
      if (!data) return "no_plan"
      const current = (data as { enrollment_purchase_source_id?: unknown })
        .enrollment_purchase_source_id
      if (current === enrollmentSourceId) return "already_pinned"
      // `null` here means the row vanished between the two statements; treat it as a
      // conflict rather than retrying blindly.
      return "conflict"
    },

    createOrReuseInitialNeed: (request) =>
      callCreateInitialNeed(admin, {
        p_user_id: request.userId,
        p_enrollment_purchase_source_id: request.enrollmentPurchaseSourceId,
        p_prepared_artifact_source_id: request.preparedArtifactSourceId,
        p_schema_version: request.schemaVersion,
        p_computation_version: request.computationVersion,
        p_input_hash: request.inputHash,
        p_input_snapshot: request.inputSnapshot,
        p_output_snapshot: request.outputSnapshot,
        p_stage1_source_kind: "personal_plan_artifact",
        p_stage1_source_lead_id: null,
      }),

    acceptInitialRoutine: (userId) => acceptInitialRoutineForUser(admin, userId),
  }
}

async function readAdmissionId(
  admin: ProvisioningAdminClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from(FREEMIUM_PLAN_ADMISSIONS_TABLE)
    .select("id")
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw error
  const id = (data as { id?: unknown } | null)?.id
  return typeof id === "string" ? id : null
}

async function callCreateInitialNeed(
  admin: ProvisioningAdminClient,
  args: Record<string, unknown>,
): Promise<CreateInitialNeedResult> {
  const { data, error } = await admin.rpc("personal_plan_create_or_reuse_initial_need", args)
  if (error || !data || typeof data !== "object") return { outcome: "temporarily_unavailable" }
  const result = data as Record<string, unknown>
  if (
    result.outcome === "completed" &&
    typeof result.personalPlanId === "string" &&
    typeof result.needVersionId === "string" &&
    result.outputSnapshot !== null &&
    typeof result.outputSnapshot === "object"
  ) {
    return {
      outcome: "completed",
      personalPlanId: result.personalPlanId,
      needVersionId: result.needVersionId,
      outputSnapshot: result.outputSnapshot as never,
    }
  }
  if (result.outcome === "invalid_source") {
    return {
      outcome: "invalid_source",
      ...(typeof result.reasonCode === "string" ? { reasonCode: result.reasonCode } : {}),
    }
  }
  return { outcome: "temporarily_unavailable" }
}

/**
 * Runs the SAME headless acceptance the `/api/personal-plan/accept-ideal-plan` route runs
 * — identical gateway composition, identical guards — in `"server_recommended"` mode, so
 * the buyer's Routine is built by the production Stage-2/3/4 path and by nothing else.
 */
async function acceptInitialRoutineForUser(
  admin: ProvisioningAdminClient,
  userId: string,
): Promise<AcceptInitialRoutineResult> {
  try {
    await acceptIdealPlan(
      {
        userId,
        flags: {
          stage2Enabled: isPersonalPlanStage2Enabled(),
          stage3Enabled: isPersonalPlanStage3Enabled(),
          stage4Enabled: isPersonalPlanStage4Enabled(),
        },
        refinementPersistence: createSupabaseStage2RefinementPersistence(admin as never),
        planState: {
          async loadActiveRoutineVersionId({ personalPlanId }) {
            const { data, error } = await admin
              .from("personal_plans")
              .select("active_routine_version_id")
              .eq("id", personalPlanId)
              .eq("user_id", userId)
              .maybeSingle()
            if (error || !data) throw new Error("freemium_accept_plan_state_unavailable")
            const activeRoutineVersionId = (data as { active_routine_version_id?: unknown })
              .active_routine_version_id
            return activeRoutineVersionId ? String(activeRoutineVersionId) : null
          },
        },
        stage3Gateway: createProductionStage3ProductsGateway({
          userId,
          persistence: createSupabaseStage3ProductionPersistence(admin as never),
          compiler: createInitialRoutineCandidateCompiler(),
          cadenceAuthorityReader: createSupabaseRoutineCadenceAuthorityReader(
            admin as unknown as RoutineCadenceAuthorityReadClient,
          ),
          stager: createRoutineProposalStagerRpcAdapter({
            client: admin as unknown as RoutineProposalRpcClient,
          }),
        }),
      },
      { seenRoles: [], roleSelection: "server_recommended" },
    )
    return "accepted"
  } catch (error) {
    return classifyRoutineAcceptanceFailure(error, () => hasActiveRoutineVersion(admin, userId))
  }
}

/**
 * What an `acceptIdealPlan` failure means for the buyer's Routine (Codex fix wave, Y2).
 *
 * Exported for its own test: this mapping is the difference between telling a buyer their
 * Routine is ready and telling them it is still being built, and getting it wrong in the
 * optimistic direction is a lie the whole provisioning contract rests on.
 *
 * `confirmActiveRoutine` answers "does this plan carry an active routine version RIGHT
 * NOW?", with `null` for "the read could not say".
 */
export async function classifyRoutineAcceptanceFailure(
  error: unknown,
  confirmActiveRoutine: () => Promise<boolean | null>,
): Promise<AcceptInitialRoutineResult> {
  if (!(error instanceof DirectAcceptanceError)) {
    console.warn("[freemium] post-purchase routine acceptance unavailable", { code: "unknown" })
    return "unavailable"
  }

  // A Routine this flow did not create is not a failure — the buyer already has one, and
  // overwriting it is exactly what the guard exists to prevent. `plan_already_accepted` is
  // raised only AFTER `loadActiveRoutineVersionId` returned an id, so it is proof.
  if (error.code === "plan_already_accepted") return "already_accepted"

  // `conflict` and `refinement_in_progress` are NOT proof. For a card payment the two
  // provisioning lanes — the in-sheet completion and `checkout.session.completed` — enter
  // `acceptIdealPlan` within the same second, so a conflict is the LIKELY path rather than
  // an exotic one. But `accept.ts:430` also raises `conflict` from the very FIRST Stage-2
  // save, before any Routine exists: the loser of that race would report a ready Routine
  // while the winner is still mid-flight — or has since failed. So the persisted activation
  // is confirmed before readiness is claimed.
  if (error.code === "conflict" || error.code === "refinement_in_progress") {
    const active = await confirmActiveRoutine()
    if (active === true) return "already_accepted"
    console.info("[freemium] post-purchase routine acceptance still in flight", {
      code: error.code,
      activationConfirmed: active,
    })
    // `null` (the confirming read itself failed) lands here too: an unconfirmed Routine is
    // reported as not ready, never as ready.
    return "in_progress"
  }

  console.warn("[freemium] post-purchase routine acceptance unavailable", { code: error.code })
  return "unavailable"
}

/**
 * Does this user's plan carry an ACTIVE routine version right now? `null` when the read
 * itself could not answer — the caller must treat that as "not confirmed", never as "yes".
 */
async function hasActiveRoutineVersion(
  admin: ProvisioningAdminClient,
  userId: string,
): Promise<boolean | null> {
  try {
    const { data, error } = await admin
      .from("personal_plans")
      .select("active_routine_version_id")
      .eq("user_id", userId)
      .maybeSingle()
    if (error) return null
    if (!data) return false
    const activeRoutineVersionId = (data as { active_routine_version_id?: unknown })
      .active_routine_version_id
    return typeof activeRoutineVersionId === "string" && activeRoutineVersionId.length > 0
  } catch {
    return null
  }
}
