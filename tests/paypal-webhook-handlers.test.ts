import assert from "node:assert/strict"
import test from "node:test"
import {
  handlePayPalWebhookEvent,
  type PayPalWebhookEvent,
} from "../src/lib/paypal/webhook-handlers"
import type { BillingSubscriptionRow } from "../src/lib/billing/types"
import type { FreemiumProvisioningResult } from "../src/lib/freemium/plan-provisioning"
import type { PayPalSubscription } from "../src/lib/paypal/subscription-shapes"
import { toBillingSubscriptionInputFromPayPal } from "../src/lib/paypal/subscription-shapes"

function futureIso(days = 1) {
  return new Date(Date.now() + days * 86_400_000).toISOString()
}

function pastIso() {
  return new Date(Date.now() - 86_400_000).toISOString()
}

test("PayPal activation metadata persists the verified launch plan catalog", () => {
  const previous = process.env.PAYPAL_PLAN_ID_PERSONAL_PLAN_LAUNCH_MONTHLY
  process.env.PAYPAL_PLAN_ID_PERSONAL_PLAN_LAUNCH_MONTHLY = "P-launch-month"
  try {
    const input = toBillingSubscriptionInputFromPayPal(
      {
        id: "I-launch",
        status: "ACTIVE",
        plan_id: "P-launch-month",
        subscriber: { payer_id: "payer-launch", email_address: "launch@example.com" },
        billing_info: { next_billing_time: futureIso() },
      },
      "user-launch",
      "month",
    )
    assert.deepEqual(input.metadata, {
      plan_id: "P-launch-month",
      paypal_plan_id: "P-launch-month",
      pricing_catalog: "personal_plan_launch_v1",
    })
  } finally {
    if (previous === undefined) delete process.env.PAYPAL_PLAN_ID_PERSONAL_PLAN_LAUNCH_MONTHLY
    else process.env.PAYPAL_PLAN_ID_PERSONAL_PLAN_LAUNCH_MONTHLY = previous
  }
})

test("an unknown PayPal plan keeps provider identity without clearing stored catalog metadata", () => {
  const input = toBillingSubscriptionInputFromPayPal(
    {
      id: "I-legacy",
      status: "ACTIVE",
      plan_id: "P-not-currently-configured",
      subscriber: { payer_id: "payer-legacy" },
      billing_info: { next_billing_time: futureIso() },
    },
    "user-legacy",
    "month",
  )

  assert.deepEqual(input.metadata, {
    plan_id: "P-not-currently-configured",
    paypal_plan_id: "P-not-currently-configured",
  })
  assert.equal(Object.hasOwn(input.metadata ?? {}, "pricing_catalog"), false)
})

function createSupabaseStub(seed?: {
  billing?: Partial<BillingSubscriptionRow>[]
  profiles?: Record<string, Record<string, unknown>>
  paypalIntents?: Array<Record<string, unknown>>
  analyticsOutbox?: Array<Record<string, unknown>>
}) {
  const calls: Array<Record<string, unknown>> = []
  const webhookEvents = new Set<string>()
  const profiles = seed?.profiles ?? {}
  const paypalIntents = seed?.paypalIntents ?? [
    {
      id: "intent-1",
      token: "token-active",
      interval: "month",
      source: "pricing_page",
      status: "approved",
      provider_subscription_id: null,
      lead_id: null,
      email: null,
      user_id: null,
      expires_at: futureIso(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: {},
    },
  ]
  const authUsers: Record<
    string,
    { id: string; email: string; app_metadata?: Record<string, unknown> }
  > = {}
  const analyticsOutbox = [...(seed?.analyticsOutbox ?? [])]
  const analyticsDeliveries: Array<Record<string, unknown>> = []
  const billing: BillingSubscriptionRow[] = (seed?.billing ?? []).map((row, index) => ({
    id: row.id ?? `billing-${index + 1}`,
    user_id: row.user_id ?? "user-1",
    provider: row.provider ?? "paypal",
    provider_customer_id: row.provider_customer_id ?? "payer-1",
    provider_subscriber_email: row.provider_subscriber_email ?? null,
    provider_subscription_id: row.provider_subscription_id ?? `I-${index + 1}`,
    provider_status: row.provider_status ?? "ACTIVE",
    entitlement_status: row.entitlement_status ?? "active",
    interval: row.interval ?? "month",
    current_period_end: row.current_period_end ?? futureIso(),
    cancel_at_period_end: row.cancel_at_period_end ?? false,
    cancel_scheduled_at: row.cancel_scheduled_at ?? null,
    cancelled_at: row.cancelled_at ?? null,
    metadata: row.metadata ?? {},
    created_at: row.created_at ?? new Date().toISOString(),
    updated_at: row.updated_at ?? new Date().toISOString(),
  }))

  function tableRows(table: string) {
    if (table === "billing_subscriptions") return billing
    if (table === "profiles") return Object.values(profiles)
    if (table === "paypal_checkout_intents") return paypalIntents
    if (table === "billing_analytics_outbox") return analyticsOutbox
    if (table === "billing_analytics_deliveries") return analyticsDeliveries
    return []
  }

  function makeQuery(table: string) {
    const state: {
      op?: "select" | "update"
      patch?: Record<string, unknown>
      filters: Array<{ column: string; value: unknown; op: "eq" | "ilike" | "is" | "in" }>
    } = { filters: [] }

    function applyFilters(rows: Record<string, unknown>[]) {
      return rows.filter((row) =>
        state.filters.every((filter) => {
          if (filter.op === "ilike") {
            return (
              String(row[filter.column] ?? "").toLowerCase() === String(filter.value).toLowerCase()
            )
          }
          if (filter.op === "is") return row[filter.column] === filter.value
          if (filter.op === "in") {
            return Array.isArray(filter.value) && filter.value.includes(row[filter.column])
          }
          return row[filter.column] === filter.value
        }),
      )
    }

    async function resolveRows() {
      if (state.op === "update" && state.patch) {
        const matched = applyFilters(tableRows(table) as Record<string, unknown>[])
        for (const row of matched) Object.assign(row, state.patch)
        calls.push({ table, op: "update", patch: state.patch, filters: state.filters })
      }
      return { data: applyFilters(tableRows(table) as Record<string, unknown>[]), error: null }
    }

    const builder = {
      select() {
        if (state.op !== "update") state.op = "select"
        return builder
      },
      eq(column: string, value: unknown) {
        state.filters.push({ column, value, op: "eq" })
        return builder
      },
      is(column: string, value: unknown) {
        state.filters.push({ column, value, op: "is" })
        return builder
      },
      ilike(column: string, value: unknown) {
        state.filters.push({ column, value, op: "ilike" })
        return builder
      },
      in(column: string, value: unknown[]) {
        state.filters.push({ column, value, op: "in" })
        return builder
      },
      order() {
        return builder
      },
      limit() {
        return builder
      },
      maybeSingle: async () => {
        const { data: rows } = await resolveRows()
        return { data: rows[0] ?? null, error: null }
      },
      single: async () => {
        const { data: rows } = await resolveRows()
        return { data: rows[0] ?? null, error: null }
      },
      upsert(
        row: Record<string, unknown> | Array<Record<string, unknown>>,
        _options?: Record<string, unknown>,
      ) {
        calls.push({ table, op: "upsert", row })
        if (table === "billing_analytics_deliveries" && Array.isArray(row)) {
          for (const delivery of row) {
            const duplicate = analyticsDeliveries.some(
              (candidate) =>
                candidate.outbox_id === delivery.outbox_id &&
                candidate.destination === delivery.destination,
            )
            if (!duplicate) {
              analyticsDeliveries.push({
                id: `delivery-${analyticsDeliveries.length + 1}`,
                status: "pending",
                attempts: 0,
                ...delivery,
              })
            }
          }
          return { error: null }
        }
        if (Array.isArray(row)) throw new Error(`Unexpected array upsert for ${table}`)
        if (table === "billing_subscriptions") {
          const existing = billing.find(
            (candidate) =>
              candidate.provider === row.provider &&
              candidate.provider_subscription_id === row.provider_subscription_id,
          )
          if (existing) {
            Object.assign(existing, row, { updated_at: row.updated_at ?? existing.updated_at })
          } else {
            billing.push({
              ...(row as unknown as BillingSubscriptionRow),
              id: `billing-${billing.length + 1}`,
              created_at: new Date().toISOString(),
              updated_at: String(row.updated_at ?? new Date().toISOString()),
            })
          }
        } else if (table === "profiles") {
          profiles[String(row.id)] = {
            ...(profiles[String(row.id)] ?? {}),
            ...row,
          }
        }
        return {
          error: null,
          select: () => ({
            single: async () => ({
              data:
                table === "billing_subscriptions"
                  ? billing.find(
                      (candidate) =>
                        candidate.provider === row.provider &&
                        candidate.provider_subscription_id === row.provider_subscription_id,
                    )
                  : row,
              error: null,
            }),
          }),
        }
      },
      insert(row: Record<string, unknown>) {
        calls.push({ table, op: "insert", row })
        if (table === "billing_analytics_outbox") {
          const duplicate = analyticsOutbox.find(
            (candidate) => candidate.event_key === row.event_key,
          )
          const inserted = duplicate
            ? null
            : {
                id: `outbox-${analyticsOutbox.length + 1}`,
                created_at: new Date().toISOString(),
                ...row,
              }
          if (inserted) analyticsOutbox.push(inserted)
          const response = duplicate
            ? {
                data: null,
                error: { code: "23505", message: "duplicate event_key" },
              }
            : { data: inserted, error: null }
          const insertBuilder = {
            select() {
              return insertBuilder
            },
            async single() {
              return response
            },
          }
          return insertBuilder
        }
        if (table !== "billing_webhook_events") {
          throw new Error(`Unexpected insert into ${table}`)
        }
        const key = `${row.provider}:${row.provider_event_id}`
        if (webhookEvents.has(key)) {
          return Promise.resolve({
            data: null,
            error: { code: "23505", message: "duplicate key value violates unique constraint" },
          })
        }
        webhookEvents.add(key)
        return Promise.resolve({ data: row, error: null })
      },
      delete() {
        const deleteBuilder = {
          eq(column: string, value: unknown) {
            state.filters.push({ column, value, op: "eq" })
            if (state.filters.length >= 2) {
              const provider = state.filters.find((filter) => filter.column === "provider")?.value
              const eventId = state.filters.find(
                (filter) => filter.column === "provider_event_id",
              )?.value
              if (table === "billing_webhook_events" && provider && eventId) {
                webhookEvents.delete(`${provider}:${eventId}`)
              }
              calls.push({ table, op: "delete", filters: state.filters })
              return Promise.resolve({ data: null, error: null })
            }
            return deleteBuilder
          },
        }
        return deleteBuilder
      },
      update(patch: Record<string, unknown>) {
        state.op = "update"
        state.patch = patch
        return builder
      },
      then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
        resolveRows().then(resolve, reject)
      },
    }

    return builder
  }

  return {
    calls,
    analyticsOutbox,
    analyticsDeliveries,
    billing,
    paypalIntents,
    profiles,
    supabase: {
      from: makeQuery,
      auth: {
        admin: {
          async createUser(args: { email: string; app_metadata?: Record<string, unknown> }) {
            const id = `user-${Object.keys(authUsers).length + 1}`
            authUsers[id] = { id, email: args.email, app_metadata: args.app_metadata }
            return { data: { user: { id, email: args.email } }, error: null }
          },
          async getUserById(userId: string) {
            return { data: { user: authUsers[userId] ?? null }, error: null }
          },
          async listUsers() {
            return { data: { users: Object.values(authUsers) }, error: null }
          },
        },
      },
    } as any,
  }
}

test("BILLING.SUBSCRIPTION.ACTIVATED claims the event and mirrors active entitlement", async () => {
  const periodEnd = futureIso(3)
  const { supabase, billing, profiles } = createSupabaseStub()

  const result = await handlePayPalWebhookEvent(event("WH-1", "BILLING.SUBSCRIPTION.ACTIVATED"), {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => subscription("ACTIVE", periodEnd),
  })

  assert.deepEqual(result, { handled: true })
  assert.equal(billing.length, 1)
  assert.equal(billing[0].provider_subscription_id, "I-active")
  assert.equal(billing[0].entitlement_status, "active")
  assert.equal(billing[0].current_period_end, periodEnd)
  assert.equal(Object.values(profiles)[0].subscription_status, "active")
  assert.equal(Object.values(profiles)[0].subscription_tier_id, "tier-premium")
})

test("duplicate PayPal webhook event id is skipped before retrieving provider state", async () => {
  const { supabase, billing } = createSupabaseStub()
  let retrieveCount = 0
  const deps = {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => {
      retrieveCount += 1
      return subscription("ACTIVE", futureIso())
    },
  }

  await handlePayPalWebhookEvent(event("WH-duplicate", "BILLING.SUBSCRIPTION.ACTIVATED"), deps)
  const second = await handlePayPalWebhookEvent(
    event("WH-duplicate", "BILLING.SUBSCRIPTION.ACTIVATED"),
    deps,
  )

  assert.deepEqual(second, { handled: true, skipped: true })
  assert.equal(retrieveCount, 1)
  assert.equal(billing.length, 1)
})

test("PayPal webhook claim is released when side effects fail so retry can recover", async () => {
  const { supabase, billing } = createSupabaseStub()
  let retrieveCount = 0

  await assert.rejects(
    () =>
      handlePayPalWebhookEvent(event("WH-retry", "BILLING.SUBSCRIPTION.ACTIVATED"), {
        supabase,
        premiumTierId: "tier-premium",
        freeTierId: "tier-free",
        retrievePayPalSubscription: async () => {
          retrieveCount += 1
          throw new Error("temporary PayPal outage")
        },
      }),
    /temporary PayPal outage/,
  )

  await handlePayPalWebhookEvent(event("WH-retry", "BILLING.SUBSCRIPTION.ACTIVATED"), {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => {
      retrieveCount += 1
      return subscription("ACTIVE", futureIso())
    },
  })

  assert.equal(retrieveCount, 2)
  assert.equal(billing.length, 1)
  assert.equal(billing[0].entitlement_status, "active")
})

test("payment webhooks require a subscription identifier instead of using the sale id", async () => {
  const { supabase, billing, calls } = createSupabaseStub({
    billing: [{ user_id: "user-1", provider_subscription_id: "I-active" }],
  })

  await assert.rejects(
    () =>
      handlePayPalWebhookEvent(
        { id: "WH-sale-id-only", event_type: "PAYMENT.SALE.COMPLETED", resource: { id: "SALE-1" } },
        {
          supabase,
          premiumTierId: "tier-premium",
          freeTierId: "tier-free",
          retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
        },
      ),
    /missing subscription id/,
  )

  assert.equal(billing[0].provider_subscription_id, "I-active")
  assert.equal(
    calls.some((call) => call.table === "billing_webhook_events"),
    false,
  )
})

test("refund analytics without a subscription link releases the webhook claim for retry", async () => {
  const { supabase } = createSupabaseStub({
    billing: [{ user_id: "user-1", provider_subscription_id: "I-active" }],
  })
  const refund = {
    id: "WH-refund-missing-link",
    event_type: "PAYMENT.SALE.REFUNDED",
    resource: { id: "SALE-1" },
  }

  await assert.rejects(
    () =>
      handlePayPalWebhookEvent(refund, {
        supabase,
        premiumTierId: "tier-premium",
        freeTierId: "tier-free",
        recordBillingAnalytics: true,
      }),
    /missing a subscription link/,
  )

  const retry = await handlePayPalWebhookEvent(refund, {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    recordBillingAnalytics: false,
  })

  assert.deepEqual(retry, { handled: false })
})

test("PAYMENT.SALE.COMPLETED refreshes the paid-through date", async () => {
  const periodEnd = futureIso(30)
  const { supabase, billing } = createSupabaseStub({
    billing: [
      { user_id: "user-1", provider_subscription_id: "I-active", current_period_end: pastIso() },
    ],
    profiles: { "user-1": { id: "user-1", email: "paypal@example.com" } },
  })

  await handlePayPalWebhookEvent(paymentEvent("WH-sale", "PAYMENT.SALE.COMPLETED"), {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => subscription("ACTIVE", periodEnd),
  })

  assert.equal(billing[0].current_period_end, periodEnd)
  assert.equal(billing[0].entitlement_status, "active")
})

test("BILLING.SUBSCRIPTION.PAYMENT.FAILED sets past_due and keeps access", async () => {
  const { supabase, billing, profiles } = createSupabaseStub({
    billing: [{ user_id: "user-1", provider_subscription_id: "I-active" }],
    profiles: { "user-1": { id: "user-1", subscription_status: "active" } },
    paypalIntents: [
      {
        id: "intent-qa",
        token: "token-qa",
        interval: "month",
        source: "pricing_page",
        status: "approved",
        provider_subscription_id: "I-active",
        lead_id: null,
        email: null,
        user_id: "user-1",
        expires_at: futureIso(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: { is_internal_test: true },
      },
    ],
  })
  const reported: Array<Record<string, unknown>> = []

  const failedEvent = event("WH-failed", "BILLING.SUBSCRIPTION.PAYMENT.FAILED")
  const deps = {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
    capturePaymentFailure(details: Record<string, unknown>) {
      reported.push(details)
    },
  }
  await handlePayPalWebhookEvent(failedEvent, deps)
  await handlePayPalWebhookEvent(failedEvent, deps)

  assert.equal(billing[0].entitlement_status, "past_due")
  assert.equal(profiles["user-1"].subscription_status, "past_due")
  assert.equal(profiles["user-1"].subscription_tier_id, "tier-premium")
  assert.deepEqual(reported, [
    {
      signal: "provider_payment_failed",
      provider: "paypal",
      boundary: "webhook",
      errorFamily: "declined",
      commerceKind: "subscription",
      origin: "webhook",
      method: "paypal",
      truth: "failed",
      live: false,
      isInternalTest: true,
      providerReferencePresent: true,
    },
  ])
})

test("BILLING.SUBSCRIPTION.CANCELLED keeps future paid-through access", async () => {
  const localPeriodEnd = futureIso(10)
  const providerPeriodEnd = futureIso(20)
  const { supabase, billing, profiles } = createSupabaseStub({
    billing: [
      {
        user_id: "user-1",
        provider_subscription_id: "I-active",
        current_period_end: localPeriodEnd,
      },
    ],
    profiles: { "user-1": { id: "user-1", subscription_status: "active" } },
  })

  await handlePayPalWebhookEvent(event("WH-cancelled", "BILLING.SUBSCRIPTION.CANCELLED"), {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => subscription("CANCELLED", providerPeriodEnd),
  })

  assert.equal(billing[0].entitlement_status, "canceled")
  assert.equal(billing[0].cancel_at_period_end, true)
  assert.equal(billing[0].cancel_scheduled_at, localPeriodEnd)
  assert.equal(profiles["user-1"].subscription_status, "active")
  assert.equal(profiles["user-1"].subscription_tier_id, "tier-premium")
})

test("BILLING.SUBSCRIPTION.CANCELLED acknowledges duplicate subscriptions without local rows", async () => {
  const { supabase, billing, paypalIntents } = createSupabaseStub({
    billing: [],
    paypalIntents: [
      {
        id: "intent-duplicate",
        token: "token-active",
        interval: "month",
        source: "pricing_page",
        status: "duplicate",
        provider_subscription_id: null,
        expires_at: futureIso(),
      },
    ],
  })

  const result = await handlePayPalWebhookEvent(
    event("WH-duplicate-cancelled", "BILLING.SUBSCRIPTION.CANCELLED"),
    {
      supabase,
      premiumTierId: "tier-premium",
      freeTierId: "tier-free",
      retrievePayPalSubscription: async () => subscription("CANCELLED", futureIso()),
    },
  )

  assert.deepEqual(result, { handled: true })
  assert.equal(billing.length, 0)
  assert.equal(paypalIntents[0].provider_subscription_id, "I-active")
})

test("activation webhook does not rebind an intent that already belongs to another PayPal subscription", async () => {
  const { supabase, billing, paypalIntents } = createSupabaseStub({
    billing: [],
    paypalIntents: [
      {
        id: "intent-existing",
        token: "token-active",
        interval: "month",
        source: "pricing_page",
        status: "approved",
        provider_subscription_id: "I-original",
        expires_at: futureIso(),
      },
    ],
  })
  const cancelled: string[] = []

  const result = await handlePayPalWebhookEvent(
    event("WH-reused-token", "BILLING.SUBSCRIPTION.ACTIVATED"),
    {
      supabase,
      premiumTierId: "tier-premium",
      freeTierId: "tier-free",
      retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
      cancelPayPalSubscription: async (subscriptionId) => {
        cancelled.push(subscriptionId)
      },
    },
  )

  assert.deepEqual(result, { handled: true })
  assert.deepEqual(cancelled, ["I-active"])
  assert.equal(paypalIntents[0].provider_subscription_id, "I-original")
  assert.equal(paypalIntents[0].status, "approved")
  assert.equal(billing.length, 0)
})

test("activation webhook cancels subscriptions created from expired checkout intents", async () => {
  const { supabase, billing, paypalIntents } = createSupabaseStub({
    billing: [],
    paypalIntents: [
      {
        id: "intent-expired",
        token: "token-active",
        interval: "month",
        source: "pricing_page",
        status: "approved",
        provider_subscription_id: null,
        expires_at: pastIso(),
      },
    ],
  })
  const cancelled: string[] = []

  const result = await handlePayPalWebhookEvent(
    event("WH-expired-token", "BILLING.SUBSCRIPTION.ACTIVATED"),
    {
      supabase,
      premiumTierId: "tier-premium",
      freeTierId: "tier-free",
      retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
      cancelPayPalSubscription: async (subscriptionId) => {
        cancelled.push(subscriptionId)
      },
    },
  )

  assert.deepEqual(result, { handled: true })
  assert.deepEqual(cancelled, ["I-active"])
  assert.equal(paypalIntents[0].status, "expired")
  assert.equal(paypalIntents[0].provider_subscription_id, null)
  assert.equal(billing.length, 0)
})

test("activation webhook cancels subscriptions created from quarantined duplicate intents", async () => {
  const { supabase, billing, paypalIntents } = createSupabaseStub({
    billing: [],
    paypalIntents: [
      {
        id: "intent-duplicate",
        token: "token-active",
        interval: "month",
        source: "pricing_page",
        status: "duplicate",
        duplicate_reason: "reactivation_reservation_race",
        provider_subscription_id: null,
        expires_at: futureIso(),
      },
    ],
  })
  const cancelled: string[] = []

  const result = await handlePayPalWebhookEvent(
    event("WH-duplicate-token", "BILLING.SUBSCRIPTION.ACTIVATED"),
    {
      supabase,
      premiumTierId: "tier-premium",
      freeTierId: "tier-free",
      retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
      cancelPayPalSubscription: async (subscriptionId) => {
        cancelled.push(subscriptionId)
      },
    },
  )

  assert.deepEqual(result, { handled: true })
  assert.deepEqual(cancelled, ["I-active"])
  assert.equal(paypalIntents[0].status, "duplicate")
  assert.equal(paypalIntents[0].provider_subscription_id, "I-active")
  assert.equal(billing.length, 0)
})

test("BILLING.SUBSCRIPTION.EXPIRED downgrades to Free", async () => {
  const { supabase, billing, profiles } = createSupabaseStub({
    billing: [{ user_id: "user-1", provider_subscription_id: "I-active" }],
    profiles: { "user-1": { id: "user-1", subscription_status: "active" } },
  })

  await handlePayPalWebhookEvent(event("WH-expired", "BILLING.SUBSCRIPTION.EXPIRED"), {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => subscription("EXPIRED", null),
  })

  assert.equal(billing[0].entitlement_status, "canceled")
  assert.equal(billing[0].cancel_at_period_end, false)
  assert.equal(profiles["user-1"].subscription_status, "canceled")
  assert.equal(profiles["user-1"].subscription_tier_id, "tier-free")
})

test("refund and reversal events are known log-only events", async () => {
  const { supabase, billing, profiles } = createSupabaseStub({
    billing: [{ user_id: "user-1", provider_subscription_id: "I-active" }],
    profiles: { "user-1": { id: "user-1", subscription_status: "active" } },
  })

  const refunded = await handlePayPalWebhookEvent(
    paymentEvent("WH-refund", "PAYMENT.SALE.REFUNDED"),
    {
      supabase,
      premiumTierId: "tier-premium",
      freeTierId: "tier-free",
    },
  )
  const reversed = await handlePayPalWebhookEvent(
    paymentEvent("WH-reversal", "PAYMENT.SALE.REVERSED"),
    {
      supabase,
      premiumTierId: "tier-premium",
      freeTierId: "tier-free",
    },
  )

  assert.deepEqual(refunded, { handled: false })
  assert.deepEqual(reversed, { handled: false })
  assert.equal(billing[0].entitlement_status, "active")
  assert.equal(profiles["user-1"].subscription_status, "active")
})

test("activation refresh keeps the stored interval for legacy PayPal plan ids", async () => {
  const { supabase, billing, profiles } = createSupabaseStub({
    billing: [
      {
        user_id: "user-1",
        provider_subscription_id: "I-active",
        interval: "year",
        metadata: { plan_id: "P-old-year" },
      },
    ],
    profiles: {
      "user-1": {
        id: "user-1",
        email: "paypal@example.com",
        subscription_status: "active",
        subscription_interval: "year",
      },
    },
    paypalIntents: [],
  })

  const result = await handlePayPalWebhookEvent(
    paymentEvent("WH-legacy-plan", "PAYMENT.SALE.COMPLETED"),
    {
      supabase,
      premiumTierId: "tier-premium",
      freeTierId: "tier-free",
      retrievePayPalSubscription: async () => ({
        ...subscription("ACTIVE", futureIso()),
        plan_id: "P-old-year",
        custom_id: undefined,
      }),
    },
  )

  assert.deepEqual(result, { handled: true })
  assert.equal(billing[0].interval, "year")
  assert.equal(profiles["user-1"].subscription_interval, "year")
})

test("browser-first purchase analytics prefers the billing row's provider catalog", async () => {
  const previousLaunchPlan = process.env.PAYPAL_PLAN_ID_PERSONAL_PLAN_LAUNCH_MONTHLY
  process.env.PAYPAL_PLAN_ID_PERSONAL_PLAN_LAUNCH_MONTHLY = "P-launch-month"
  const createdAt = new Date(Date.now() - 60_000).toISOString()
  const { supabase, analyticsOutbox } = createSupabaseStub({
    billing: [
      {
        user_id: "user-1",
        provider_subscription_id: "I-active",
        metadata: {
          pricing_catalog: "personal_plan_launch_v1",
          paypal_plan_id: "P-launch-month",
        },
      },
    ],
    profiles: { "user-1": { id: "user-1", email: "paypal@example.com" } },
    paypalIntents: [
      checkoutIntent({
        created_at: createdAt,
        status: "activated",
        metadata: {},
      }),
    ],
  })

  try {
    await handlePayPalWebhookEvent(paymentEvent("WH-browser-first", "PAYMENT.SALE.COMPLETED"), {
      supabase,
      premiumTierId: "tier-premium",
      freeTierId: "tier-free",
      retrievePayPalSubscription: async () => ({
        ...subscription("ACTIVE", futureIso()),
        plan_id: "P-launch-month",
      }),
      recordBillingAnalytics: true,
      defer: () => undefined,
    })
  } finally {
    if (previousLaunchPlan === undefined)
      delete process.env.PAYPAL_PLAN_ID_PERSONAL_PLAN_LAUNCH_MONTHLY
    else process.env.PAYPAL_PLAN_ID_PERSONAL_PLAN_LAUNCH_MONTHLY = previousLaunchPlan
  }

  assert.deepEqual(analyticsOutbox.map((row) => row.event_name).sort(), [
    "purchase_completed",
    "subscription_started",
  ])
  const purchase = analyticsOutbox.find((row) => row.event_name === "purchase_completed")!
  assert.equal(purchase.source_object_id, "SALE-WH-browser-first")
  assert.equal((purchase.payload as Record<string, unknown>).checkout_reference, "I-active")
  assert.equal(
    (purchase.payload as Record<string, unknown>).pricing_catalog,
    "personal_plan_launch_v1",
  )
  assert.equal((purchase.payload as Record<string, unknown>).plan_id, "premium_month")
  assert.equal((purchase.payload as Record<string, unknown>).paypal_plan_id, "P-launch-month")
})

test("attributed PayPal initial purchase enqueues funnel only when both delivery flags are enabled", async () => {
  const previousAttribution = process.env.FUNNEL_ATTRIBUTION_ENABLED
  const previousDelivery = process.env.BILLING_FUNNEL_DELIVERY_ENABLED
  async function run(attribution: boolean, delivery: boolean) {
    process.env.FUNNEL_ATTRIBUTION_ENABLED = String(attribution)
    process.env.BILLING_FUNNEL_DELIVERY_ENABLED = String(delivery)
    const { supabase, analyticsDeliveries } = createSupabaseStub({
      billing: [{ user_id: "user-1", provider_subscription_id: "I-active" }],
      profiles: { "user-1": { id: "user-1", email: "paypal@example.com" } },
      paypalIntents: [
        checkoutIntent({
          metadata: {
            funnel_session_id: "20000000-0000-4000-8000-000000000002",
            funnel_package_key: "default_organic",
          },
        }),
      ],
    })
    await handlePayPalWebhookEvent(
      paymentEvent(`WH-funnel-${attribution}-${delivery}`, "PAYMENT.SALE.COMPLETED"),
      {
        supabase,
        premiumTierId: "tier-premium",
        freeTierId: "tier-free",
        retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
        recordBillingAnalytics: true,
        defer: () => undefined,
      },
    )
    return analyticsDeliveries.filter((row) => row.destination === "funnel")
  }

  try {
    assert.equal((await run(true, false)).length, 0)
    assert.equal((await run(false, true)).length, 0)
    assert.equal((await run(true, true)).length, 1)
  } finally {
    if (previousAttribution === undefined) delete process.env.FUNNEL_ATTRIBUTION_ENABLED
    else process.env.FUNNEL_ATTRIBUTION_ENABLED = previousAttribution
    if (previousDelivery === undefined) delete process.env.BILLING_FUNNEL_DELIVERY_ENABLED
    else process.env.BILLING_FUNNEL_DELIVERY_ENABLED = previousDelivery
  }
})

test("activation is entitlement-only and the later sale records the initial purchase", async () => {
  const { supabase, analyticsOutbox } = createSupabaseStub({
    paypalIntents: [checkoutIntent({ provider_subscription_id: null, status: "created" })],
  })
  const deps = {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
    recordBillingAnalytics: true,
    defer: () => undefined,
  }

  await handlePayPalWebhookEvent(
    event("WH-activation-first", "BILLING.SUBSCRIPTION.ACTIVATED"),
    deps,
  )
  assert.equal(analyticsOutbox.length, 0)

  await handlePayPalWebhookEvent(paymentEvent("WH-activation-sale", "PAYMENT.SALE.COMPLETED"), deps)
  assert.deepEqual(analyticsOutbox.map((row) => row.event_name).sort(), [
    "purchase_completed",
    "subscription_started",
  ])
})

test("sale-first ACTIVE activation records an initial purchase", async () => {
  const { supabase, analyticsOutbox, billing } = createSupabaseStub({
    paypalIntents: [checkoutIntent({ provider_subscription_id: null, status: "created" })],
  })

  await handlePayPalWebhookEvent(paymentEvent("WH-sale-first", "PAYMENT.SALE.COMPLETED"), {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
    recordBillingAnalytics: true,
    defer: () => undefined,
  })

  assert.equal(billing.length, 1)
  assert.equal(analyticsOutbox.filter((row) => row.event_name === "purchase_completed").length, 1)
})

test("sale-first APPROVED releases its claim and an ACTIVE retry completes", async () => {
  const { supabase, analyticsOutbox, calls } = createSupabaseStub({
    paypalIntents: [checkoutIntent({ provider_subscription_id: null, status: "created" })],
  })
  let providerStatus = "APPROVED"
  const sale = paymentEvent("WH-approved-retry", "PAYMENT.SALE.COMPLETED")
  const deps = {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => subscription(providerStatus, futureIso()),
    recordBillingAnalytics: true,
    defer: () => undefined,
  }

  await assert.rejects(() => handlePayPalWebhookEvent(sale, deps), /is not active yet/)
  assert.equal(
    calls.some((call) => call.table === "billing_webhook_events" && call.op === "delete"),
    true,
  )
  providerStatus = "ACTIVE"
  await handlePayPalWebhookEvent(sale, deps)

  assert.equal(analyticsOutbox.filter((row) => row.event_name === "purchase_completed").length, 1)
})

test("same-sale purchase retry repairs the idempotent initial fan-out", async () => {
  const sale = paymentEvent("WH-same-sale", "PAYMENT.SALE.COMPLETED")
  const { supabase, analyticsOutbox, analyticsDeliveries } = createSupabaseStub({
    billing: [{ user_id: "user-1", provider_subscription_id: "I-active" }],
    profiles: { "user-1": { id: "user-1", email: "paypal@example.com" } },
    paypalIntents: [checkoutIntent()],
    analyticsOutbox: [
      analyticsEvent(
        "paypal:purchase_completed:I-active",
        "purchase_completed",
        "SALE-WH-same-sale",
      ),
    ],
  })

  await handlePayPalWebhookEvent(sale, {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
    recordBillingAnalytics: true,
    defer: () => undefined,
  })

  assert.equal(analyticsOutbox.filter((row) => row.event_name === "purchase_completed").length, 1)
  assert.equal(analyticsOutbox.filter((row) => row.event_name === "subscription_started").length, 1)
  assert.equal(analyticsOutbox.filter((row) => row.event_name === "payment_completed").length, 0)
  assert.equal(analyticsDeliveries.length, 6)
  assert.equal(
    new Set(analyticsDeliveries.map((row) => `${row.outbox_id}:${row.destination}`)).size,
    6,
  )
})

test("an existing purchase forces a different sale to renewal despite an eligible intent", async () => {
  const { supabase, analyticsOutbox } = createSupabaseStub({
    billing: [{ user_id: "user-1", provider_subscription_id: "I-active" }],
    profiles: { "user-1": { id: "user-1", email: "paypal@example.com" } },
    paypalIntents: [checkoutIntent()],
    analyticsOutbox: [
      analyticsEvent("paypal:purchase_completed:I-active", "purchase_completed", "SALE-FIRST"),
    ],
  })

  await handlePayPalWebhookEvent(paymentEvent("WH-renewal", "PAYMENT.SALE.COMPLETED"), {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => ({
      ...subscription("ACTIVE", futureIso()),
      custom_id: "token-active",
    }),
    recordBillingAnalytics: true,
    defer: () => undefined,
  })

  assert.equal(analyticsOutbox.filter((row) => row.event_name === "payment_completed").length, 1)
})

test("an already-recorded same-sale payment is a forward-only historical no-op", async () => {
  const saleId = "SALE-WH-historical"
  const { supabase, analyticsOutbox, analyticsDeliveries } = createSupabaseStub({
    billing: [{ user_id: "user-1", provider_subscription_id: "I-active" }],
    profiles: { "user-1": { id: "user-1", email: "paypal@example.com" } },
    paypalIntents: [],
    analyticsOutbox: [
      analyticsEvent(`paypal:payment_completed:${saleId}`, "payment_completed", saleId),
    ],
  })

  await handlePayPalWebhookEvent(paymentEvent("WH-historical", "PAYMENT.SALE.COMPLETED"), {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => ({
      ...subscription("ACTIVE", futureIso()),
      custom_id: undefined,
    }),
    recordBillingAnalytics: true,
    defer: () => undefined,
  })

  assert.equal(analyticsOutbox.length, 1)
  assert.equal(analyticsOutbox[0].event_name, "payment_completed")
  assert.equal(analyticsDeliveries.length, 0)
})

test("legacy missing and expired intents classify later sales as renewals", async () => {
  for (const paypalIntents of [
    [],
    [checkoutIntent({ status: "expired", expires_at: pastIso() })],
  ]) {
    const { supabase, analyticsOutbox } = createSupabaseStub({
      billing: [{ user_id: "user-1", provider_subscription_id: "I-active" }],
      profiles: { "user-1": { id: "user-1", email: "paypal@example.com" } },
      paypalIntents,
    })
    await handlePayPalWebhookEvent(
      paymentEvent(`WH-legacy-${paypalIntents.length}`, "PAYMENT.SALE.COMPLETED"),
      {
        supabase,
        premiumTierId: "tier-premium",
        freeTierId: "tier-free",
        retrievePayPalSubscription: async () => ({
          ...subscription("ACTIVE", futureIso()),
          custom_id: paypalIntents.length ? "token-active" : undefined,
        }),
        recordBillingAnalytics: true,
        defer: () => undefined,
      },
    )
    assert.equal(analyticsOutbox[0].event_name, "payment_completed")
  }
})

test("malformed sale data grants entitlement but releases the claim before a corrected retry", async () => {
  const { supabase, calls, billing } = createSupabaseStub({
    billing: [{ user_id: "user-1", provider_subscription_id: "I-active" }],
    profiles: { "user-1": { id: "user-1", email: "paypal@example.com" } },
  })
  const malformed: PayPalWebhookEvent = {
    id: "WH-malformed",
    event_type: "PAYMENT.SALE.COMPLETED",
    resource: { billing_agreement_id: "I-active" },
  }

  await assert.rejects(
    () =>
      handlePayPalWebhookEvent(malformed, {
        supabase,
        premiumTierId: "tier-premium",
        freeTierId: "tier-free",
        retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
        recordBillingAnalytics: true,
        defer: () => undefined,
      }),
    /missing sale id/,
  )
  assert.equal(
    calls.some((call) => call.table === "billing_webhook_events" && call.op === "delete"),
    true,
  )
  assert.equal(billing[0].entitlement_status, "active")
  assert.equal(
    calls.some((call) => call.table === "billing_plan_changes"),
    false,
  )

  const corrected = await handlePayPalWebhookEvent(
    paymentEvent("WH-malformed", "PAYMENT.SALE.COMPLETED"),
    {
      supabase,
      premiumTierId: "tier-premium",
      freeTierId: "tier-free",
      retrievePayPalSubscription: async () => ({
        ...subscription("ACTIVE", futureIso()),
        custom_id: undefined,
      }),
      recordBillingAnalytics: true,
      defer: () => undefined,
    },
  )
  assert.deepEqual(corrected, { handled: true })

  await assert.rejects(
    () =>
      handlePayPalWebhookEvent(
        {
          ...paymentEvent("WH-invalid-time", "PAYMENT.SALE.COMPLETED"),
          create_time: "not-a-time",
        },
        {
          supabase,
          premiumTierId: "tier-premium",
          freeTierId: "tier-free",
          retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
          recordBillingAnalytics: true,
          defer: () => undefined,
        },
      ),
    /invalid create_time/,
  )
})

test("quarantined reactivation sale is acknowledged without purchase analytics", async () => {
  const { supabase, analyticsOutbox } = createSupabaseStub({
    paypalIntents: [checkoutIntent({ status: "duplicate", duplicate_reason: "reservation_race" })],
  })

  const result = await handlePayPalWebhookEvent(
    paymentEvent("WH-quarantined-sale", "PAYMENT.SALE.COMPLETED"),
    {
      supabase,
      premiumTierId: "tier-premium",
      freeTierId: "tier-free",
      retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
      cancelPayPalSubscription: async () => undefined,
      recordBillingAnalytics: true,
      defer: () => undefined,
    },
  )

  assert.deepEqual(result, { handled: true })
  assert.equal(analyticsOutbox.length, 0)
})

/* ------------------------------------------------------------------------- *
 * The Premium sheet's freemium lane, wired into this handler (docket rework).
 *
 * The buyer these tests exist for approves in the PayPal popup and closes the tab. No
 * completion call ever runs, so the webhook is the ONLY thing standing between a verified
 * payment and a Personal Plan. Everything below drives the real handler — activation,
 * binding, entitlement mirroring — and only the provisioning service itself is faked.
 * ------------------------------------------------------------------------- */

/** The buyer's own account, resolved by the subscriber e-mail the activation reads. */
const SHEET_PROFILES = { "user-1": { id: "user-1", email: "paypal@example.com" } }

function premiumSheetIntent(patch: Record<string, unknown> = {}) {
  return checkoutIntent({
    id: "intent-sheet",
    source: "premium_sheet",
    status: "created",
    provider_subscription_id: null,
    user_id: "user-1",
    ...patch,
  })
}

function recordingFreemiumDeps(
  provision?: (input: {
    userId: string
    providerReference: string
  }) => Promise<FreemiumProvisioningResult>,
) {
  const calls: { userId: string; providerReference: string }[] = []
  return {
    calls,
    deps: {
      freemiumEnabled: () => true,
      provisionFreemiumPurchase: async (input: { userId: string; providerReference: string }) => {
        calls.push(input)
        return (await provision?.(input)) ?? PROVISIONED
      },
      captureFreemiumProvisioningException: (() => {}) as never,
    },
  }
}

const PROVISIONED: FreemiumProvisioningResult = {
  outcome: "provisioned",
  enrollmentSourceId: "admission-1",
  personalPlanId: "plan-1",
  needVersionId: "need-1",
  routineAccepted: true,
}

test("approve-then-close: the PayPal activation alone provisions the sheet buyer's plan", async () => {
  const { supabase, billing, profiles } = createSupabaseStub({
    paypalIntents: [premiumSheetIntent()],
    profiles: { ...SHEET_PROFILES },
  })
  const { calls, deps } = recordingFreemiumDeps()

  const result = await handlePayPalWebhookEvent(
    event("WH-sheet-activated", "BILLING.SUBSCRIPTION.ACTIVATED"),
    {
      supabase,
      premiumTierId: "tier-premium",
      freeTierId: "tier-free",
      retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso(30)),
      ...deps,
    },
  )

  assert.deepEqual(result, { handled: true })
  // Entitlement AND plan: the provider reference is the subscription id, which is exactly
  // what the sheet's completion endpoint provisions against — one admission for both lanes.
  assert.deepEqual(calls, [{ userId: "user-1", providerReference: "I-active" }])
  assert.equal(billing[0].entitlement_status, "active")
  assert.equal(profiles["user-1"].subscription_tier_id, "tier-premium")
})

test("a legacy PayPal activation provisions nothing — admission is never inferred", async () => {
  for (const intent of [checkoutIntent({ provider_subscription_id: null, status: "created" })]) {
    const { supabase, billing } = createSupabaseStub({
      paypalIntents: [intent],
      profiles: { ...SHEET_PROFILES },
    })
    const { calls, deps } = recordingFreemiumDeps()

    await handlePayPalWebhookEvent(event("WH-legacy-activated", "BILLING.SUBSCRIPTION.ACTIVATED"), {
      supabase,
      premiumTierId: "tier-premium",
      freeTierId: "tier-free",
      retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
      ...deps,
    })

    // Byte-identical to the pre-rework path: entitlement mirrored, nothing else touched.
    assert.deepEqual(calls, [])
    assert.equal(billing[0].entitlement_status, "active")
  }
})

test("the sheet's own PayPal purchase provisions nothing while the flag is off", async () => {
  const { supabase, billing } = createSupabaseStub({
    paypalIntents: [premiumSheetIntent()],
    profiles: { ...SHEET_PROFILES },
  })
  const { calls, deps } = recordingFreemiumDeps()

  await handlePayPalWebhookEvent(event("WH-sheet-flag-off", "BILLING.SUBSCRIPTION.ACTIVATED"), {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
    ...deps,
    freemiumEnabled: () => false,
  })

  assert.deepEqual(calls, [])
  assert.equal(billing[0].entitlement_status, "active")
})

test("an intent naming a different account unlocks nobody, and does not fail the delivery", async () => {
  // The plan's `enrollment_purchase_source_id` pin is permanent, so provisioning the intent's
  // user while PayPal's own subscriber identity resolved another account is unrecoverable.
  const { supabase, billing } = createSupabaseStub({
    paypalIntents: [premiumSheetIntent({ user_id: "someone-else" })],
    profiles: { ...SHEET_PROFILES },
  })
  const { calls, deps } = recordingFreemiumDeps()

  const result = await handlePayPalWebhookEvent(
    event("WH-sheet-mismatch", "BILLING.SUBSCRIPTION.ACTIVATED"),
    {
      supabase,
      premiumTierId: "tier-premium",
      freeTierId: "tier-free",
      retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
      ...deps,
    },
  )

  assert.deepEqual(result, { handled: true })
  assert.deepEqual(calls, [])
  assert.equal(billing[0].entitlement_status, "active")
})

test("a failed provisioning fails the delivery, releases the claim, and the redelivery converges", async () => {
  const {
    supabase,
    calls: dbCalls,
    billing,
  } = createSupabaseStub({
    paypalIntents: [premiumSheetIntent()],
    profiles: { ...SHEET_PROFILES },
  })
  let attempts = 0
  const { calls, deps } = recordingFreemiumDeps(async () => {
    attempts += 1
    if (attempts === 1) throw new Error("provisioning down")
    return PROVISIONED
  })
  const activated = event("WH-sheet-retry", "BILLING.SUBSCRIPTION.ACTIVATED")
  const handlerDeps = {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
    ...deps,
  }

  await assert.rejects(
    () => handlePayPalWebhookEvent(activated, handlerDeps),
    /freemium PayPal provisioning must be retried \(provisioning_error\)/,
  )
  // The claim has to be gone, or PayPal's redelivery would be dropped as a duplicate and the
  // buyer would stay paid-and-planless forever — the exact failure this lane exists to close.
  assert.equal(
    dbCalls.some((call) => call.table === "billing_webhook_events" && call.op === "delete"),
    true,
  )

  await handlePayPalWebhookEvent(activated, handlerDeps)

  assert.deepEqual(calls, [
    { userId: "user-1", providerReference: "I-active" },
    { userId: "user-1", providerReference: "I-active" },
  ])
  assert.equal(billing.length, 1)
})

test("a plan with no accepted Routine demands a redelivery instead of reporting success", async () => {
  const { supabase } = createSupabaseStub({
    paypalIntents: [premiumSheetIntent()],
    profiles: { ...SHEET_PROFILES },
  })
  const { deps } = recordingFreemiumDeps(async () => ({ ...PROVISIONED, routineAccepted: false }))

  await assert.rejects(
    () =>
      handlePayPalWebhookEvent(event("WH-sheet-no-routine", "BILLING.SUBSCRIPTION.ACTIVATED"), {
        supabase,
        premiumTierId: "tier-premium",
        freeTierId: "tier-free",
        retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
        ...deps,
      }),
    /routine_not_accepted/,
  )
})

test("a blocked provisioning is reported but acknowledged — a redelivery cannot fix it", async () => {
  const { supabase } = createSupabaseStub({
    paypalIntents: [premiumSheetIntent()],
    profiles: { ...SHEET_PROFILES },
  })
  const { deps } = recordingFreemiumDeps(async () => ({ outcome: "no_quiz_artifact" }))

  const result = await handlePayPalWebhookEvent(
    event("WH-sheet-blocked", "BILLING.SUBSCRIPTION.ACTIVATED"),
    {
      supabase,
      premiumTierId: "tier-premium",
      freeTierId: "tier-free",
      retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
      ...deps,
    },
  )

  assert.deepEqual(result, { handled: true })
})

test("the initial sale is a second chance at provisioning; a later renewal is not", async () => {
  const { supabase } = createSupabaseStub({
    paypalIntents: [premiumSheetIntent({ provider_subscription_id: "I-active" })],
    profiles: { ...SHEET_PROFILES },
  })
  const { calls, deps } = recordingFreemiumDeps()
  const handlerDeps = {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
    recordBillingAnalytics: true,
    defer: () => undefined,
    ...deps,
  }

  await handlePayPalWebhookEvent(paymentEvent("WH-sheet-sale", "PAYMENT.SALE.COMPLETED"), {
    ...handlerDeps,
  })
  assert.deepEqual(calls, [{ userId: "user-1", providerReference: "I-active" }])

  // A renewal quarter later: the same subscription, the same intent row — but the intent's
  // 24h window is long gone, so this sale is not a purchase and re-enters nothing.
  const renewal = paymentEvent("WH-sheet-renewal", "PAYMENT.SALE.COMPLETED")
  renewal.create_time = new Date(Date.now() + 90 * 86_400_000).toISOString()
  await handlePayPalWebhookEvent(renewal, handlerDeps)

  assert.equal(calls.length, 1)
})

function checkoutIntent(patch: Record<string, unknown> = {}) {
  return {
    id: "intent-1",
    token: "token-active",
    interval: "month",
    source: "pricing_page",
    status: "approved",
    provider_subscription_id: "I-active",
    lead_id: null,
    email: "paypal@example.com",
    user_id: null,
    expires_at: futureIso(),
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    metadata: {},
    ...patch,
  }
}

function analyticsEvent(eventKey: string, eventName: string, sourceObjectId: string) {
  return {
    id: `outbox-seeded-${eventName}`,
    event_key: eventKey,
    event_name: eventName,
    user_id: "user-1",
    provider: "paypal",
    provider_subscription_id: "I-active",
    source_object_id: sourceObjectId,
    occurred_at: new Date().toISOString(),
    payload: {},
  }
}

function event(id: string, eventType: string): PayPalWebhookEvent {
  return { id, event_type: eventType, resource: { id: "I-active" } }
}

function paymentEvent(id: string, eventType: string): PayPalWebhookEvent {
  return {
    id,
    event_type: eventType,
    create_time: new Date().toISOString(),
    resource: { id: `SALE-${id}`, billing_agreement_id: "I-active" },
  }
}

function subscription(status: string, nextBillingTime: string | null): PayPalSubscription {
  return {
    id: "I-active",
    status,
    plan_id: "P-month",
    custom_id: "token-active",
    subscriber: { payer_id: "payer-1", email_address: "paypal@example.com" },
    billing_info: nextBillingTime ? { next_billing_time: nextBillingTime } : {},
  }
}
