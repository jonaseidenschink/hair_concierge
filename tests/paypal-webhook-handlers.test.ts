import assert from "node:assert/strict"
import test from "node:test"
import {
  handlePayPalWebhookEvent,
  type PayPalWebhookEvent,
} from "../src/lib/paypal/webhook-handlers"
import type { BillingSubscriptionRow } from "../src/lib/billing/types"
import type { PayPalSubscription } from "../src/lib/paypal/subscription-shapes"

function futureIso(days = 1) {
  return new Date(Date.now() + days * 86_400_000).toISOString()
}

function pastIso() {
  return new Date(Date.now() - 86_400_000).toISOString()
}

function createSupabaseStub(seed?: {
  billing?: Partial<BillingSubscriptionRow>[]
  profiles?: Record<string, Record<string, unknown>>
  paypalIntents?: Array<Record<string, unknown>>
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
    cancelled_at: row.cancelled_at ?? null,
    metadata: row.metadata ?? {},
    created_at: row.created_at ?? new Date().toISOString(),
    updated_at: row.updated_at ?? new Date().toISOString(),
  }))

  function tableRows(table: string) {
    if (table === "billing_subscriptions") return billing
    if (table === "profiles") return Object.values(profiles)
    if (table === "paypal_checkout_intents") return paypalIntents
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
      maybeSingle: async () => {
        const { data: rows } = await resolveRows()
        return { data: rows[0] ?? null, error: null }
      },
      single: async () => {
        const { data: rows } = await resolveRows()
        return { data: rows[0] ?? null, error: null }
      },
      upsert(row: Record<string, unknown>) {
        calls.push({ table, op: "upsert", row })
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
  })

  await handlePayPalWebhookEvent(event("WH-failed", "BILLING.SUBSCRIPTION.PAYMENT.FAILED"), {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => subscription("ACTIVE", futureIso()),
  })

  assert.equal(billing[0].entitlement_status, "past_due")
  assert.equal(profiles["user-1"].subscription_status, "past_due")
  assert.equal(profiles["user-1"].subscription_tier_id, "tier-premium")
})

test("BILLING.SUBSCRIPTION.CANCELLED keeps future paid-through access", async () => {
  const periodEnd = futureIso(10)
  const { supabase, billing, profiles } = createSupabaseStub({
    billing: [{ user_id: "user-1", provider_subscription_id: "I-active" }],
    profiles: { "user-1": { id: "user-1", subscription_status: "active" } },
  })

  await handlePayPalWebhookEvent(event("WH-cancelled", "BILLING.SUBSCRIPTION.CANCELLED"), {
    supabase,
    premiumTierId: "tier-premium",
    freeTierId: "tier-free",
    retrievePayPalSubscription: async () => subscription("CANCELLED", periodEnd),
  })

  assert.equal(billing[0].entitlement_status, "canceled")
  assert.equal(billing[0].cancel_at_period_end, true)
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

function event(id: string, eventType: string): PayPalWebhookEvent {
  return { id, event_type: eventType, resource: { id: "I-active" } }
}

function paymentEvent(id: string, eventType: string): PayPalWebhookEvent {
  return { id, event_type: eventType, resource: { billing_agreement_id: "I-active" } }
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
