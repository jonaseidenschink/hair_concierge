import type { SupabaseClient } from "@supabase/supabase-js"

import {
  advancePlanChange,
  clearPendingPlanChangeMetadata,
  findPlanChangeByOperationId,
  findStalePendingPayPalPlanChanges,
  mergePendingPlanChangeMetadata,
  recordPlanChangePhase,
} from "@/lib/billing/plan-change"
import type { BillingPlanChangeRow, BillingSubscriptionRow } from "@/lib/billing/types"
type VerifyApprovedPlanChange = (input: {
  subscriptionId: string
  targetPlanId: string
  targetInterval: BillingPlanChangeRow["target_interval"]
}) => Promise<unknown>

type StalePlanChangeDeps = {
  findStale?: typeof findStalePendingPayPalPlanChanges
  verifyApproved?: VerifyApprovedPlanChange
  advance?: typeof advancePlanChange
  findByOperationId?: typeof findPlanChangeByOperationId
  mergeMetadata?: typeof mergePendingPlanChangeMetadata
  clearMetadata?: typeof clearPendingPlanChangeMetadata
  recordPhase?: typeof recordPlanChangePhase
}

export async function reconcileStalePayPalPlanChanges(
  supabase: SupabaseClient,
  subscription: BillingSubscriptionRow,
  options: { now?: Date; deps?: StalePlanChangeDeps } = {},
): Promise<BillingPlanChangeRow[]> {
  const deps = options.deps ?? {}
  const stale = await (deps.findStale ?? findStalePendingPayPalPlanChanges)(
    supabase,
    subscription.id,
    options.now,
  )
  const reconciled: BillingPlanChangeRow[] = []

  for (const operation of stale) {
    if (!operation.provider_target_id) {
      reconciled.push(operation)
      continue
    }

    try {
      const verifyApproved = deps.verifyApproved ?? defaultVerifyApprovedPayPalPlanChange
      await verifyApproved({
        subscriptionId: subscription.provider_subscription_id,
        targetPlanId: operation.provider_target_id,
        targetInterval: operation.target_interval,
      })
    } catch {
      // A plan mismatch only proves that buyer approval has not completed yet.
      // Keep the stored approval URL actionable instead of unlocking a second,
      // potentially conflicting PayPal revision.
      reconciled.push(operation)
      continue
    }

    let advanced: BillingPlanChangeRow
    try {
      advanced = await (deps.advance ?? advancePlanChange)(supabase, {
        operationId: operation.operation_id,
        expectedStatus: "pending_approval",
        status: "scheduled",
        failureCode: null,
      })
    } catch (error) {
      const current = await (deps.findByOperationId ?? findPlanChangeByOperationId)(
        supabase,
        operation.operation_id,
        operation.user_id,
      ).catch(() => null)
      if (!current || current.status === "pending_approval") throw error
      advanced = current
    }

    if (advanced.status === "scheduled") {
      await (deps.mergeMetadata ?? mergePendingPlanChangeMetadata)(
        supabase,
        subscription,
        advanced,
      ).catch(() => undefined)
      await (deps.recordPhase ?? recordPlanChangePhase)(supabase, advanced, "approved").catch(
        () => undefined,
      )
    } else if (advanced.status === "failed") {
      await (deps.clearMetadata ?? clearPendingPlanChangeMetadata)(supabase, subscription).catch(
        () => undefined,
      )
    }
    reconciled.push(advanced)
  }

  return reconciled
}

async function defaultVerifyApprovedPayPalPlanChange(
  input: Parameters<VerifyApprovedPlanChange>[0],
): Promise<unknown> {
  const { verifyApprovedPayPalPlanChange } = await import("./subscription-plan-change")
  return verifyApprovedPayPalPlanChange(input)
}
