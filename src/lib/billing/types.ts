import type { SupabaseClient } from "@supabase/supabase-js"

export type BillingProvider = "stripe" | "paypal"
export type BillingInterval = "month" | "quarter" | "year"
export type BillingEntitlementStatus = "active" | "past_due" | "canceled" | "incomplete"
export type BillingPlanChangeStatus =
  | "pending_provider"
  | "pending_approval"
  | "scheduled"
  | "reconciling"
  | "applied"
  | "failed"
export type BillingAnalyticsDestination = "customerio" | "meta" | "posthog"
export type BillingAnalyticsDeliveryStatus =
  | "pending"
  | "processing"
  | "delivered"
  | "failed"
  | "failed_permanent"
export type BillingAnalyticsEventName =
  | "purchase_completed"
  | "payment_completed"
  | "subscription_started"
  | "subscription_updated"
  | "subscription_cancelled"
  | "subscription_expired"
  | "payment_failed"
  | "refund_completed"

export interface BillingSubscriptionRow {
  id: string
  user_id: string
  provider: BillingProvider
  provider_customer_id: string | null
  provider_subscriber_email: string | null
  provider_subscription_id: string
  provider_status: string
  entitlement_status: BillingEntitlementStatus
  interval: BillingInterval | null
  current_period_end: string | null
  cancel_at_period_end: boolean
  cancelled_at: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface BillingPlanChangeRow {
  id: string
  operation_id: string
  billing_subscription_id: string
  user_id: string
  provider: BillingProvider
  current_interval: BillingInterval
  target_interval: BillingInterval
  effective_at: string
  status: BillingPlanChangeStatus
  provider_resource_id: string | null
  provider_target_id: string | null
  approved_at: string | null
  applied_at: string | null
  failure_code: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type MembershipManagementState =
  | {
      kind: "manageable"
      provider: BillingProvider
      currentInterval: BillingInterval
      renewalAt: string
      cancelAtPeriodEnd: false
    }
  | {
      kind: "pending"
      provider: BillingProvider
      currentInterval: BillingInterval
      renewalAt: string
      cancelAtPeriodEnd: false
      targetInterval: BillingInterval
      effectiveAt: string
      approvalUrl?: string
    }
  | {
      kind: "reconciling"
      provider: BillingProvider
      currentInterval: BillingInterval
      renewalAt: string
      cancelAtPeriodEnd: false
      targetInterval: BillingInterval
      effectiveAt: string
      operationId: string
      retryable: boolean
    }
  | {
      kind: "payment_problem"
      provider: BillingProvider
      currentInterval: BillingInterval | null
      renewalAt: string | null
      cancelAtPeriodEnd: boolean
    }
  | {
      kind: "canceled_at_period_end"
      provider: BillingProvider
      currentInterval: BillingInterval | null
      renewalAt: string | null
      cancelAtPeriodEnd: true
    }
  | { kind: "manual_grant"; renewalAt: string | null }
  | { kind: "legacy_unmanageable"; renewalAt: string | null }
  | { kind: "uncertain" }

export type BillingSubscriptionInput = {
  user_id: string
  provider: BillingProvider
  provider_subscription_id: string
  provider_status: string
  entitlement_status: BillingEntitlementStatus
  provider_customer_id?: string | null
  provider_subscriber_email?: string | null
  interval?: BillingInterval | null
  current_period_end?: string | null
  cancel_at_period_end?: boolean
  cancelled_at?: string | null
  metadata?: Record<string, unknown>
}

export interface BillingAnalyticsOutboxRow {
  id: string
  event_key: string
  event_name: BillingAnalyticsEventName
  user_id: string
  provider: BillingProvider
  provider_customer_id: string | null
  provider_subscription_id: string | null
  source_event_id: string | null
  source_object_id: string | null
  occurred_at: string
  payload: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface BillingAnalyticsDeliveryRow {
  id: string
  outbox_id: string
  destination: BillingAnalyticsDestination
  status: BillingAnalyticsDeliveryStatus
  attempts: number
  processing_started_at: string | null
  next_attempt_at: string | null
  delivered_at: string | null
  last_error: string | null
  provider_request_id: string | null
  created_at: string
  updated_at: string
}

export type SupabaseBillingClient = Pick<SupabaseClient, "from">
