import assert from "node:assert/strict"
import test from "node:test"
import {
  findVisibleBillingSubscriptionForUser,
  upsertBillingSubscription,
} from "../src/lib/billing/subscriptions"
import {
  ensurePayPalCheckoutAccount,
  ensurePayPalCheckoutAccountForToken,
  paypalCheckoutActivationHash,
} from "../src/lib/paypal/checkout-activation"
import { handlePayPalWebhookEvent } from "../src/lib/paypal/webhook-handlers"
import { toBillingSubscriptionInputFromPayPal } from "../src/lib/paypal/subscription-shapes"
import type {
  BillingSubscriptionInput,
  BillingSubscriptionRow,
  SupabaseBillingClient,
} from "../src/lib/billing/types"
import type { PayPalSubscription } from "../src/lib/paypal/subscription-shapes"

type BillingSubscriptionWithProviderEmail = BillingSubscriptionRow & {
  provider_subscriber_email: string | null
}

type AuthUserStub = {
  id: string
  email: string
  app_metadata?: Record<string, unknown>
}

function futureIso() {
  return new Date(Date.now() + 86_400_000).toISOString()
}

function createBillingRow(
  row: Partial<BillingSubscriptionWithProviderEmail> = {},
  index = 0,
): BillingSubscriptionWithProviderEmail {
  return {
    id: row.id ?? `billing-${index + 1}`,
    user_id: row.user_id ?? "user-1",
    provider: row.provider ?? "paypal",
    provider_customer_id: row.provider_customer_id ?? null,
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
  }
}

function createSupabaseStub(seed?: {
  billing?: Partial<BillingSubscriptionWithProviderEmail>[]
  profiles?: Record<string, Record<string, unknown>>
  authUsers?: Record<string, AuthUserStub>
  paypalIntents?: Array<Record<string, unknown>>
}) {
  const billing = (seed?.billing ?? []).map((row, index) => createBillingRow(row, index))
  const profiles = seed?.profiles ?? {}
  const authUsers = seed?.authUsers ?? {}
  const paypalIntents = seed?.paypalIntents ?? []
  const webhookEvents = new Set<string>()

  function makeQuery(table: string) {
    const state: {
      select?: string
      filters: Array<{ column: string; value: unknown; op: "eq" | "ilike" | "in" | "is" }>
      order?: { column: string; ascending: boolean }
    } = { filters: [] }

    function rows() {
      if (table === "billing_subscriptions") return billing
      if (table === "profiles") return Object.values(profiles)
      if (table === "paypal_checkout_intents") return paypalIntents
      return []
    }

    function applyFilters(input: Record<string, unknown>[]) {
      return input.filter((row) =>
        state.filters.every((filter) => {
          if (filter.op === "eq") return row[filter.column] === filter.value
          if (filter.op === "ilike") {
            return (
              String(row[filter.column] ?? "").toLowerCase() === String(filter.value).toLowerCase()
            )
          }
          if (filter.op === "is") return row[filter.column] === filter.value
          if (filter.op === "in") return (filter.value as unknown[]).includes(row[filter.column])
          return false
        }),
      )
    }

    function applyOrder(input: Record<string, unknown>[]) {
      if (!state.order) return input
      return [...input].sort((left, right) => {
        const leftValue = String(left[state.order!.column] ?? "")
        const rightValue = String(right[state.order!.column] ?? "")
        if (leftValue === rightValue) return 0
        const direction = state.order!.ascending ? 1 : -1
        return leftValue > rightValue ? direction : -direction
      })
    }

    function applySelect(input: Record<string, unknown>) {
      if (!state.select || state.select === "*") return input
      const selected = state.select.split(",").map((column) => column.trim())
      return Object.fromEntries(selected.map((column) => [column, input[column]]))
    }

    async function resolveRows() {
      const filtered = applyFilters(rows() as unknown as Record<string, unknown>[])
      return { data: applyOrder(filtered).map(applySelect), error: null }
    }

    const builder = {
      select(columns = "*") {
        state.select = columns
        return builder
      },
      eq(column: string, value: unknown) {
        state.filters.push({ column, value, op: "eq" })
        return builder
      },
      ilike(column: string, value: unknown) {
        state.filters.push({ column, value, op: "ilike" })
        return builder
      },
      is(column: string, value: unknown) {
        state.filters.push({ column, value, op: "is" })
        return builder
      },
      in(column: string, value: unknown[]) {
        state.filters.push({ column, value, op: "in" })
        return builder
      },
      order(column: string, options: { ascending?: boolean } = {}) {
        state.order = { column, ascending: options.ascending !== false }
        return builder
      },
      maybeSingle: async () => {
        const { data } = await resolveRows()
        return { data: data[0] ?? null, error: null }
      },
      single: async () => {
        const { data } = await resolveRows()
        return { data: data[0] ?? null, error: null }
      },
      upsert(row: Record<string, unknown>) {
        if (table === "billing_subscriptions") {
          const existing = billing.find(
            (candidate) =>
              candidate.provider === row.provider &&
              candidate.provider_subscription_id === row.provider_subscription_id,
          )
          if (existing) {
            Object.assign(existing, row, { updated_at: row.updated_at ?? existing.updated_at })
          } else {
            billing.push(
              createBillingRow(
                row as Partial<BillingSubscriptionWithProviderEmail>,
                billing.length,
              ),
            )
          }
        } else if (table === "profiles") {
          const id = String(row.id)
          profiles[id] = {
            ...(profiles[id] ?? {}),
            ...row,
          }
        }
        const saved =
          table === "billing_subscriptions"
            ? billing.find(
                (candidate) =>
                  candidate.provider === row.provider &&
                  candidate.provider_subscription_id === row.provider_subscription_id,
              )
            : row
        return {
          select: (columns = "*") => {
            state.select = columns
            return {
              single: async () => ({
                data: saved ? applySelect(saved as unknown as Record<string, unknown>) : null,
                error: null,
              }),
            }
          },
        }
      },
      update(patch: Record<string, unknown>) {
        return {
          eq(column: string, value: unknown) {
            state.filters.push({ column, value, op: "eq" })
            return this
          },
          is(column: string, value: unknown) {
            state.filters.push({ column, value, op: "is" })
            return this
          },
          in(column: string, value: unknown[]) {
            state.filters.push({ column, value, op: "in" })
            return this
          },
          select(columns = "*") {
            state.select = columns
            const matched = applyFilters(rows() as unknown as Record<string, unknown>[])
            for (const row of matched) Object.assign(row, patch)
            return {
              maybeSingle: async () => ({
                data: matched[0] ? applySelect(matched[0]) : null,
                error: null,
              }),
            }
          },
          then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
            const matched = applyFilters(rows() as unknown as Record<string, unknown>[])
            for (const row of matched) Object.assign(row, patch)
            Promise.resolve({ data: matched, error: null }).then(resolve, reject)
          },
        }
      },
      insert(row: Record<string, unknown>) {
        if (table === "billing_webhook_events") {
          const key = `${row.provider}:${row.provider_event_id}`
          if (webhookEvents.has(key)) {
            return Promise.resolve({
              data: null,
              error: { code: "23505", message: "duplicate key value violates unique constraint" },
            })
          }
          webhookEvents.add(key)
        }
        return Promise.resolve({ data: row, error: null })
      },
      delete() {
        return {
          eq(column: string, value: unknown) {
            state.filters.push({ column, value, op: "eq" })
            return this
          },
          then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
            Promise.resolve({ data: null, error: null }).then(resolve, reject)
          },
        }
      },
      then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
        resolveRows().then(resolve, reject)
      },
    }

    return builder
  }

  return {
    billing,
    profiles,
    authUsers,
    paypalIntents,
    supabase: {
      from(table: string) {
        return makeQuery(table)
      },
      auth: {
        admin: {
          async createUser(args: { email: string; app_metadata?: Record<string, unknown> }) {
            const existing = Object.values(authUsers).find(
              (user) => user.email.toLowerCase() === args.email.toLowerCase(),
            )
            if (existing) {
              return { data: { user: null }, error: { status: 422, message: "duplicate" } }
            }
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
    } as unknown as SupabaseBillingClient,
  }
}

function paypalSubscription(
  email = "paypal-buyer@example.com",
  id = "I-active",
): PayPalSubscription {
  return {
    id,
    status: "ACTIVE",
    plan_id: "P-month",
    subscriber: { payer_id: "payer-1", email_address: email },
    billing_info: { next_billing_time: futureIso() },
  }
}

test("upsertBillingSubscription writes provider_subscriber_email on first insert", async () => {
  const { billing, supabase } = createSupabaseStub()

  const row = await upsertBillingSubscription(supabase, {
    user_id: "user-1",
    provider: "paypal",
    provider_customer_id: "payer-1",
    provider_subscriber_email: "payer@example.com",
    provider_subscription_id: "I-123",
    provider_status: "ACTIVE",
    entitlement_status: "active",
  })

  assert.equal(billing.length, 1)
  assert.equal(billing[0].provider_subscriber_email, "payer@example.com")
  assert.equal(row.provider_subscriber_email, "payer@example.com")
})

test("upsertBillingSubscription updates provider_subscriber_email when provider data changes", async () => {
  const { billing, supabase } = createSupabaseStub({
    billing: [
      {
        provider_subscription_id: "I-123",
        provider_subscriber_email: "old-payer@example.com",
      },
    ],
  })

  await upsertBillingSubscription(supabase, {
    user_id: "user-1",
    provider: "paypal",
    provider_subscriber_email: "new-payer@example.com",
    provider_subscription_id: "I-123",
    provider_status: "ACTIVE",
    entitlement_status: "active",
  })

  assert.equal(billing.length, 1)
  assert.equal(billing[0].provider_subscriber_email, "new-payer@example.com")
})

test("upsertBillingSubscription preserves provider_subscriber_email when provider payload omits it", async () => {
  const { billing, supabase } = createSupabaseStub({
    billing: [
      {
        provider_subscription_id: "I-123",
        provider_subscriber_email: "payer@example.com",
      },
    ],
  })
  const input: BillingSubscriptionInput = {
    user_id: "user-1",
    provider: "paypal",
    provider_subscription_id: "I-123",
    provider_status: "SUSPENDED",
    entitlement_status: "past_due",
    provider_subscriber_email: undefined,
  }

  await upsertBillingSubscription(supabase, input)

  assert.equal(billing[0].provider_status, "SUSPENDED")
  assert.equal(billing[0].provider_subscriber_email, "payer@example.com")
})

test("upsertBillingSubscription keeps existing rows with no provider_subscriber_email valid", async () => {
  const { billing, supabase } = createSupabaseStub({
    billing: [
      {
        provider_subscription_id: "I-123",
        provider_subscriber_email: null,
      },
    ],
  })

  await upsertBillingSubscription(supabase, {
    user_id: "user-1",
    provider: "paypal",
    provider_subscription_id: "I-123",
    provider_status: "SUSPENDED",
    entitlement_status: "past_due",
  })

  assert.equal(billing.length, 1)
  assert.equal(billing[0].provider_status, "SUSPENDED")
  assert.equal(billing[0].provider_subscriber_email, null)
})

test("findVisibleBillingSubscriptionForUser returns provider_subscriber_email", async () => {
  const { supabase } = createSupabaseStub({
    billing: [
      {
        user_id: "user-1",
        provider_subscription_id: "I-123",
        provider_subscriber_email: "payer@example.com",
      },
    ],
  })

  const row = await findVisibleBillingSubscriptionForUser(supabase, "user-1")

  assert.equal(row?.provider_subscriber_email, "payer@example.com")
})

test("toBillingSubscriptionInputFromPayPal maps subscriber email as lowercase provider metadata", () => {
  const row = toBillingSubscriptionInputFromPayPal(
    paypalSubscription("PayPal-Buyer@Example.COM"),
    "user-1",
    "month",
  )

  assert.equal(row.provider_subscriber_email, "paypal-buyer@example.com")
})

test("PayPal activation uses deps.accountEmail for an existing Chaarlie account", async () => {
  const { supabase, profiles, billing, authUsers } = createSupabaseStub({
    profiles: {
      "existing-user": {
        id: "existing-user",
        email: "lead@example.com",
      },
    },
    authUsers: {
      "existing-user": {
        id: "existing-user",
        email: "lead@example.com",
        app_metadata: {
          checkout_activation_session_hash: paypalCheckoutActivationHash("checkout-token"),
        },
      },
    },
  })
  const linked: unknown[][] = []

  const result = await ensurePayPalCheckoutAccount(paypalSubscription("paypal-buyer@example.com"), {
    supabase: supabase as any,
    premiumTierId: "tier-premium",
    activationKey: "checkout-token",
    accountEmail: " Lead@Example.COM ",
    interval: "month",
    linkQuizToProfile: async (...args) => {
      linked.push(args)
    },
  })

  assert.equal(result.status, "active")
  if (result.status !== "active") throw new Error("expected active result")
  assert.equal(result.userId, "existing-user")
  assert.equal(result.email, "lead@example.com")
  assert.equal(result.providerSubscriberEmail, "paypal-buyer@example.com")
  assert.equal(Object.keys(authUsers).length, 1)
  assert.equal(profiles["existing-user"].email, "lead@example.com")
  assert.equal(billing[0].provider_subscriber_email, "paypal-buyer@example.com")
  assert.deepEqual(linked, [["existing-user", "lead@example.com", undefined]])
})

test("PayPal activation creates Chaarlie account from deps.accountEmail and keeps password setup token based", async () => {
  const { supabase, profiles, billing, authUsers } = createSupabaseStub()

  const result = await ensurePayPalCheckoutAccount(paypalSubscription("paypal-buyer@example.com"), {
    supabase: supabase as any,
    premiumTierId: "tier-premium",
    activationKey: "checkout-token",
    accountEmail: "Lead@Example.COM",
    interval: "month",
  })

  assert.equal(result.status, "active")
  if (result.status !== "active") throw new Error("expected active result")
  assert.equal(result.email, "lead@example.com")
  assert.equal(result.providerSubscriberEmail, "paypal-buyer@example.com")
  assert.equal(result.canSetInitialPassword, true)
  assert.equal(Object.values(authUsers)[0].email, "lead@example.com")
  assert.equal(
    Object.values(authUsers)[0].app_metadata?.checkout_activation_session_hash,
    paypalCheckoutActivationHash("checkout-token"),
  )
  assert.equal(Object.values(profiles)[0].email, "lead@example.com")
  assert.equal(billing[0].provider_subscriber_email, "paypal-buyer@example.com")
})

test("PayPal activation accepts missing subscriber email when Chaarlie account email is present", async () => {
  const { supabase, profiles, billing, authUsers } = createSupabaseStub()
  const subscription = paypalSubscription("paypal-buyer@example.com")
  subscription.subscriber = { payer_id: "payer-1" }

  const result = await ensurePayPalCheckoutAccount(subscription, {
    supabase: supabase as any,
    premiumTierId: "tier-premium",
    accountEmail: "Lead@Example.COM",
    interval: "month",
  })

  assert.equal(result.status, "active")
  if (result.status !== "active") throw new Error("expected active result")
  assert.equal(result.email, "lead@example.com")
  assert.equal(result.providerSubscriberEmail, null)
  assert.equal(Object.values(authUsers)[0].email, "lead@example.com")
  assert.equal(Object.values(profiles)[0].email, "lead@example.com")
  assert.equal(billing[0].provider_subscriber_email, null)
})

test("PayPal activation falls back to subscriber email when checkout account email is missing", async () => {
  const { supabase, profiles, authUsers } = createSupabaseStub()

  const result = await ensurePayPalCheckoutAccount(paypalSubscription("PayPal-Buyer@Example.COM"), {
    supabase: supabase as any,
    premiumTierId: "tier-premium",
    accountEmail: null,
    interval: "month",
  })

  assert.equal(result.status, "active")
  if (result.status !== "active") throw new Error("expected active result")
  assert.equal(result.email, "paypal-buyer@example.com")
  assert.equal(result.providerSubscriberEmail, "paypal-buyer@example.com")
  assert.equal(Object.values(authUsers)[0].email, "paypal-buyer@example.com")
  assert.equal(Object.values(profiles)[0].email, "paypal-buyer@example.com")
})

test("ensurePayPalCheckoutAccountForToken keeps checkout intent email as Chaarlie account email", async () => {
  const { supabase, paypalIntents } = createSupabaseStub({
    paypalIntents: [
      {
        id: "intent-1",
        token: "checkout-token",
        interval: "month",
        source: "pricing_page",
        status: "approved",
        provider_subscription_id: null,
        lead_id: null,
        email: "lead@example.com",
        user_id: null,
        expires_at: futureIso(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {},
      },
    ],
  })

  const result = await ensurePayPalCheckoutAccountForToken("checkout-token", {
    supabase: supabase as any,
    premiumTierId: "tier-premium",
  })

  assert.deepEqual(result, { status: "pending" })
  assert.equal(paypalIntents[0].email, "lead@example.com")
})

test("webhook-first PayPal activation uses bound checkout intent email and keeps PayPal email in provider metadata", async () => {
  const { supabase, profiles, billing, authUsers, paypalIntents } = createSupabaseStub({
    paypalIntents: [
      {
        id: "intent-1",
        token: "checkout-token",
        interval: "month",
        source: "pricing_page",
        status: "approved",
        provider_subscription_id: null,
        lead_id: "lead-123",
        email: "lead@example.com",
        user_id: null,
        expires_at: futureIso(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {},
      },
    ],
  })
  const linked: unknown[][] = []

  const result = await handlePayPalWebhookEvent(
    {
      id: "WH-identity",
      event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
      resource: { id: "I-active" },
    },
    {
      supabase: supabase as any,
      premiumTierId: "tier-premium",
      freeTierId: "tier-free",
      retrievePayPalSubscription: async () => ({
        ...paypalSubscription("paypal-buyer@example.com"),
        custom_id: "checkout-token",
      }),
      linkQuizToProfile: async (...args) => {
        linked.push(args)
      },
    },
  )

  assert.deepEqual(result, { handled: true })
  assert.equal(Object.values(authUsers)[0].email, "lead@example.com")
  assert.equal(Object.values(profiles)[0].email, "lead@example.com")
  assert.equal(billing[0].provider_subscriber_email, "paypal-buyer@example.com")
  assert.equal(paypalIntents[0].email, "lead@example.com")
  assert.equal(paypalIntents[0].provider_subscription_id, "I-active")
  assert.equal(paypalIntents[0].status, "activated")
  assert.deepEqual(linked, [[Object.values(authUsers)[0].id, "lead@example.com", "lead-123"]])
})

test("webhook-first PayPal activation cancels duplicate fallback subscriber email access", async () => {
  const { supabase, paypalIntents, billing } = createSupabaseStub({
    billing: [
      {
        user_id: "existing-user",
        provider: "paypal",
        provider_subscription_id: "I-existing",
        entitlement_status: "active",
      },
    ],
    profiles: {
      "existing-user": {
        id: "existing-user",
        email: "paypal-buyer@example.com",
      },
    },
    paypalIntents: [
      {
        id: "intent-1",
        token: "checkout-token",
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
    ],
  })
  const cancelled: string[] = []

  const result = await handlePayPalWebhookEvent(
    {
      id: "WH-duplicate-fallback",
      event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
      resource: { id: "I-duplicate" },
    },
    {
      supabase: supabase as any,
      premiumTierId: "tier-premium",
      freeTierId: "tier-free",
      retrievePayPalSubscription: async () => ({
        ...paypalSubscription("paypal-buyer@example.com", "I-duplicate"),
        custom_id: "checkout-token",
      }),
      cancelPayPalSubscription: async (subscriptionId) => {
        cancelled.push(subscriptionId)
      },
    },
  )

  assert.deepEqual(result, { handled: true })
  assert.deepEqual(cancelled, ["I-duplicate"])
  assert.equal(paypalIntents[0].provider_subscription_id, "I-duplicate")
  assert.equal(paypalIntents[0].status, "duplicate")
  assert.equal(paypalIntents[0].duplicate_reason, "intent_email_already_has_access")
  assert.equal(billing.length, 1)
})
