import { expect, test } from "@playwright/test"
import {
  handleCheckoutSessionCompleted,
  handleCheckoutSessionAsyncPaymentSucceeded,
  handleCheckoutSessionAsyncPaymentFailed,
  handleChargeDisputeCreated,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaymentFailed,
  type HandlerDeps,
} from "../src/lib/stripe/webhook-handlers"

function stubDeps() {
  const calls: any[] = []
  const users: Record<string, { id: string; email: string }> = {}
  const profiles: Record<string, any> = {}
  const billing: any[] = []
  const charges: Record<string, any> = {}
  const invoices: Record<string, any> = {}
  const invoicePayments: any[] = []
  const retrievedCharges: Array<{ id: string; expand?: string[] }> = []
  const retrievedInvoices: Array<{ id: string; expand?: string[] }> = []
  const listedInvoicePayments: any[] = []
  const canceledSubscriptions: string[] = []
  const beforeProfileUpdate: Array<() => void> = []

  const deps: HandlerDeps = {
    supabase: {
      auth: {
        admin: {
          async createUser({ email }: { email: string }) {
            calls.push(["createUser", email])
            const id = `user-${Object.keys(users).length + 1}`
            users[email] = { id, email }
            profiles[id] = { id, email, subscription_status: null }
            return { data: { user: users[email] }, error: null }
          },
        },
      },
      from(table: string) {
        const filters: Array<[string, string | string[]]> = []
        const tableApi = {
          select() {
            return this
          },
          eq(col: string, val: string) {
            calls.push([`select-${table}-${col}`, val])
            filters.push([col, val])
            return this
          },
          in(col: string, values: string[]) {
            calls.push([`select-${table}-${col}-in`, values])
            filters.push([col, values])
            return this
          },
          order() {
            return this
          },
          limit() {
            return this
          },
          async maybeSingle() {
            const row = rowsForTable().find((row: any) =>
              filters.every(([col, val]) =>
                Array.isArray(val) ? val.includes(row[col]) : row[col] === val,
              ),
            )
            return { data: row ?? null, error: null }
          },
          update(patch: any) {
            const updateFilters: Array<[string, string]> = []
            let appliedRows: any[] | null = null
            const applyUpdate = () => {
              if (appliedRows) return appliedRows
              if (table === "profiles") {
                for (const hook of beforeProfileUpdate.splice(0)) hook()
              }
              appliedRows = []
              for (const row of rowsForTable()) {
                if (updateFilters.every(([col, val]) => row[col] === val)) {
                  Object.assign(row, patch)
                  appliedRows.push(row)
                }
              }
              return appliedRows
            }
            const builder = {
              eq(col: string, val: string) {
                calls.push([`update-${table}-${col}`, val, patch])
                updateFilters.push([col, val])
                return builder
              },
              select() {
                return builder
              },
              async maybeSingle() {
                const row = applyUpdate()[0]
                return { data: row ?? null, error: null }
              },
              then(resolve: (value: { error: null }) => unknown) {
                applyUpdate()
                return Promise.resolve({ error: null }).then(resolve)
              },
            }
            return builder
          },
          upsert(row: any) {
            calls.push([`upsert-${table}`, row])
            if (table === "profiles") {
              profiles[row.id] = {
                ...(profiles[row.id] ?? {}),
                ...row,
              }
            } else if (table === "billing_subscriptions") {
              const existing = billing.find(
                (candidate) =>
                  candidate.provider === row.provider &&
                  candidate.provider_subscription_id === row.provider_subscription_id,
              )
              if (existing) Object.assign(existing, row)
              else billing.push(row)
            }
            return {
              error: null,
              select: () => ({
                single: async () => ({ data: row, error: null }),
              }),
            }
          },
        }
        function rowsForTable() {
          if (table === "profiles") return Object.values(profiles)
          if (table === "billing_subscriptions") return billing
          if (table === "billing_subscription_plan_changes") return []
          return Object.values(users)
        }
        return tableApi
      },
    } as any,
    stripe: {
      charges: {
        async retrieve(id: string, params?: { expand?: string[] }) {
          retrievedCharges.push({ id, expand: params?.expand })
          return charges[id] ?? { id, customer: null }
        },
      },
      invoicePayments: {
        async list(params?: any) {
          listedInvoicePayments.push(params)
          return {
            data: invoicePayments.filter((invoicePayment) => {
              if (!params?.payment) return true
              const payment = invoicePayment.payment ?? {}
              return (
                payment.type === params.payment.type &&
                payment.payment_intent === params.payment.payment_intent
              )
            }),
          }
        },
      },
      invoices: {
        async retrieve(id: string, params?: { expand?: string[] }) {
          retrievedInvoices.push({ id, expand: params?.expand })
          return invoices[id] ?? { id }
        },
      },
      subscriptions: {
        async retrieve(_id: string) {
          return {
            id: "sub_1",
            items: {
              data: [
                {
                  price: { interval: "month", interval_count: 1 },
                  current_period_end: 1_800_000_000,
                },
              ],
            },
          } as any
        },
        async cancel(id: string) {
          canceledSubscriptions.push(id)
          return { id, status: "canceled" } as any
        },
      },
    } as any,
    premiumTierId: "tier-premium",
  }

  return {
    beforeProfileUpdate,
    billing,
    calls,
    canceledSubscriptions,
    charges,
    invoicePayments,
    invoices,
    listedInvoicePayments,
    retrievedCharges,
    retrievedInvoices,
    users,
    profiles,
    deps,
  }
}

test("checkout.session.completed creates a new Supabase user and activates the sub", async () => {
  const { deps, calls, profiles } = stubDeps()
  const session = {
    id: "cs_1",
    status: "complete",
    payment_status: "paid",
    customer: "cus_1",
    customer_details: { email: "new@example.com" },
    subscription: "sub_1",
  } as any

  await handleCheckoutSessionCompleted(session, deps)

  expect(calls.some(([op]) => op === "createUser")).toBe(true)
  const p = Object.values(profiles)[0] as any
  expect(p.email).toBe("new@example.com")
  expect(p.subscription_status).toBe("active")
  expect(p.subscription_interval).toBe("month")
  expect(p.stripe_customer_id).toBe("cus_1")
  expect(p.stripe_subscription_id).toBe("sub_1")
  expect(p.subscription_tier_id).toBe("tier-premium")
  expect(p.current_period_end).toBeTruthy()
})

test("checkout.session.completed on existing email reuses the user", async () => {
  const { deps, calls, profiles, users } = stubDeps()
  users["ret@example.com"] = { id: "user-existing", email: "ret@example.com" }
  profiles["user-existing"] = {
    id: "user-existing",
    email: "ret@example.com",
    subscription_status: null,
  }

  const session = {
    id: "cs_2",
    status: "complete",
    payment_status: "paid",
    customer: "cus_2",
    customer_details: { email: "ret@example.com" },
    subscription: "sub_2",
  } as any
  await handleCheckoutSessionCompleted(session, deps)

  expect(calls.some(([op]) => op === "createUser")).toBe(false)
  expect((profiles["user-existing"] as any).subscription_status).toBe("active")
})

test("subscription.updated keeps status=active when cancel_at_period_end flips", async () => {
  const { deps, profiles } = stubDeps()
  profiles["u"] = {
    id: "u",
    email: "x@y",
    stripe_customer_id: "cus_X",
    stripe_subscription_id: "sub_X",
    subscription_status: "active",
    subscription_interval: "year",
  }
  const sub = {
    id: "sub_X",
    customer: "cus_X",
    status: "active",
    cancel_at_period_end: true,
    items: {
      data: [
        {
          price: { interval: "year", interval_count: 1 },
          current_period_end: 1_900_000_000,
        },
      ],
    },
  } as any
  const result = await handleSubscriptionUpdated(sub, deps)
  expect((profiles["u"] as any).subscription_status).toBe("active")
  expect((profiles["u"] as any).current_period_end).toBeTruthy()
  expect(result.matchedCurrentSubscription).toBe(true)
})

test("subscription.updated does not overwrite a newer active subscription", async () => {
  const { billing, deps, profiles } = stubDeps()
  profiles["u"] = {
    id: "u",
    email: "x@y",
    stripe_customer_id: "cus_X",
    stripe_subscription_id: "sub_new_success",
    subscription_status: "active",
    subscription_interval: "month",
    current_period_end: "2027-02-01T00:00:00.000Z",
  }
  const sub = {
    id: "sub_old_failed",
    customer: "cus_X",
    status: "canceled",
    cancel_at_period_end: false,
    items: {
      data: [
        {
          price: { interval: "month", interval_count: 3 },
          current_period_end: 1_900_000_000,
        },
      ],
    },
  } as any

  const result = await handleSubscriptionUpdated(sub, deps)

  expect((profiles["u"] as any).subscription_status).toBe("active")
  expect((profiles["u"] as any).subscription_interval).toBe("month")
  expect((profiles["u"] as any).current_period_end).toBe("2027-02-01T00:00:00.000Z")
  expect((profiles["u"] as any).stripe_subscription_id).toBe("sub_new_success")
  expect(billing).toHaveLength(1)
  expect(billing[0]).toMatchObject({
    user_id: "u",
    provider_subscription_id: "sub_old_failed",
    provider_status: "canceled",
    entitlement_status: "canceled",
  })
  expect(result.matchedCurrentSubscription).toBe(false)
})

test("subscription.updated does not create an open entitlement for an active non-current subscription", async () => {
  const { billing, deps, profiles } = stubDeps()
  profiles["u"] = {
    id: "u",
    email: "x@y",
    stripe_customer_id: "cus_X",
    stripe_subscription_id: "sub_new_success",
    subscription_status: "active",
    subscription_interval: "month",
    current_period_end: "2027-02-01T00:00:00.000Z",
  }
  const sub = {
    id: "sub_old_sepa",
    customer: "cus_X",
    status: "active",
    cancel_at_period_end: false,
    items: {
      data: [
        {
          price: { interval: "month", interval_count: 1 },
          current_period_end: 1_900_000_000,
        },
      ],
    },
  } as any

  const result = await handleSubscriptionUpdated(sub, deps)

  expect((profiles["u"] as any).stripe_subscription_id).toBe("sub_new_success")
  expect(billing).toHaveLength(1)
  expect(billing[0]).toMatchObject({
    user_id: "u",
    provider_subscription_id: "sub_old_sepa",
    provider_status: "active",
    entitlement_status: "canceled",
  })
  expect(result.matchedCurrentSubscription).toBe(false)
})

test("subscription.deleted flips profile to canceled + Free tier", async () => {
  const { deps, profiles } = stubDeps()
  profiles["u"] = {
    id: "u",
    stripe_customer_id: "cus_D",
    stripe_subscription_id: "sub_D",
    subscription_status: "active",
    subscription_tier_id: "tier-premium",
    subscription_interval: "month",
    current_period_end: "2027-01-01T00:00:00.000Z",
  }
  const sub = { id: "sub_D", customer: "cus_D", status: "canceled" } as any
  const result = await handleSubscriptionDeleted(sub, { ...deps, freeTierId: "tier-free" } as any)
  expect((profiles["u"] as any).subscription_status).toBe("canceled")
  expect((profiles["u"] as any).subscription_tier_id).toBe("tier-free")
  expect((profiles["u"] as any).stripe_subscription_id).toBeNull()
  expect((profiles["u"] as any).subscription_interval).toBeNull()
  expect((profiles["u"] as any).current_period_end).toBeNull()
  expect(result.matchedCurrentSubscription).toBe(true)
})

test("subscription.deleted does not downgrade a newer active subscription", async () => {
  const { billing, deps, profiles } = stubDeps()
  profiles["u"] = {
    id: "u",
    stripe_customer_id: "cus_D",
    stripe_subscription_id: "sub_new_success",
    subscription_status: "active",
    subscription_tier_id: "tier-premium",
    subscription_interval: "month",
    current_period_end: "2027-02-01T00:00:00.000Z",
  }
  const sub = { id: "sub_old_failed", customer: "cus_D", status: "canceled" } as any

  const result = await handleSubscriptionDeleted(sub, { ...deps, freeTierId: "tier-free" } as any)

  expect((profiles["u"] as any).subscription_status).toBe("active")
  expect((profiles["u"] as any).subscription_tier_id).toBe("tier-premium")
  expect((profiles["u"] as any).stripe_subscription_id).toBe("sub_new_success")
  expect((profiles["u"] as any).subscription_interval).toBe("month")
  expect((profiles["u"] as any).current_period_end).toBe("2027-02-01T00:00:00.000Z")
  expect(billing).toHaveLength(1)
  expect(billing[0]).toMatchObject({
    user_id: "u",
    provider_subscription_id: "sub_old_failed",
    provider_status: "canceled",
    entitlement_status: "canceled",
  })
  expect(result.matchedCurrentSubscription).toBe(false)
})

test("subscription.deleted reports no match when a concurrent checkout wins the guarded update", async () => {
  const { beforeProfileUpdate, billing, deps, profiles } = stubDeps()
  profiles["u"] = {
    id: "u",
    stripe_customer_id: "cus_D",
    stripe_subscription_id: "sub_D",
    subscription_status: "active",
    subscription_tier_id: "tier-premium",
    subscription_interval: "month",
    current_period_end: "2027-01-01T00:00:00.000Z",
  }
  beforeProfileUpdate.push(() => {
    profiles["u"].stripe_subscription_id = "sub_new_success"
    profiles["u"].subscription_status = "active"
    profiles["u"].subscription_tier_id = "tier-premium"
  })

  const result = await handleSubscriptionDeleted(
    { id: "sub_D", customer: "cus_D", status: "canceled" } as any,
    { ...deps, freeTierId: "tier-free" } as any,
  )

  expect(result.matchedCurrentSubscription).toBe(false)
  expect((profiles["u"] as any).subscription_status).toBe("active")
  expect((profiles["u"] as any).subscription_tier_id).toBe("tier-premium")
  expect((profiles["u"] as any).stripe_subscription_id).toBe("sub_new_success")
  expect(billing).toHaveLength(1)
  expect(billing[0]).toMatchObject({
    user_id: "u",
    provider_subscription_id: "sub_D",
    provider_status: "canceled",
    entitlement_status: "canceled",
  })
})

test("invoice.payment_failed logs and returns (no throw)", async () => {
  const invoice = { id: "in_1", customer: "cus_1", attempt_count: 2 } as any
  await handleInvoicePaymentFailed(invoice)
  // no assertion beyond no-throw; log-only for MVP
})

test("checkout.session.async_payment_failed revokes premium access and cancels subscription", async () => {
  const { billing, canceledSubscriptions, deps, profiles } = stubDeps()
  profiles.u = {
    id: "u",
    email: "failed@example.com",
    stripe_customer_id: "cus_async_failed",
    stripe_subscription_id: "sub_async_failed",
    subscription_status: "active",
    subscription_tier_id: "tier-premium",
    subscription_interval: "quarter",
    current_period_end: "2027-01-01T00:00:00.000Z",
  }
  billing.push({
    user_id: "u",
    provider: "stripe",
    provider_customer_id: "cus_async_failed",
    provider_subscription_id: "sub_async_failed",
    provider_status: "active",
    entitlement_status: "active",
    metadata: { checkout_session_id: "cs_async_failed", payment_status: "unpaid" },
  })
  await handleCheckoutSessionAsyncPaymentFailed(
    {
      id: "cs_async_failed",
      customer: "cus_async_failed",
      subscription: "sub_async_failed",
    } as any,
    { ...deps, freeTierId: "tier-free" },
  )

  expect(profiles.u.subscription_status).toBe("canceled")
  expect(profiles.u.subscription_tier_id).toBe("tier-free")
  expect(profiles.u.stripe_subscription_id).toBeNull()
  expect(profiles.u.subscription_interval).toBeNull()
  expect(profiles.u.current_period_end).toBeNull()
  expect(billing).toHaveLength(1)
  expect(billing[0]).toMatchObject({
    user_id: "u",
    provider: "stripe",
    provider_customer_id: "cus_async_failed",
    provider_subscription_id: "sub_async_failed",
    provider_status: "payment_failed",
    entitlement_status: "canceled",
    metadata: {
      checkout_session_id: "cs_async_failed",
      payment_status: "unpaid",
      reason: "async_payment_failed",
    },
  })
  expect(billing[0].cancelled_at).toBeTruthy()
  expect(canceledSubscriptions).toEqual(["sub_async_failed"])
})

test("checkout.session.async_payment_succeeded skips SEPA when the session payment method types reveal it", async () => {
  const { billing, canceledSubscriptions, deps, profiles } = stubDeps()
  const result = await handleCheckoutSessionAsyncPaymentSucceeded(
    {
      id: "cs_async_sepa",
      status: "complete",
      payment_status: "paid",
      customer: "cus_sepa",
      customer_details: { email: "sepa@example.com" },
      subscription: "sub_sepa",
      payment_method_types: ["sepa_debit"],
    } as any,
    deps,
  )

  expect(result).toBeNull()
  expect(Object.values(profiles)).toHaveLength(0)
  expect(billing).toHaveLength(0)
  expect(canceledSubscriptions).toEqual(["sub_sepa"])
})

test("checkout.session.async_payment_failed does not revoke a newer active subscription", async () => {
  const { billing, canceledSubscriptions, deps, profiles } = stubDeps()
  profiles.u = {
    id: "u",
    email: "retry@example.com",
    stripe_customer_id: "cus_retry",
    stripe_subscription_id: "sub_new_success",
    subscription_status: "active",
    subscription_tier_id: "tier-premium",
    subscription_interval: "month",
    current_period_end: "2027-01-01T00:00:00.000Z",
  }
  await handleCheckoutSessionAsyncPaymentFailed(
    {
      id: "cs_old_failed",
      customer: "cus_retry",
      subscription: "sub_old_failed",
    } as any,
    { ...deps, freeTierId: "tier-free" },
  )

  expect(profiles.u.subscription_status).toBe("active")
  expect(profiles.u.subscription_tier_id).toBe("tier-premium")
  expect(profiles.u.stripe_subscription_id).toBe("sub_new_success")
  expect(profiles.u.subscription_interval).toBe("month")
  expect(profiles.u.current_period_end).toBe("2027-01-01T00:00:00.000Z")
  expect(billing).toHaveLength(1)
  expect(billing[0]).toMatchObject({
    user_id: "u",
    provider_subscription_id: "sub_old_failed",
    provider_status: "payment_failed",
    entitlement_status: "canceled",
    metadata: { reason: "async_payment_failed" },
  })
  expect(canceledSubscriptions).toEqual(["sub_old_failed"])
})

test("checkout.session.async_payment_failed update is guarded against concurrent new subscription", async () => {
  const { beforeProfileUpdate, billing, deps, profiles } = stubDeps()
  profiles.u = {
    id: "u",
    email: "race@example.com",
    stripe_customer_id: "cus_race",
    stripe_subscription_id: "sub_old_failed",
    subscription_status: "active",
    subscription_tier_id: "tier-premium",
    subscription_interval: "quarter",
    current_period_end: "2027-01-01T00:00:00.000Z",
  }
  beforeProfileUpdate.push(() => {
    profiles.u.stripe_subscription_id = "sub_new_success"
    profiles.u.subscription_interval = "month"
    profiles.u.current_period_end = "2027-02-01T00:00:00.000Z"
  })

  await handleCheckoutSessionAsyncPaymentFailed(
    {
      id: "cs_race",
      customer: "cus_race",
      subscription: "sub_old_failed",
    } as any,
    { ...deps, freeTierId: "tier-free" },
  )

  expect(profiles.u.subscription_status).toBe("active")
  expect(profiles.u.subscription_tier_id).toBe("tier-premium")
  expect(profiles.u.stripe_subscription_id).toBe("sub_new_success")
  expect(profiles.u.subscription_interval).toBe("month")
  expect(profiles.u.current_period_end).toBe("2027-02-01T00:00:00.000Z")
  expect(billing).toHaveLength(1)
  expect(billing[0]).toMatchObject({
    user_id: "u",
    provider_subscription_id: "sub_old_failed",
    provider_status: "payment_failed",
    entitlement_status: "canceled",
  })
})

test("checkout.session.async_payment_failed still succeeds when subscription cancel fails", async () => {
  const { billing, canceledSubscriptions, deps, profiles } = stubDeps()
  profiles.u = {
    id: "u",
    email: "cancel-fails@example.com",
    stripe_customer_id: "cus_cancel_fails",
    stripe_subscription_id: "sub_cancel_fails",
    subscription_status: "active",
    subscription_tier_id: "tier-premium",
  }
  deps.stripe.subscriptions.cancel = async (id: string) => {
    canceledSubscriptions.push(id)
    throw new Error("stripe unavailable")
  }

  await handleCheckoutSessionAsyncPaymentFailed(
    {
      id: "cs_cancel_fails",
      customer: "cus_cancel_fails",
      subscription: "sub_cancel_fails",
    } as any,
    { ...deps, freeTierId: "tier-free" },
  )

  expect(profiles.u.subscription_status).toBe("canceled")
  expect(profiles.u.subscription_tier_id).toBe("tier-free")
  expect(billing).toHaveLength(1)
  expect(canceledSubscriptions).toEqual(["sub_cancel_fails"])
})

test("charge.dispute.created retrieves charge, revokes active profile, and cancels subscription", async () => {
  const {
    billing,
    canceledSubscriptions,
    charges,
    deps,
    invoicePayments,
    listedInvoicePayments,
    profiles,
    retrievedCharges,
    retrievedInvoices,
  } = stubDeps()
  profiles.u = {
    id: "u",
    email: "disputed@example.com",
    stripe_customer_id: "cus_disputed",
    stripe_subscription_id: "sub_disputed_current",
    subscription_status: "active",
    subscription_tier_id: "tier-premium",
    subscription_interval: "year",
    current_period_end: "2027-01-01T00:00:00.000Z",
  }
  billing.push({
    user_id: "u",
    provider: "stripe",
    provider_customer_id: "cus_disputed",
    provider_subscription_id: "sub_disputed_current",
    provider_status: "active",
    entitlement_status: "active",
    metadata: { source: "checkout" },
  })
  charges.ch_disputed = {
    id: "ch_disputed",
    customer: { id: "cus_disputed" },
    payment_intent: { id: "pi_disputed" },
  }
  invoicePayments.push({
    id: "inpay_disputed",
    payment: { type: "payment_intent", payment_intent: "pi_disputed" },
    invoice: {
      id: "in_disputed",
      parent: {
        subscription_details: {
          subscription: { id: "sub_disputed_current" },
        },
      },
    },
  })

  await handleChargeDisputeCreated(
    {
      id: "dp_disputed",
      charge: { id: "ch_disputed" },
    } as any,
    { ...deps, freeTierId: "tier-free" },
  )

  expect(retrievedCharges).toEqual([{ id: "ch_disputed", expand: undefined }])
  expect(listedInvoicePayments).toEqual([
    {
      payment: { type: "payment_intent", payment_intent: "pi_disputed" },
      limit: 1,
      expand: ["data.invoice.parent.subscription_details.subscription"],
    },
  ])
  expect(retrievedInvoices).toHaveLength(0)
  expect(profiles.u.subscription_status).toBe("canceled")
  expect(profiles.u.subscription_tier_id).toBe("tier-free")
  expect(profiles.u.stripe_subscription_id).toBeNull()
  expect(profiles.u.subscription_interval).toBeNull()
  expect(profiles.u.current_period_end).toBeNull()
  expect(billing).toHaveLength(1)
  expect(billing[0]).toMatchObject({
    user_id: "u",
    provider: "stripe",
    provider_customer_id: "cus_disputed",
    provider_subscription_id: "sub_disputed_current",
    provider_status: "disputed",
    entitlement_status: "canceled",
    metadata: {
      source: "checkout",
      reason: "charge_dispute_created",
    },
  })
  expect(billing[0].cancelled_at).toBeTruthy()
  expect(canceledSubscriptions).toEqual(["sub_disputed_current"])
})

test("charge.dispute.created does not revoke a newer active subscription for an old disputed charge", async () => {
  const {
    billing,
    canceledSubscriptions,
    charges,
    deps,
    invoicePayments,
    invoices,
    listedInvoicePayments,
    profiles,
    retrievedCharges,
    retrievedInvoices,
  } = stubDeps()
  profiles.u = {
    id: "u",
    email: "retry-dispute@example.com",
    stripe_customer_id: "cus_retry_dispute",
    stripe_subscription_id: "sub_new_success",
    subscription_status: "active",
    subscription_tier_id: "tier-premium",
    subscription_interval: "month",
    current_period_end: "2027-02-01T00:00:00.000Z",
  }
  charges.ch_old_disputed = {
    id: "ch_old_disputed",
    customer: "cus_retry_dispute",
    payment_intent: "pi_old_disputed",
  }
  invoicePayments.push({
    id: "inpay_old_disputed",
    payment: { type: "payment_intent", payment_intent: "pi_old_disputed" },
    invoice: "in_old_disputed",
  })
  invoices.in_old_disputed = {
    id: "in_old_disputed",
    parent: {
      subscription_details: {
        subscription: "sub_old_disputed",
      },
    },
  }

  await handleChargeDisputeCreated(
    {
      id: "dp_old_disputed",
      charge: "ch_old_disputed",
    } as any,
    { ...deps, freeTierId: "tier-free" },
  )

  expect(retrievedCharges).toEqual([{ id: "ch_old_disputed", expand: undefined }])
  expect(listedInvoicePayments).toEqual([
    {
      payment: { type: "payment_intent", payment_intent: "pi_old_disputed" },
      limit: 1,
      expand: ["data.invoice.parent.subscription_details.subscription"],
    },
  ])
  expect(retrievedInvoices).toEqual([
    { id: "in_old_disputed", expand: ["parent.subscription_details.subscription"] },
  ])
  expect(profiles.u.subscription_status).toBe("active")
  expect(profiles.u.subscription_tier_id).toBe("tier-premium")
  expect(profiles.u.stripe_subscription_id).toBe("sub_new_success")
  expect(profiles.u.subscription_interval).toBe("month")
  expect(profiles.u.current_period_end).toBe("2027-02-01T00:00:00.000Z")
  expect(billing).toHaveLength(1)
  expect(billing[0]).toMatchObject({
    user_id: "u",
    provider_subscription_id: "sub_old_disputed",
    provider_status: "disputed",
    entitlement_status: "canceled",
    metadata: { reason: "charge_dispute_created" },
  })
  expect(canceledSubscriptions).toEqual(["sub_old_disputed"])
})

test("charge.dispute.created without profile skips, but no-current-subscription still cancels disputed sub", async () => {
  const {
    billing,
    canceledSubscriptions,
    charges,
    deps,
    invoicePayments,
    invoices,
    listedInvoicePayments,
    profiles,
    retrievedCharges,
    retrievedInvoices,
  } = stubDeps()
  profiles.withoutSubscription = {
    id: "withoutSubscription",
    email: "former@example.com",
    stripe_customer_id: "cus_former",
    stripe_subscription_id: null,
    subscription_status: "canceled",
    subscription_tier_id: "tier-free",
  }
  charges.ch_no_profile = {
    id: "ch_no_profile",
    customer: "cus_missing",
    payment_intent: "pi_no_profile",
  }
  charges.ch_no_subscription = {
    id: "ch_no_subscription",
    customer: "cus_former",
    payment_intent: "pi_no_subscription",
  }
  invoicePayments.push(
    {
      id: "inpay_no_profile",
      payment: { type: "payment_intent", payment_intent: "pi_no_profile" },
      invoice: "in_no_profile",
    },
    {
      id: "inpay_no_subscription",
      payment: { type: "payment_intent", payment_intent: "pi_no_subscription" },
      invoice: "in_no_subscription",
    },
  )
  invoices.in_no_profile = {
    id: "in_no_profile",
    parent: { subscription_details: { subscription: "sub_no_profile" } },
  }
  invoices.in_no_subscription = {
    id: "in_no_subscription",
    parent: { subscription_details: { subscription: "sub_former" } },
  }

  await expect(
    handleChargeDisputeCreated(
      {
        id: "dp_no_profile",
        charge: "ch_no_profile",
      } as any,
      { ...deps, freeTierId: "tier-free" },
    ),
  ).resolves.toBeUndefined()
  await expect(
    handleChargeDisputeCreated(
      {
        id: "dp_no_subscription",
        charge: "ch_no_subscription",
      } as any,
      { ...deps, freeTierId: "tier-free" },
    ),
  ).resolves.toBeUndefined()

  expect(retrievedCharges).toEqual([
    { id: "ch_no_profile", expand: undefined },
    { id: "ch_no_subscription", expand: undefined },
  ])
  expect(listedInvoicePayments).toEqual([
    {
      payment: { type: "payment_intent", payment_intent: "pi_no_profile" },
      limit: 1,
      expand: ["data.invoice.parent.subscription_details.subscription"],
    },
    {
      payment: { type: "payment_intent", payment_intent: "pi_no_subscription" },
      limit: 1,
      expand: ["data.invoice.parent.subscription_details.subscription"],
    },
  ])
  expect(retrievedInvoices).toEqual([
    { id: "in_no_profile", expand: ["parent.subscription_details.subscription"] },
    { id: "in_no_subscription", expand: ["parent.subscription_details.subscription"] },
  ])
  expect(profiles.withoutSubscription.stripe_subscription_id).toBeNull()
  expect(profiles.withoutSubscription.subscription_status).toBe("canceled")
  expect(profiles.withoutSubscription.subscription_tier_id).toBe("tier-free")
  expect(billing).toHaveLength(1)
  expect(billing[0]).toMatchObject({
    user_id: "withoutSubscription",
    provider_subscription_id: "sub_former",
    provider_status: "disputed",
    entitlement_status: "canceled",
    metadata: { reason: "charge_dispute_created" },
  })
  expect(canceledSubscriptions).toEqual(["sub_former"])
})

test("checkout.session.completed with metadata.lead_id calls linkQuizToProfile with that id", async () => {
  const { deps } = stubDeps()
  const calls: Array<[string, string | undefined, string | undefined]> = []
  deps.linkQuizToProfile = async (userId, email, leadId) => {
    calls.push([userId, email, leadId])
  }

  const session = {
    id: "cs_lead",
    status: "complete",
    payment_status: "paid",
    customer: "cus_lead",
    customer_details: { email: "lead@example.com" },
    subscription: "sub_lead",
    metadata: { lead_id: "lead-xyz" },
  } as any

  await handleCheckoutSessionCompleted(session, deps)

  expect(calls).toHaveLength(1)
  const [calledUserId, calledEmail, calledLeadId] = calls[0]
  expect(calledEmail).toBe("lead@example.com")
  expect(calledLeadId).toBe("lead-xyz")
  expect(typeof calledUserId).toBe("string")
  expect(calledUserId.length).toBeGreaterThan(0)
})

test("checkout.session.completed without metadata calls linkQuizToProfile with undefined leadId", async () => {
  const { deps } = stubDeps()
  const calls: Array<[string, string | undefined, string | undefined]> = []
  deps.linkQuizToProfile = async (userId, email, leadId) => {
    calls.push([userId, email, leadId])
  }

  const session = {
    id: "cs_nolead",
    status: "complete",
    payment_status: "paid",
    customer: "cus_nolead",
    customer_details: { email: "nolead@example.com" },
    subscription: "sub_nolead",
    // no metadata
  } as any

  await handleCheckoutSessionCompleted(session, deps)

  expect(calls).toHaveLength(1)
  const [, calledEmail, calledLeadId] = calls[0]
  expect(calledEmail).toBe("nolead@example.com")
  expect(calledLeadId).toBeUndefined()
})

test("checkout.session.completed can defer quiz profile linking", async () => {
  const { deps, profiles } = stubDeps()
  const calls: Array<[string, string | undefined, string | undefined]> = []
  const deferred: { work?: () => void | Promise<void> } = {}

  deps.linkQuizToProfile = async (userId, email, leadId) => {
    calls.push([userId, email, leadId])
  }
  deps.profileLinkMode = "defer"
  deps.defer = (work) => {
    deferred.work = work
  }

  const session = {
    id: "cs_defer",
    status: "complete",
    payment_status: "paid",
    customer: "cus_defer",
    customer_details: { email: "defer@example.com" },
    subscription: "sub_defer",
    metadata: { lead_id: "lead-defer" },
  } as any

  await handleCheckoutSessionCompleted(session, deps)

  const p = Object.values(profiles).find((x: any) => x.email === "defer@example.com") as any
  expect(p?.subscription_status).toBe("active")
  expect(calls).toHaveLength(0)

  expect(deferred.work).toBeDefined()
  await deferred.work?.()
  expect(calls).toEqual([[p.id, "defer@example.com", "lead-defer"]])
})

test("checkout.session.completed does not throw when linkQuizToProfile rejects", async () => {
  const { deps, profiles } = stubDeps()
  deps.linkQuizToProfile = async () => {
    throw new Error("lead lookup failed")
  }

  const session = {
    id: "cs_err",
    status: "complete",
    payment_status: "paid",
    customer: "cus_err",
    customer_details: { email: "err@example.com" },
    subscription: "sub_err",
    metadata: { lead_id: "lead-err" },
  } as any

  // Should resolve normally despite linkQuizToProfile throwing
  await expect(handleCheckoutSessionCompleted(session, deps)).resolves.toMatchObject({
    email: "err@example.com",
    stripeCustomerId: "cus_err",
    stripeSubscriptionId: "sub_1",
    subscriptionInterval: "month",
    subscriptionStatus: "active",
  })

  // Profile update still happened
  const p = Object.values(profiles).find((x: any) => x.email === "err@example.com") as any
  expect(p?.subscription_status).toBe("active")
})

test("checkout.session.completed falls back to root current_period_end when item has none", async () => {
  const { deps, profiles } = stubDeps()
  // override stripe.subscriptions.retrieve for this test
  deps.stripe.subscriptions = {
    async retrieve() {
      return {
        id: "sub_root",
        current_period_end: 1_800_000_000,
        items: { data: [{ price: { interval: "month", interval_count: 1 } }] },
      } as any
    },
  } as any
  const session = {
    id: "cs_root",
    status: "complete",
    payment_status: "paid",
    customer: "cus_root",
    customer_details: { email: "root@example.com" },
    subscription: "sub_root",
  } as any
  await handleCheckoutSessionCompleted(session, deps)
  const p = Object.values(profiles).find((x: any) => x.email === "root@example.com") as any
  expect(p.current_period_end).toBeTruthy()
  expect(p.subscription_status).toBe("active")
})
