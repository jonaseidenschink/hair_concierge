import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import type Stripe from "stripe"
import {
  PlanChangeError,
  advancePlanChange,
  applyPlanChangeAtRenewal,
  assertPlanChangeEligible,
  buildMembershipManagementState,
  findStalePendingPayPalPlanChanges,
  shouldRetainPlanChangeOperationId,
} from "../src/lib/billing/plan-change"
import { reconcileStalePayPalPlanChanges } from "../src/lib/paypal/stale-plan-change"
import type { BillingPlanChangeRow, BillingSubscriptionRow } from "../src/lib/billing/types"
import {
  StripePlanChangeAmbiguousError,
  StripePlanChangePartialError,
  reconcileStripePlanChange,
  scheduleStripePlanChange,
} from "../src/lib/stripe/subscription-plan-change"
import {
  PayPalPlanPairValidationError,
  type PayPalPlan,
  validatePayPalPlanPair,
} from "../src/lib/paypal/subscription-shapes"
import { upsertBillingSubscription } from "../src/lib/billing/subscriptions"

function subscription(patch: Partial<BillingSubscriptionRow> = {}): BillingSubscriptionRow {
  return {
    id: "subscription-row",
    user_id: "user-id",
    provider: "stripe",
    provider_customer_id: "cus_123",
    provider_subscriber_email: null,
    provider_subscription_id: "sub_123",
    provider_status: "active",
    entitlement_status: "active",
    interval: "month",
    current_period_end: "2026-08-14T12:00:00.000Z",
    cancel_at_period_end: false,
    cancelled_at: null,
    metadata: { preserved: true },
    created_at: "2026-07-14T12:00:00.000Z",
    updated_at: "2026-07-14T12:00:00.000Z",
    ...patch,
  }
}

function operation(patch: Partial<BillingPlanChangeRow> = {}): BillingPlanChangeRow {
  return {
    id: "change-row",
    operation_id: "59aa75cb-1d8c-47cd-96f9-48dc86c8c5c1",
    billing_subscription_id: "subscription-row",
    user_id: "user-id",
    provider: "stripe",
    current_interval: "month",
    target_interval: "year",
    effective_at: "2026-08-14T12:00:00.000Z",
    status: "scheduled",
    provider_resource_id: "sub_sched_123",
    provider_target_id: "price_year",
    approved_at: "2026-07-14T12:00:00.000Z",
    applied_at: null,
    failure_code: null,
    metadata: {},
    created_at: "2026-07-14T12:00:00.000Z",
    updated_at: "2026-07-14T12:00:00.000Z",
    ...patch,
  }
}

test("membership management read model exposes switching only for manageable renewals", () => {
  assert.deepEqual(buildMembershipManagementState({ subscription: subscription() }), {
    kind: "manageable",
    provider: "stripe",
    currentInterval: "month",
    renewalAt: "2026-08-14T12:00:00.000Z",
    cancelAtPeriodEnd: false,
  })
  assert.equal(
    buildMembershipManagementState({
      subscription: subscription({ entitlement_status: "past_due" }),
    }).kind,
    "payment_problem",
  )
  assert.equal(
    buildMembershipManagementState({
      subscription: subscription({ cancel_at_period_end: true }),
    }).kind,
    "canceled_at_period_end",
  )
  assert.equal(
    buildMembershipManagementState({ subscription: null, manualGrantEnd: null }).kind,
    "manual_grant",
  )
  assert.equal(
    buildMembershipManagementState({ subscription: null, legacyAccessEnd: null }).kind,
    "legacy_unmanageable",
  )
})

test("pending and reconciliation states keep the current interval visible", () => {
  const pending = buildMembershipManagementState({
    subscription: subscription(),
    operation: operation(),
  })
  assert.equal(pending.kind, "pending")
  assert.equal("currentInterval" in pending && pending.currentInterval, "month")
  assert.equal("targetInterval" in pending && pending.targetInterval, "year")

  const approvalPending = buildMembershipManagementState({
    subscription: subscription({ provider: "paypal", provider_status: "ACTIVE" }),
    operation: operation({
      provider: "paypal",
      status: "pending_approval",
      metadata: { approval_url: "https://www.paypal.com/approve/change" },
    }),
  })
  assert.equal(approvalPending.kind, "pending")
  assert.equal(
    approvalPending.kind === "pending" ? approvalPending.approvalUrl : undefined,
    "https://www.paypal.com/approve/change",
  )

  const reconciling = buildMembershipManagementState({
    subscription: subscription({ provider: "paypal", provider_status: "ACTIVE" }),
    operation: operation({ provider: "paypal", status: "reconciling" }),
  })
  assert.equal(reconciling.kind, "reconciling")
  assert.equal(
    reconciling.kind === "reconciling" ? reconciling.operationId : undefined,
    operation().operation_id,
  )
  assert.equal(reconciling.kind === "reconciling" && reconciling.retryable, false)

  const providerPending = buildMembershipManagementState({
    subscription: subscription({ provider: "paypal", provider_status: "ACTIVE" }),
    operation: operation({ provider: "paypal", status: "pending_provider" }),
  })
  assert.equal(providerPending.kind, "reconciling")
  assert.equal(providerPending.kind === "reconciling" && providerPending.retryable, true)
})

test("the client operation id is retained for every authoritative open state", () => {
  for (const status of ["pending_provider", "pending_approval", "scheduled", "reconciling"]) {
    assert.equal(shouldRetainPlanChangeOperationId(status), true, status)
  }
  assert.equal(shouldRetainPlanChangeOperationId("failed"), false)
  assert.equal(shouldRetainPlanChangeOperationId("applied"), false)
  assert.equal(shouldRetainPlanChangeOperationId(undefined), false)
})

test("stale PayPal approval lookup is bounded to provider-pending rows older than 24 hours", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const query = {
    select(...args: unknown[]) {
      calls.push({ method: "select", args })
      return query
    },
    eq(...args: unknown[]) {
      calls.push({ method: "eq", args })
      return query
    },
    lt(...args: unknown[]) {
      calls.push({ method: "lt", args })
      return query
    },
    async order(...args: unknown[]) {
      calls.push({ method: "order", args })
      return { data: [operation({ provider: "paypal", status: "pending_approval" })], error: null }
    },
  }
  const supabase = { from: () => query }
  const now = new Date("2026-07-15T12:00:00.000Z")

  const stale = await findStalePendingPayPalPlanChanges(supabase as never, subscription().id, now)

  assert.equal(stale.length, 1)
  assert.deepEqual(calls.find((call) => call.method === "lt")?.args, [
    "created_at",
    "2026-07-14T12:00:00.000Z",
  ])
  assert.deepEqual(
    calls.filter((call) => call.method === "eq").map((call) => call.args),
    [
      ["billing_subscription_id", subscription().id],
      ["provider", "paypal"],
      ["status", "pending_approval"],
    ],
  )
})

test("stale PayPal approvals adopt confirmed targets and keep incomplete approval links actionable", async () => {
  const staleOperation = operation({
    provider: "paypal",
    provider_target_id: "P-YEAR",
    status: "pending_approval",
  })
  const paypalSubscription = subscription({
    provider: "paypal",
    provider_status: "ACTIVE",
    provider_subscription_id: "I-PAYPAL",
  })
  const scenarios = [
    { name: "approved", verifyError: null, expectedStatus: "scheduled" },
    {
      name: "abandoned",
      verifyError: Object.assign(new Error("not applied"), {
        code: "paypal_revision_not_applied",
      }),
      expectedStatus: "pending_approval",
    },
    {
      name: "ambiguous",
      verifyError: new Error("network unavailable"),
      expectedStatus: "pending_approval",
    },
  ] as const

  for (const scenario of scenarios) {
    let advancedStatus: string | null = null
    const phases: string[] = []
    const result = await reconcileStalePayPalPlanChanges({} as never, paypalSubscription, {
      deps: {
        findStale: async () => [staleOperation],
        verifyApproved: async () => {
          if (scenario.verifyError) throw scenario.verifyError
          return {} as never
        },
        advance: async (_client, input) => {
          advancedStatus = input.status
          return operation({ provider: "paypal", status: input.status })
        },
        findByOperationId: async () => null,
        mergeMetadata: async () => undefined,
        clearMetadata: async () => undefined,
        recordPhase: async (_client, _operation, phase) => {
          phases.push(phase)
        },
      },
    })

    assert.equal(advancedStatus, scenario.name === "approved" ? "scheduled" : null, scenario.name)
    assert.equal(result[0]?.status, scenario.expectedStatus, scenario.name)
    assert.deepEqual(phases, scenario.name === "approved" ? ["approved"] : [], scenario.name)
  }
})

test("eligibility rejects same-plan, cancellation, and payment-problem changes", () => {
  assert.throws(
    () => assertPlanChangeEligible(subscription(), "month"),
    (error) => {
      return error instanceof PlanChangeError && error.code === "same_interval"
    },
  )
  assert.throws(
    () => assertPlanChangeEligible(subscription({ cancel_at_period_end: true }), "year"),
    (error) => error instanceof PlanChangeError && error.code === "cancellation_scheduled",
  )
  assert.throws(
    () => assertPlanChangeEligible(subscription({ entitlement_status: "past_due" }), "year"),
    (error) => error instanceof PlanChangeError && error.code === "payment_problem",
  )
})

test("plan-change ledger and routes enforce the locked safety boundaries", () => {
  const migration = readFileSync(
    "supabase/migrations/20260714210000_billing_subscription_plan_changes.sql",
    "utf8",
  )
  const command = readFileSync("src/app/api/billing/change-plan/route.ts", "utf8")
  const profile = readFileSync("src/app/profile/page.tsx", "utf8")
  const analytics = readFileSync("src/lib/billing/plan-change.ts", "utf8")
  const paypalWebhook = readFileSync("src/lib/paypal/webhook-handlers.ts", "utf8")
  const paypalReturn = readFileSync(
    "src/app/api/billing/change-plan/paypal/return/route.ts",
    "utf8",
  )

  assert.match(migration, /billing_plan_change_one_open_per_subscription/)
  assert.match(migration, /EXCEPTION WHEN unique_violation/)
  assert.match(migration, /p_status IN \('failed', 'reconciling'\)/)
  assert.match(command, /operationId: z\.string\(\)\.uuid\(\)/)
  assert.match(command, /scheduleStripePlanChange/)
  assert.match(command, /operation\.status === "reconciling"[\s\S]*reconcileStripePlanChange/)
  assert.match(command, /initiatePayPalPlanChange/)
  assert.match(command, /effectiveAt: scheduled\.effectiveAt/)
  assert.match(command, /effectiveAt: revision\.effectiveAt/)
  assert.match(command, /status: 202/)
  assert.doesNotMatch(profile, /ProfileSubscriptionReactivation/)
  assert.doesNotMatch(profile, /findVisibleBillingSubscriptionForUser/)
  assert.match(profile, /ProfilePlanSwitcher/)
  assert.match(analytics, /destinations: \["customerio", "posthog"\]/)
  assert.match(paypalWebhook, /eventType === "PAYMENT\.SALE\.COMPLETED"/)
  assert.match(paypalWebhook, /applyPlanChangeAtRenewal/)
  assert.match(paypalReturn, /paypal_revision_not_applied[\s\S]*plan-change=pending#mitgliedschaft/)
})

test("billing coordination functions remain service-role only", () => {
  const migration = readFileSync(
    "supabase/migrations/20260714220000_restrict_billing_security_definer_functions.sql",
    "utf8",
  )
  const functionNames = [
    "acquire_membership_reactivation_checkout",
    "claim_membership_reactivation_checkout_provider",
    "claim_billing_subscription_plan_change",
    "advance_billing_subscription_plan_change",
  ]

  assert.equal(migration.match(/FROM PUBLIC, anon, authenticated;/g)?.length, 4)
  assert.equal(migration.match(/TO service_role;/g)?.length, 4)
  for (const functionName of functionNames) {
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION ${functionName}\\(`))
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION ${functionName}\\(`))
  }
})

function stripePrice(
  interval: "month" | "year" = "month",
  patch: Partial<Stripe.Price> = {},
): Stripe.Price {
  return {
    id: interval === "month" ? "price_month" : "price_year",
    object: "price",
    active: true,
    billing_scheme: "per_unit",
    created: 1,
    currency: "eur",
    custom_unit_amount: null,
    livemode: false,
    lookup_key: null,
    metadata: {},
    nickname: null,
    product: "prod_chaarlie",
    recurring: {
      interval,
      interval_count: 1,
      meter: null,
      trial_period_days: null,
      usage_type: "licensed",
    },
    tax_behavior: "unspecified",
    tiers_mode: null,
    transform_quantity: null,
    type: "recurring",
    unit_amount: interval === "month" ? 1499 : 9999,
    unit_amount_decimal: null,
    ...patch,
  }
}

function createStripePlanChangeFake(input?: {
  schedule?: string | null
  scheduleMetadata?: Record<string, string>
  scheduleStatus?: Stripe.SubscriptionSchedule.Status
  scheduleSubscriptionId?: string
  schedulePhases?: unknown[]
  targetPrice?: Stripe.Price
  createError?: Error
  updateError?: Error
  releaseError?: Error
  itemCount?: number
  discounts?: unknown[]
}) {
  const calls: Array<{ name: string; args: unknown[] }> = []
  const currentPrice = stripePrice("month")
  const targetPrice = input?.targetPrice ?? stripePrice("year")
  const fake = {
    subscriptions: {
      retrieve: async (...args: unknown[]) => {
        calls.push({ name: "subscription.retrieve", args })
        return {
          id: "sub_123",
          status: "active",
          cancel_at_period_end: false,
          schedule: input?.schedule ?? null,
          discounts: input?.discounts ?? [],
          items: {
            data: Array.from({ length: input?.itemCount ?? 1 }, (_, index) => ({
              id: `si_${index + 1}`,
              quantity: 1,
              current_period_start: 1_720_000_000,
              current_period_end: 1_722_678_400,
              price: currentPrice,
            })),
          },
        }
      },
    },
    prices: {
      retrieve: async (...args: unknown[]) => {
        calls.push({ name: "price.retrieve", args })
        return targetPrice
      },
    },
    subscriptionSchedules: {
      retrieve: async (...args: unknown[]) => {
        calls.push({ name: "schedule.retrieve", args })
        return {
          id: input?.schedule ?? "sub_sched_123",
          metadata: input?.scheduleMetadata ?? {},
          status: input?.scheduleStatus ?? "active",
          subscription: input?.scheduleSubscriptionId ?? "sub_123",
          released_subscription: null,
          phases: input?.schedulePhases ?? [],
        }
      },
      create: async (...args: unknown[]) => {
        calls.push({ name: "schedule.create", args })
        if (input?.createError) throw input.createError
        return { id: "sub_sched_123" }
      },
      update: async (...args: unknown[]) => {
        calls.push({ name: "schedule.update", args })
        if (input?.updateError) throw input.updateError
        return { id: "sub_sched_123" }
      },
      release: async (...args: unknown[]) => {
        calls.push({ name: "schedule.release", args })
        if (input?.releaseError) throw input.releaseError
        return { id: "sub_sched_123" }
      },
    },
  }
  return { stripe: fake as unknown as Stripe, calls }
}

test("Stripe schedules current service through period end and target service without proration", async () => {
  const { stripe, calls } = createStripePlanChangeFake()
  const result = await scheduleStripePlanChange({
    stripe,
    subscriptionId: "sub_123",
    currentInterval: "month",
    targetInterval: "year",
    operationId: "operation-123",
    configuredTargetPriceId: "price_year",
    expectedProductId: "prod_chaarlie",
  })

  assert.equal(result.scheduleId, "sub_sched_123")
  assert.equal(result.effectiveAt, new Date(1_722_678_400 * 1000).toISOString())
  const create = calls.find((call) => call.name === "schedule.create")!
  assert.deepEqual(create.args, [
    {
      from_subscription: "sub_123",
      metadata: {
        chaarlie_plan_change_operation_id: "operation-123",
        chaarlie_plan_change_target_interval: "year",
      },
    },
    { idempotencyKey: "plan-change:operation-123:create" },
  ])
  const update = calls.find((call) => call.name === "schedule.update")!
  const payload = update.args[1] as {
    end_behavior: string
    phases: Array<Record<string, unknown>>
    metadata: Record<string, string>
  }
  assert.equal(payload.end_behavior, "release")
  assert.deepEqual(payload.phases[0], {
    start_date: 1_720_000_000,
    end_date: 1_722_678_400,
    items: [{ price: "price_month", quantity: 1 }],
    proration_behavior: "none",
  })
  assert.deepEqual(payload.phases[1], {
    start_date: 1_722_678_400,
    duration: { interval: "year", interval_count: 1 },
    items: [{ price: "price_year", quantity: 1 }],
    proration_behavior: "none",
  })
  assert.deepEqual(payload.metadata, {
    chaarlie_plan_change_operation_id: "operation-123",
    chaarlie_plan_change_target_interval: "year",
  })
  assert.deepEqual(update.args[2], { idempotencyKey: "plan-change:operation-123:update" })
})

test("Stripe rejects multi-item and discounted subscriptions before schedule creation", async () => {
  for (const scenario of [
    { input: { itemCount: 2 }, code: "stripe_multi_item_unsupported" },
    { input: { discounts: [{ id: "di_123" }] }, code: "stripe_discount_unsupported" },
  ]) {
    const { stripe, calls } = createStripePlanChangeFake(scenario.input)
    await assert.rejects(
      scheduleStripePlanChange({
        stripe,
        subscriptionId: "sub_123",
        currentInterval: "month",
        targetInterval: "year",
        operationId: `operation-${scenario.code}`,
        configuredTargetPriceId: "price_year",
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === scenario.code,
    )
    assert.equal(
      calls.some((call) => call.name === "schedule.create"),
      false,
      scenario.code,
    )
  }
})

test("ledger transition atomically persists the provider-confirmed effective timestamp", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const confirmedEffectiveAt = "2026-08-15T08:30:00.000Z"
  const fake = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args })
      return {
        data: operation({ effective_at: String(args.p_effective_at), status: "scheduled" }),
        error: null,
      }
    },
  }

  const advanced = await advancePlanChange(fake as never, {
    operationId: operation().operation_id,
    expectedStatus: "pending_provider",
    status: "scheduled",
    providerResourceId: "sub_sched_123",
    providerTargetId: "price_year",
    effectiveAt: confirmedEffectiveAt,
  })

  assert.equal(advanced.effective_at, confirmedEffectiveAt)
  assert.equal(calls[0]?.name, "advance_billing_subscription_plan_change")
  assert.equal(calls[0]?.args.p_effective_at, confirmedEffectiveAt)
})

test("Stripe rejects unrelated schedules before attempting another provider mutation", async () => {
  const { stripe, calls } = createStripePlanChangeFake({ schedule: "sub_sched_external" })
  await assert.rejects(
    scheduleStripePlanChange({
      stripe,
      subscriptionId: "sub_123",
      currentInterval: "month",
      targetInterval: "year",
      operationId: "operation-123",
      configuredTargetPriceId: "price_year",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "stripe_schedule_conflict",
  )
  assert.equal(
    calls.some((call) => call.name === "schedule.create"),
    false,
  )
})

test("Stripe adopts a feature-owned schedule after an ambiguous response", async () => {
  const { stripe, calls } = createStripePlanChangeFake({
    schedule: "sub_sched_123",
    scheduleMetadata: {
      chaarlie_plan_change_operation_id: "operation-123",
      chaarlie_plan_change_target_interval: "year",
    },
    schedulePhases: [
      {
        start_date: 1_720_000_000,
        end_date: 1_722_678_400,
        items: [{ price: "price_month", quantity: 1 }],
      },
    ],
  })

  const result = await scheduleStripePlanChange({
    stripe,
    subscriptionId: "sub_123",
    currentInterval: "month",
    targetInterval: "year",
    operationId: "operation-123",
    configuredTargetPriceId: "price_year",
  })

  assert.equal(result.scheduleId, "sub_sched_123")
  assert.equal(
    calls.some((call) => call.name === "schedule.retrieve"),
    true,
  )
  assert.equal(
    calls.some((call) => call.name === "schedule.create"),
    false,
  )
  const update = calls.find((call) => call.name === "schedule.update")
  assert.ok(update)
  assert.deepEqual((update.args[1] as { phases: unknown[] }).phases[1], {
    start_date: 1_722_678_400,
    duration: { interval: "year", interval_count: 1 },
    items: [{ price: "price_year", quantity: 1 }],
    proration_behavior: "none",
  })
})

test("Stripe reconciliation finishes an owned schedule after update and release both failed", async () => {
  const failedAttempt = createStripePlanChangeFake({
    updateError: new Error("update failed"),
    releaseError: new Error("release failed"),
  })
  await assert.rejects(
    scheduleStripePlanChange({
      stripe: failedAttempt.stripe,
      subscriptionId: "sub_123",
      currentInterval: "month",
      targetInterval: "year",
      operationId: "operation-reconcile",
      configuredTargetPriceId: "price_year",
    }),
    (error: unknown) => error instanceof StripePlanChangePartialError && !error.cleanupSucceeded,
  )

  const retry = createStripePlanChangeFake({
    schedule: "sub_sched_123",
    scheduleMetadata: {
      chaarlie_plan_change_operation_id: "operation-reconcile",
      chaarlie_plan_change_target_interval: "year",
    },
  })
  const reconciled = await reconcileStripePlanChange({
    stripe: retry.stripe,
    subscriptionId: "sub_123",
    currentInterval: "month",
    targetInterval: "year",
    operationId: "operation-reconcile",
    configuredTargetPriceId: "price_year",
    scheduleId: "sub_sched_123",
  })

  assert.equal(reconciled.outcome, "scheduled")
  assert.equal(
    retry.calls.some((call) => call.name === "schedule.create"),
    false,
  )
  const retryUpdate = retry.calls.find((call) => call.name === "schedule.update")
  assert.ok(retryUpdate)
  assert.equal(retryUpdate.args.length, 2)
})

test("Stripe reconciliation closes an owned schedule when exact reconfiguration still fails", async () => {
  const { stripe, calls } = createStripePlanChangeFake({
    schedule: "sub_sched_123",
    scheduleMetadata: {
      chaarlie_plan_change_operation_id: "operation-close",
      chaarlie_plan_change_target_interval: "year",
    },
    updateError: new Error("update still fails"),
  })

  const reconciled = await reconcileStripePlanChange({
    stripe,
    subscriptionId: "sub_123",
    currentInterval: "month",
    targetInterval: "year",
    operationId: "operation-close",
    configuredTargetPriceId: "price_year",
    scheduleId: "sub_sched_123",
  })

  assert.deepEqual(reconciled, { outcome: "closed", scheduleId: "sub_sched_123" })
  assert.equal(
    calls.some((call) => call.name === "schedule.create"),
    false,
  )
  const release = calls.find((call) => call.name === "schedule.release")
  assert.ok(release)
  assert.equal(release.args.length, 1)
})

test("Stripe keeps connection-ambiguous schedule creation retryable", async () => {
  const error = Object.assign(new Error("connection lost"), { type: "StripeConnectionError" })
  const { stripe } = createStripePlanChangeFake({ createError: error })

  await assert.rejects(
    scheduleStripePlanChange({
      stripe,
      subscriptionId: "sub_123",
      currentInterval: "month",
      targetInterval: "year",
      operationId: "operation-123",
      configuredTargetPriceId: "price_year",
    }),
    StripePlanChangeAmbiguousError,
  )
})

test("Stripe preflight rejects inactive, currency, amount, interval, and product mismatches", async () => {
  const cases: Array<{ name: string; price: Stripe.Price; code: string }> = [
    {
      name: "inactive",
      price: stripePrice("year", { active: false }),
      code: "stripe_price_inactive",
    },
    {
      name: "currency",
      price: stripePrice("year", { currency: "usd" }),
      code: "stripe_currency_mismatch",
    },
    {
      name: "amount",
      price: stripePrice("year", { unit_amount: 10000 }),
      code: "stripe_amount_mismatch",
    },
    {
      name: "interval",
      price: stripePrice("year", {
        recurring: {
          interval: "month",
          interval_count: 1,
          meter: null,
          trial_period_days: null,
          usage_type: "licensed",
        },
      }),
      code: "stripe_interval_mismatch",
    },
    {
      name: "product",
      price: stripePrice("year", { product: "prod_other" }),
      code: "stripe_product_mismatch",
    },
  ]

  for (const scenario of cases) {
    const { stripe, calls } = createStripePlanChangeFake({ targetPrice: scenario.price })
    await assert.rejects(
      scheduleStripePlanChange({
        stripe,
        subscriptionId: "sub_123",
        currentInterval: "month",
        targetInterval: "year",
        operationId: `operation-${scenario.name}`,
        configuredTargetPriceId: "price_year",
        expectedProductId: "prod_chaarlie",
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === scenario.code,
      scenario.name,
    )
    assert.equal(
      calls.some((call) => call.name === "schedule.create"),
      false,
      scenario.name,
    )
  }
})

test("Stripe releases its newly-created schedule and reports partial failure when update fails", async () => {
  const { stripe, calls } = createStripePlanChangeFake({ updateError: new Error("update failed") })
  await assert.rejects(
    scheduleStripePlanChange({
      stripe,
      subscriptionId: "sub_123",
      currentInterval: "month",
      targetInterval: "year",
      operationId: "operation-partial",
      configuredTargetPriceId: "price_year",
    }),
    (error: unknown) =>
      error instanceof StripePlanChangePartialError &&
      error.scheduleId === "sub_sched_123" &&
      error.cleanupSucceeded,
  )
  const release = calls.find((call) => call.name === "schedule.release")!
  assert.deepEqual(release.args[2], { idempotencyKey: "plan-change:operation-partial:cleanup" })
})

function paypalPlan(interval: "month" | "year", patch: Partial<PayPalPlan> = {}): PayPalPlan {
  return {
    id: interval === "month" ? "P-MONTH" : "P-YEAR",
    product_id: "PROD-CHAARLIE",
    status: "ACTIVE",
    billing_cycles: [
      {
        tenure_type: "REGULAR",
        total_cycles: 0,
        frequency: { interval_unit: interval === "month" ? "MONTH" : "YEAR", interval_count: 1 },
        pricing_scheme: {
          fixed_price: { value: interval === "month" ? "14.99" : "99.99", currency_code: "EUR" },
        },
      },
    ],
    ...patch,
  }
}

test("PayPal accepts configured same-product plan shapes", () => {
  assert.doesNotThrow(() =>
    validatePayPalPlanPair({
      currentPlan: paypalPlan("month"),
      targetPlan: paypalPlan("year"),
      currentInterval: "month",
      targetInterval: "year",
      expectedProductId: "PROD-CHAARLIE",
    }),
  )
})

test("PayPal rejects inactive, currency, amount, interval, and product mismatches", () => {
  const base = paypalPlan("year")
  const regular = base.billing_cycles![0]
  const cases: Array<{ name: string; plan: PayPalPlan; code: string }> = [
    {
      name: "inactive",
      plan: paypalPlan("year", { status: "INACTIVE" }),
      code: "paypal_plan_shape_mismatch",
    },
    {
      name: "currency",
      plan: paypalPlan("year", {
        billing_cycles: [
          { ...regular, pricing_scheme: { fixed_price: { value: "99.99", currency_code: "USD" } } },
        ],
      }),
      code: "paypal_plan_shape_mismatch",
    },
    {
      name: "amount",
      plan: paypalPlan("year", {
        billing_cycles: [
          {
            ...regular,
            pricing_scheme: { fixed_price: { value: "100.00", currency_code: "EUR" } },
          },
        ],
      }),
      code: "paypal_plan_shape_mismatch",
    },
    {
      name: "interval",
      plan: paypalPlan("year", {
        billing_cycles: [{ ...regular, frequency: { interval_unit: "MONTH", interval_count: 1 } }],
      }),
      code: "paypal_plan_shape_mismatch",
    },
    {
      name: "product",
      plan: paypalPlan("year", { product_id: "PROD-OTHER" }),
      code: "paypal_product_mismatch",
    },
  ]
  for (const scenario of cases) {
    assert.throws(
      () =>
        validatePayPalPlanPair({
          currentPlan: paypalPlan("month"),
          targetPlan: scenario.plan,
          currentInterval: "month",
          targetInterval: "year",
          expectedProductId: "PROD-CHAARLIE",
        }),
      (error: unknown) =>
        error instanceof PayPalPlanPairValidationError && error.code === scenario.code,
      scenario.name,
    )
  }
})

function createRenewalSupabaseFake(updated: BillingSubscriptionRow) {
  const calls: Array<Record<string, unknown>> = []
  const query = {
    update(patch: Record<string, unknown>) {
      calls.push({ method: "update", patch })
      return query
    },
    eq(column: string, value: unknown) {
      calls.push({ method: "eq", column, value })
      return query
    },
    select(value: string) {
      calls.push({ method: "select", value })
      return query
    },
    async single() {
      return { data: updated, error: null }
    },
  }
  return {
    supabase: {
      from(table: string) {
        calls.push({ method: "from", table })
        return query
      },
    },
    calls,
  }
}

test("renewal application ignores early and wrong-interval provider observations", async () => {
  const current = subscription({
    metadata: { preserved: true, pending_plan_change: { operation_id: "op" } },
  })
  const { supabase, calls } = createRenewalSupabaseFake(current)
  const findOperation = async () => operation()
  const dependencies = { findOperation }

  assert.equal(
    await applyPlanChangeAtRenewal(supabase as never, {
      subscription: current,
      observedInterval: "year",
      occurredAt: "2026-08-14T11:59:59.000Z",
      deps: dependencies as never,
    }),
    null,
  )
  assert.equal(
    await applyPlanChangeAtRenewal(supabase as never, {
      subscription: current,
      observedInterval: "quarter",
      occurredAt: "2026-08-14T12:00:01.000Z",
      deps: dependencies as never,
    }),
    null,
  )
  assert.equal(calls.length, 0)
})

test("renewal application uses the provider-confirmed ledger date instead of stale local renewal data", async () => {
  const current = subscription({
    current_period_end: "2026-08-15T12:00:00.000Z",
    metadata: { pending_plan_change: { operation_id: "op" } },
  })
  const updated = subscription({ interval: "year", metadata: {} })
  const { supabase, calls } = createRenewalSupabaseFake(updated)

  const result = await applyPlanChangeAtRenewal(supabase as never, {
    subscription: current,
    observedInterval: "year",
    occurredAt: "2026-08-14T12:00:01.000Z",
    deps: {
      findOperation: async () =>
        operation({ effective_at: "2026-08-14T12:00:00.000Z", status: "scheduled" }),
      advanceOperation: async () => operation({ status: "applied" }),
      recordAppliedPhase: async () => undefined,
    },
  })

  assert.equal(result?.subscription.interval, "year")
  assert.equal(
    calls.some((call) => call.method === "update"),
    true,
  )
})

test("renewal application changes interval, clears only pending metadata, advances and records applied", async () => {
  const current = subscription({
    metadata: {
      preserved: true,
      nested: { keep: "yes" },
      pending_plan_change: { operation_id: "op" },
    },
  })
  const updated = subscription({
    interval: "year",
    metadata: { preserved: true, nested: { keep: "yes" } },
  })
  const { supabase, calls } = createRenewalSupabaseFake(updated)
  let advancedInput: Record<string, unknown> | null = null
  let recordedPhase: string | null = null
  const result = await applyPlanChangeAtRenewal(supabase as never, {
    subscription: current,
    observedInterval: "year",
    occurredAt: "2026-08-14T12:00:01.000Z",
    deps: {
      findOperation: async () => operation(),
      advanceOperation: async (_client, input) => {
        advancedInput = input
        return operation({ status: "applied", applied_at: "2026-08-14T12:00:01.000Z" })
      },
      recordAppliedPhase: async (_client, _operation, phase) => {
        recordedPhase = phase
      },
    },
  })

  assert.equal(result?.subscription.interval, "year")
  const update = calls.find((call) => call.method === "update")!
  assert.deepEqual(update.patch, {
    interval: "year",
    metadata: { preserved: true, nested: { keep: "yes" } },
    updated_at: (update.patch as { updated_at: string }).updated_at,
  })
  assert.deepEqual(advancedInput, {
    operationId: operation().operation_id,
    expectedStatus: "scheduled",
    status: "applied",
  })
  assert.equal(recordedPhase, "applied")
})

test("billing upsert merges incoming metadata without deleting unrelated provider state", async () => {
  const existing = subscription({
    metadata: { preserved: true, pending_plan_change: { operation_id: "op" } },
  })
  let upserted: Record<string, unknown> | null = null
  function query() {
    const chain = {
      select() {
        return chain
      },
      eq() {
        return chain
      },
      async maybeSingle() {
        return { data: existing, error: null }
      },
      upsert(row: Record<string, unknown>) {
        upserted = row
        return chain
      },
      async single() {
        return { data: { ...existing, ...upserted }, error: null }
      },
    }
    return chain
  }
  const fake = { from: () => query() }
  await upsertBillingSubscription(fake as never, {
    user_id: existing.user_id,
    provider: existing.provider,
    provider_subscription_id: existing.provider_subscription_id,
    provider_status: existing.provider_status,
    entitlement_status: existing.entitlement_status,
    metadata: { plan_id: "P-YEAR" },
  })
  assert.deepEqual((upserted as { metadata?: unknown } | null)?.metadata, {
    preserved: true,
    pending_plan_change: { operation_id: "op" },
    plan_id: "P-YEAR",
  })
})
