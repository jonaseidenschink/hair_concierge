import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { z } from "zod"
import { createAdminClient } from "@/lib/supabase/admin"
import { findCurrentBillingSubscriptionForUser } from "@/lib/billing/subscriptions"
import {
  PlanChangeError,
  advancePlanChange,
  assertPlanChangeEligible,
  claimPlanChange,
  findPlanChangeByOperationId,
  mergePendingPlanChangeMetadata,
  recordPlanChangePhase,
} from "@/lib/billing/plan-change"
import { reconcileStalePayPalPlanChanges } from "@/lib/paypal/stale-plan-change"
import { getStripe } from "@/lib/stripe/client"
import {
  StripePlanChangeAmbiguousError,
  StripePlanChangeConflictError,
  StripePlanChangePartialError,
  reconcileStripePlanChange,
  scheduleStripePlanChange,
} from "@/lib/stripe/subscription-plan-change"
import {
  PayPalPlanChangeAmbiguousError,
  PayPalPlanChangeConflictError,
  initiatePayPalPlanChange,
} from "@/lib/paypal/subscription-plan-change"
import type { BillingPlanChangeRow, BillingSubscriptionRow } from "@/lib/billing/types"

export const runtime = "nodejs"

const requestSchema = z.object({
  targetInterval: z.enum(["month", "quarter", "year"]),
  operationId: z.string().uuid(),
})

export async function POST(request: Request) {
  const cookieStore = await cookies()
  const auth = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } },
  )
  const {
    data: { user },
  } = await auth.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 })

  const parsed = requestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 })
  }

  const admin = createAdminClient()
  let operation: BillingPlanChangeRow | null = null
  let providerMutation:
    | {
        provider: "stripe"
        scheduleId: string
        targetId: string
        effectiveAt: string
      }
    | {
        provider: "paypal"
        targetId: string
        approvalUrl: string
        effectiveAt: string
      }
    | null = null
  try {
    const subscription = await findCurrentBillingSubscriptionForUser(admin, user.id)
    if (!subscription) {
      throw new PlanChangeError(
        "no_manageable_subscription",
        "Es wurde kein aktives Abo gefunden.",
        404,
      )
    }
    assertPlanChangeEligible(subscription, parsed.data.targetInterval)
    await reconcileStalePayPalPlanChanges(admin, subscription)
    operation = await claimPlanChange(admin, {
      operationId: parsed.data.operationId,
      subscription,
      targetInterval: parsed.data.targetInterval,
    })

    if (operation.status === "failed") {
      return NextResponse.json(
        {
          error: "plan_change_failed",
          message: "Der vorherige Versuch ist fehlgeschlagen. Bitte versuche es erneut.",
        },
        { status: 409 },
      )
    }
    if (operation.status === "reconciling" && subscription.provider === "stripe") {
      if (!operation.provider_resource_id) {
        throw new StripePlanChangeConflictError(
          "stripe_schedule_missing",
          "Stripe reconciliation schedule is missing",
        )
      }
      const reconciliation = await reconcileStripePlanChange({
        stripe: getStripe(),
        subscriptionId: subscription.provider_subscription_id,
        currentInterval: subscription.interval,
        targetInterval: operation.target_interval,
        operationId: operation.operation_id,
        scheduleId: operation.provider_resource_id,
      })
      if (reconciliation.outcome === "closed") {
        operation = await advancePlanChange(admin, {
          operationId: operation.operation_id,
          expectedStatus: "reconciling",
          status: "failed",
          failureCode: "stripe_schedule_closed_during_reconciliation",
        })
        await recordPlanChangePhase(admin, operation, "failed").catch(() => undefined)
        return NextResponse.json(
          {
            error: "plan_change_failed",
            message: "Der vorherige Versuch ist fehlgeschlagen. Bitte versuche es erneut.",
          },
          { status: 409 },
        )
      }
      operation = await advancePlanChange(admin, {
        operationId: operation.operation_id,
        expectedStatus: "reconciling",
        status: "scheduled",
        providerResourceId: reconciliation.scheduleId,
        providerTargetId: reconciliation.targetPriceId,
        effectiveAt: reconciliation.effectiveAt,
      })
      await recordScheduledPlanChangeSideEffects(admin, subscription, operation)
      return NextResponse.json(operationResponse(operation))
    }
    if (operation.status !== "pending_provider") {
      return NextResponse.json(operationResponse(operation))
    }
    await recordPlanChangePhase(admin, operation, "requested")

    if (subscription.provider === "stripe") {
      const scheduled = await scheduleStripePlanChange({
        stripe: getStripe(),
        subscriptionId: subscription.provider_subscription_id,
        currentInterval: subscription.interval,
        targetInterval: parsed.data.targetInterval,
        operationId: parsed.data.operationId,
      })
      providerMutation = {
        provider: "stripe",
        scheduleId: scheduled.scheduleId,
        targetId: scheduled.targetPriceId,
        effectiveAt: scheduled.effectiveAt,
      }
      operation = await advancePlanChange(admin, {
        operationId: operation.operation_id,
        expectedStatus: "pending_provider",
        status: "scheduled",
        providerResourceId: scheduled.scheduleId,
        providerTargetId: scheduled.targetPriceId,
        effectiveAt: scheduled.effectiveAt,
      })
      await recordScheduledPlanChangeSideEffects(admin, subscription, operation)
      return NextResponse.json(operationResponse(operation))
    }

    const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin).replace(
      /\/$/,
      "",
    )
    const callback = `${siteUrl}/api/billing/change-plan/paypal/return?operationId=${encodeURIComponent(operation.operation_id)}`
    const cancel = `${siteUrl}/api/billing/change-plan/paypal/cancel?operationId=${encodeURIComponent(operation.operation_id)}`
    const revision = await initiatePayPalPlanChange({
      subscriptionId: subscription.provider_subscription_id,
      currentInterval: subscription.interval,
      targetInterval: parsed.data.targetInterval,
      operationId: operation.operation_id,
      returnUrl: callback,
      cancelUrl: cancel,
    })
    providerMutation = {
      provider: "paypal",
      targetId: revision.targetPlanId,
      approvalUrl: revision.approvalUrl,
      effectiveAt: revision.effectiveAt,
    }
    operation = await advancePlanChange(admin, {
      operationId: operation.operation_id,
      expectedStatus: "pending_provider",
      status: "pending_approval",
      providerTargetId: revision.targetPlanId,
      effectiveAt: revision.effectiveAt,
      metadata: { approval_url: revision.approvalUrl },
    })
    await recordPendingApprovalSideEffects(admin, subscription, operation)
    return NextResponse.json(operationResponse(operation))
  } catch (error) {
    const ambiguousProviderMutation =
      error instanceof StripePlanChangeAmbiguousError ||
      error instanceof PayPalPlanChangeAmbiguousError
    if (ambiguousProviderMutation && operation?.status === "pending_provider") {
      console.error("[billing:plan-change] provider response is ambiguous; operation retained", {
        userId: user.id,
        operationId: operation.operation_id,
        provider: operation.provider,
        error: error.message,
      })
      return NextResponse.json(
        {
          error: "provider_response_ambiguous",
          message: "Die Antwort des Zahlungsanbieters ist noch unklar. Bitte versuche es erneut.",
          ...operationResponse(operation),
        },
        { status: 503 },
      )
    }
    if (operation?.status === "pending_provider") {
      try {
        operation = await handleProviderFailure(admin, operation, error, providerMutation)
      } catch {
        // The first transition may have committed even if its response was lost.
        // Re-read the ledger before returning the open operation to the client.
        operation =
          (await findPlanChangeByOperationId(
            admin,
            operation.operation_id,
            operation.user_id,
          ).catch(() => null)) ?? operation
      }
    }
    if (
      operation &&
      (providerMutation ||
        (error instanceof StripePlanChangePartialError && !error.cleanupSucceeded))
    ) {
      console.error("[billing:plan-change] provider mutation requires reconciliation", {
        userId: user.id,
        operationId: parsed.data.operationId,
        status: operation.status,
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json(operationResponse(operation, providerMutation), { status: 202 })
    }
    const known =
      error instanceof PlanChangeError ||
      error instanceof StripePlanChangeConflictError ||
      error instanceof PayPalPlanChangeConflictError
    console.error("[billing:plan-change] request failed", {
      userId: user.id,
      operationId: parsed.data.operationId,
      code: known && "code" in error ? error.code : "provider_error",
      error: error instanceof Error ? error.message : String(error),
    })
    if (error instanceof PlanChangeError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.status },
      )
    }
    if (known) {
      return NextResponse.json(
        { error: error.code, message: "Der Wechsel konnte nicht vorgemerkt werden." },
        { status: 409 },
      )
    }
    return NextResponse.json(
      { error: "plan_change_failed", message: "Bitte versuche es später erneut." },
      { status: 502 },
    )
  }
}

async function recordPendingApprovalSideEffects(
  admin: ReturnType<typeof createAdminClient>,
  subscription: BillingSubscriptionRow,
  operation: BillingPlanChangeRow,
) {
  try {
    await mergePendingPlanChangeMetadata(admin, subscription, operation)
  } catch (error) {
    // The ledger already contains the approval URL and provider-confirmed date.
    // Do not turn auxiliary metadata failure into a duplicate provider revision.
    console.error("[billing:plan-change] pending approval metadata failed", {
      operationId: operation.operation_id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function recordScheduledPlanChangeSideEffects(
  admin: ReturnType<typeof createAdminClient>,
  subscription: BillingSubscriptionRow,
  operation: BillingPlanChangeRow,
) {
  try {
    await mergePendingPlanChangeMetadata(admin, subscription, operation)
    await recordPlanChangePhase(admin, operation, "approved")
  } catch (error) {
    // The atomic ledger is the source of truth once the provider mutation has
    // succeeded. Auxiliary metadata and analytics must not turn a scheduled
    // change into a client-visible failure that invites a duplicate retry.
    console.error("[billing:plan-change] scheduled side effects failed", {
      operationId: operation.operation_id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function handleProviderFailure(
  admin: ReturnType<typeof createAdminClient>,
  operation: BillingPlanChangeRow,
  error: unknown,
  providerMutation:
    | {
        provider: "stripe"
        scheduleId: string
        targetId: string
        effectiveAt: string
      }
    | {
        provider: "paypal"
        targetId: string
        approvalUrl: string
        effectiveAt: string
      }
    | null,
) {
  const partial = error instanceof StripePlanChangePartialError
  const status = providerMutation || (partial && !error.cleanupSucceeded) ? "reconciling" : "failed"
  const advanced = await advancePlanChange(admin, {
    operationId: operation.operation_id,
    expectedStatus: "pending_provider",
    status,
    providerResourceId:
      providerMutation?.provider === "stripe"
        ? providerMutation.scheduleId
        : partial
          ? error.scheduleId
          : undefined,
    providerTargetId: providerMutation?.targetId,
    effectiveAt: providerMutation?.effectiveAt,
    metadata:
      providerMutation?.provider === "paypal"
        ? { approval_url: providerMutation.approvalUrl }
        : undefined,
    failureCode: providerMutation
      ? providerMutation.provider === "stripe"
        ? "local_persistence_after_stripe_schedule"
        : "local_persistence_after_paypal_revision"
      : error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "provider_error")
        : "provider_error",
  })
  await recordPlanChangePhase(admin, advanced, status === "failed" ? "failed" : "approved").catch(
    () => undefined,
  )
  return advanced
}

function operationResponse(
  operation: BillingPlanChangeRow,
  providerMutation?:
    | {
        provider: "stripe"
        scheduleId: string
        targetId: string
        effectiveAt: string
      }
    | {
        provider: "paypal"
        targetId: string
        approvalUrl: string
        effectiveAt: string
      }
    | null,
) {
  const approvalUrl =
    operation.metadata?.approval_url ??
    (providerMutation?.provider === "paypal" ? providerMutation.approvalUrl : undefined)
  return {
    status: operation.status,
    targetInterval: operation.target_interval,
    effectiveAt: providerMutation?.effectiveAt ?? operation.effective_at,
    approvalUrl: typeof approvalUrl === "string" ? approvalUrl : undefined,
  }
}
