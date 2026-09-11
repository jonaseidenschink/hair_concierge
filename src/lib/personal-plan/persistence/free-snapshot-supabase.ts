import type { SupabaseBillingClient } from "@/lib/billing/types"
import { resolvePaidAppAccess } from "@/lib/entitlements/access"

import type { FreeInitialNeedRequest, FreeSnapshotDependencies } from "./free-snapshot-service"
import type { CreateInitialNeedResult, Stage1PreparedArtifact } from "./stage1-service"

type ArtifactQuery = {
  select: (columns: string) => ArtifactQuery
  eq: (column: string, value: string) => ArtifactQuery
  order: (column: string, options: { ascending: boolean }) => ArtifactQuery
  limit: (count: number) => ArtifactQuery
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>
}

type AdminClient = {
  from: (table: "personal_plan_prepared_artifacts") => ArtifactQuery
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>
}

/**
 * Server-only persistence wiring for the free-tier snapshot path. See the
 * ownership-contract comment at the top of `free-snapshot-service.ts` for who
 * writes what and when. Reuses the exact same
 * `personal_plan_create_or_reuse_initial_need` RPC the paid path calls
 * (`stage1-supabase.ts`), passing a `null` enrollment id — the RPC already
 * treats that as a valid, idempotent source key.
 */
export function createFreeSnapshotSupabaseDependencies(
  admin: AdminClient,
): FreeSnapshotDependencies {
  return {
    async loadLinkedQuizArtifact(userId): Promise<Stage1PreparedArtifact | null> {
      const { data, error } = await admin
        .from("personal_plan_prepared_artifacts")
        .select("id, quiz_answers")
        .eq("user_id", userId)
        .eq("status", "attached")
        .order("attached_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) throw error
      if (!data || typeof data !== "object") return null
      const row = data as { id?: unknown; quiz_answers?: unknown }
      if (typeof row.id !== "string") return null
      return { id: row.id, quizAnswers: row.quiz_answers }
    },
    createOrReuseInitialNeed: (request) => callCreateFreeInitialNeed(admin, request),
    // The SAME flag-independent paid-access composite `hasFreemiumPaidAccess`
    // (src/lib/entitlements/access.ts) runs once its own flag check passes:
    // billing subscription OR active one-time purchase OR legacy-profile
    // access OR an email-keyed manual access grant (`hasCurrentAppAccess`) OR
    // active moderator/field-test roster access (`resolveModeratorAccess`).
    // `fieldTestGuest` is passed as `false` — unlike a route request, this
    // provisioning call has no independent signal that the caller is a known
    // field-test guest, so the moderator lookup always runs; an unreadable
    // lookup surfaces as `"unavailable"` and the service fails closed
    // (`temporarily_unavailable`) rather than risk misrouting a real
    // moderator/field-test user onto the free path (see the ownership
    // contract in `free-snapshot-service.ts`).
    resolvePaidAccess: (userId, email) =>
      resolvePaidAppAccess(userId, email, false, {
        client: admin as unknown as SupabaseBillingClient,
      }),
  }
}

async function callCreateFreeInitialNeed(
  admin: AdminClient,
  request: FreeInitialNeedRequest,
): Promise<CreateInitialNeedResult> {
  const { data, error } = await admin.rpc("personal_plan_create_or_reuse_initial_need", {
    p_user_id: request.userId,
    p_enrollment_purchase_source_id: null,
    p_prepared_artifact_source_id: request.preparedArtifactSourceId,
    p_schema_version: request.schemaVersion,
    p_computation_version: request.computationVersion,
    p_input_hash: request.inputHash,
    p_input_snapshot: request.inputSnapshot,
    p_output_snapshot: request.outputSnapshot,
    p_stage1_source_kind: "personal_plan_artifact",
    p_stage1_source_lead_id: null,
  })
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
