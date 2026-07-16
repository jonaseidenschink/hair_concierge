import type { SupabaseClient } from "@supabase/supabase-js"
import { recordBillingAnalyticsEvent } from "./analytics-outbox"
import type {
  BillingInterval,
  BillingPlanChangeRow,
  BillingPlanChangeStatus,
  BillingSubscriptionRow,
  MembershipManagementState,
} from "./types"

const OPEN_PLAN_CHANGE_STATUSES: BillingPlanChangeStatus[] = [
  "pending_provider",
  "pending_approval",
  "scheduled",
  "reconciling",
]
const PAYPAL_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000

export function shouldRetainPlanChangeOperationId(status: string | undefined) {
  return OPEN_PLAN_CHANGE_STATUSES.includes(status as BillingPlanChangeStatus)
}

export class PlanChangeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = "PlanChangeError"
  }
}

export function buildMembershipManagementState(input: {
  subscription: BillingSubscriptionRow | null
  operation?: BillingPlanChangeRow | null
  manualGrantEnd?: string | null
  legacyAccessEnd?: string | null
}): MembershipManagementState {
  const { subscription, operation, manualGrantEnd, legacyAccessEnd } = input
  if (!subscription) {
    if (manualGrantEnd !== undefined) return { kind: "manual_grant", renewalAt: manualGrantEnd }
    if (legacyAccessEnd !== undefined)
      return { kind: "legacy_unmanageable", renewalAt: legacyAccessEnd }
    return { kind: "uncertain" }
  }

  const shared = {
    provider: subscription.provider,
    currentInterval: subscription.interval,
    renewalAt: subscription.current_period_end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  }

  if (subscription.cancel_at_period_end || subscription.entitlement_status === "canceled") {
    return {
      kind: "canceled_at_period_end",
      ...shared,
      cancelAtPeriodEnd: true,
    }
  }
  if (
    subscription.entitlement_status !== "active" ||
    !isProviderStatusManageable(subscription.provider, subscription.provider_status)
  ) {
    return { kind: "payment_problem", ...shared }
  }
  if (!subscription.interval || !subscription.current_period_end) {
    return { kind: "legacy_unmanageable", renewalAt: subscription.current_period_end }
  }
  if (operation?.status === "reconciling" || operation?.status === "pending_provider") {
    return {
      kind: "reconciling",
      provider: subscription.provider,
      currentInterval: subscription.interval,
      renewalAt: subscription.current_period_end,
      cancelAtPeriodEnd: false,
      targetInterval: operation.target_interval,
      effectiveAt: operation.effective_at,
      operationId: operation.operation_id,
      retryable: operation.status === "pending_provider" || subscription.provider === "stripe",
    }
  }
  if (operation && OPEN_PLAN_CHANGE_STATUSES.includes(operation.status)) {
    const approvalUrl =
      operation.status === "pending_approval" &&
      typeof operation.metadata?.approval_url === "string"
        ? operation.metadata.approval_url
        : undefined
    return {
      kind: "pending",
      provider: subscription.provider,
      currentInterval: subscription.interval,
      renewalAt: subscription.current_period_end,
      cancelAtPeriodEnd: false,
      targetInterval: operation.target_interval,
      effectiveAt: operation.effective_at,
      ...(approvalUrl ? { approvalUrl } : {}),
    }
  }
  return {
    kind: "manageable",
    provider: subscription.provider,
    currentInterval: subscription.interval,
    renewalAt: subscription.current_period_end,
    cancelAtPeriodEnd: false,
  }
}

export function assertPlanChangeEligible(
  subscription: BillingSubscriptionRow,
  targetInterval: BillingInterval,
): asserts subscription is BillingSubscriptionRow & {
  interval: BillingInterval
  current_period_end: string
} {
  if (subscription.entitlement_status !== "active") {
    throw new PlanChangeError("payment_problem", "Die Zahlung muss zuerst geklärt werden.")
  }
  if (subscription.cancel_at_period_end) {
    throw new PlanChangeError(
      "cancellation_scheduled",
      "Ein gekündigtes Abo kann nicht automatisch wieder verlängert werden.",
    )
  }
  if (!isProviderStatusManageable(subscription.provider, subscription.provider_status)) {
    throw new PlanChangeError(
      "provider_status_unmanageable",
      "Dieses Abo kann nicht geändert werden.",
    )
  }
  if (!subscription.interval || !subscription.current_period_end) {
    throw new PlanChangeError("legacy_unmanageable", "Für dieses Abo fehlen Verwaltungsdaten.")
  }
  if (subscription.interval === targetInterval) {
    throw new PlanChangeError("same_interval", "Dieser Plan ist bereits aktiv.", 400)
  }
}

export function isProviderStatusManageable(provider: string, status: string) {
  return provider === "stripe" ? status === "active" || status === "trialing" : status === "ACTIVE"
}

export async function findOpenPlanChange(
  supabase: SupabaseClient,
  billingSubscriptionId: string,
): Promise<BillingPlanChangeRow | null> {
  const { data, error } = await supabase
    .from("billing_subscription_plan_changes")
    .select("*")
    .eq("billing_subscription_id", billingSubscriptionId)
    .in("status", OPEN_PLAN_CHANGE_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return (data as BillingPlanChangeRow | null) ?? null
}

export async function findStalePendingPayPalPlanChanges(
  supabase: SupabaseClient,
  billingSubscriptionId: string,
  now: Date = new Date(),
): Promise<BillingPlanChangeRow[]> {
  const cutoff = new Date(now.getTime() - PAYPAL_APPROVAL_TTL_MS).toISOString()
  const { data, error } = await supabase
    .from("billing_subscription_plan_changes")
    .select("*")
    .eq("billing_subscription_id", billingSubscriptionId)
    .eq("provider", "paypal")
    .eq("status", "pending_approval")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
  if (error) throw error
  return (data as BillingPlanChangeRow[] | null) ?? []
}

export async function findPlanChangeByOperationId(
  supabase: SupabaseClient,
  operationId: string,
  userId?: string,
): Promise<BillingPlanChangeRow | null> {
  let query = supabase
    .from("billing_subscription_plan_changes")
    .select("*")
    .eq("operation_id", operationId)
  if (userId) query = query.eq("user_id", userId)
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  return (data as BillingPlanChangeRow | null) ?? null
}

export async function claimPlanChange(
  supabase: SupabaseClient,
  input: {
    operationId: string
    subscription: BillingSubscriptionRow & {
      interval: BillingInterval
      current_period_end: string
    }
    targetInterval: BillingInterval
  },
): Promise<BillingPlanChangeRow> {
  const { data, error } = await supabase.rpc("claim_billing_subscription_plan_change", {
    p_operation_id: input.operationId,
    p_billing_subscription_id: input.subscription.id,
    p_user_id: input.subscription.user_id,
    p_provider: input.subscription.provider,
    p_current_interval: input.subscription.interval,
    p_target_interval: input.targetInterval,
    p_effective_at: input.subscription.current_period_end,
  })
  if (error) {
    if (String(error.message ?? "").includes("already pending")) {
      throw new PlanChangeError("plan_change_pending", "Es ist bereits ein Wechsel vorgemerkt.")
    }
    throw error
  }
  return data as BillingPlanChangeRow
}

export async function advancePlanChange(
  supabase: SupabaseClient,
  input: {
    operationId: string
    expectedStatus: BillingPlanChangeStatus
    status: BillingPlanChangeStatus
    providerResourceId?: string | null
    providerTargetId?: string | null
    effectiveAt?: string | null
    failureCode?: string | null
    metadata?: Record<string, unknown>
  },
): Promise<BillingPlanChangeRow> {
  const { data, error } = await supabase.rpc("advance_billing_subscription_plan_change", {
    p_operation_id: input.operationId,
    p_expected_status: input.expectedStatus,
    p_status: input.status,
    p_provider_resource_id: input.providerResourceId ?? null,
    p_provider_target_id: input.providerTargetId ?? null,
    p_effective_at: input.effectiveAt ?? null,
    p_failure_code: input.failureCode ?? null,
    p_metadata: input.metadata ?? {},
  })
  if (error) throw error
  return data as BillingPlanChangeRow
}

export async function mergePendingPlanChangeMetadata(
  supabase: SupabaseClient,
  subscription: BillingSubscriptionRow,
  operation: BillingPlanChangeRow,
) {
  const metadata = {
    ...(subscription.metadata ?? {}),
    pending_plan_change: {
      operation_id: operation.operation_id,
      target_interval: operation.target_interval,
      effective_at: operation.effective_at,
      status: operation.status,
      provider_resource_id: operation.provider_resource_id,
    },
  }
  const { error } = await supabase
    .from("billing_subscriptions")
    .update({ metadata, updated_at: new Date().toISOString() })
    .eq("id", subscription.id)
  if (error) throw error
}

export async function clearPendingPlanChangeMetadata(
  supabase: SupabaseClient,
  subscription: BillingSubscriptionRow,
) {
  const metadata = withoutPendingPlanChange(subscription.metadata)
  const { error } = await supabase
    .from("billing_subscriptions")
    .update({ metadata, updated_at: new Date().toISOString() })
    .eq("id", subscription.id)
  if (error) throw error
}

export async function applyPlanChangeAtRenewal(
  supabase: SupabaseClient,
  input: {
    subscription: BillingSubscriptionRow
    observedInterval: BillingInterval
    occurredAt: string
    deps?: {
      findOperation?: typeof findOpenPlanChange
      advanceOperation?: typeof advancePlanChange
      recordAppliedPhase?: typeof recordPlanChangePhase
    }
  },
): Promise<{ subscription: BillingSubscriptionRow; operation: BillingPlanChangeRow } | null> {
  const operation = await (input.deps?.findOperation ?? findOpenPlanChange)(
    supabase,
    input.subscription.id,
  )
  if (!operation || (operation.status !== "scheduled" && operation.status !== "reconciling")) {
    return null
  }
  if (operation.target_interval !== input.observedInterval) return null
  if (Date.parse(input.occurredAt) < Date.parse(operation.effective_at)) return null

  const metadata = withoutPendingPlanChange(input.subscription.metadata)
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .update({
      interval: operation.target_interval,
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.subscription.id)
    .select("*")
    .single()
  if (error) throw error

  const applied = await (input.deps?.advanceOperation ?? advancePlanChange)(supabase, {
    operationId: operation.operation_id,
    expectedStatus: operation.status,
    status: "applied",
  })
  await (input.deps?.recordAppliedPhase ?? recordPlanChangePhase)(supabase, applied, "applied")
  return { subscription: data as BillingSubscriptionRow, operation: applied }
}

export async function recordPlanChangePhase(
  supabase: SupabaseClient,
  operation: BillingPlanChangeRow,
  phase: "requested" | "approved" | "failed" | "applied",
) {
  await recordBillingAnalyticsEvent(
    supabase,
    {
      eventKey: `${operation.provider}:subscription_updated:${operation.billing_subscription_id}:${operation.operation_id}:${phase}`,
      eventName: "subscription_updated",
      userId: operation.user_id,
      provider: operation.provider,
      sourceObjectId: operation.billing_subscription_id,
      occurredAt: new Date().toISOString(),
      payload: {
        change_phase: phase,
        current_interval: operation.current_interval,
        target_interval: operation.target_interval,
        effective_at: operation.effective_at,
        operation_id: operation.operation_id,
      },
    },
    { destinations: ["customerio", "posthog"] },
  )
}

export function intervalLabel(interval: BillingInterval) {
  if (interval === "month") return "Monatlich"
  if (interval === "quarter") return "Quartalsweise"
  return "Jährlich"
}

function withoutPendingPlanChange(metadata: Record<string, unknown> | null | undefined) {
  const next = { ...(metadata ?? {}) }
  delete next.pending_plan_change
  return next
}
