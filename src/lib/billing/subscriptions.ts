import type {
  BillingEntitlementStatus,
  BillingProvider,
  BillingSubscriptionInput,
  BillingSubscriptionRow,
  SupabaseBillingClient,
} from "./types"

type LegacyProfileSubscription = {
  id: string
  subscription_status: string | null
  current_period_end: string | null
}

export interface ManualAccessGrantRow {
  id: string
  user_id: string | null
  email: string | null
  expires_at: string | null
  revoked_at: string | null
}

const OPEN_ENTITLEMENTS = new Set<BillingEntitlementStatus>(["active", "past_due"])
const ACCESS_ALREADY_EXISTS_ERROR = "User already has access through an existing subscription"

export async function upsertBillingSubscription(
  supabase: SupabaseBillingClient,
  input: BillingSubscriptionInput,
): Promise<BillingSubscriptionRow> {
  const now = new Date().toISOString()
  const existing = await findBillingSubscriptionByProviderId(
    supabase,
    input.provider,
    input.provider_subscription_id,
  )
  const { provider_subscriber_email, metadata: inputMetadata, ...subscriptionInput } = input
  const row = {
    provider_customer_id: existing?.provider_customer_id ?? null,
    provider_subscriber_email:
      provider_subscriber_email !== undefined
        ? provider_subscriber_email
        : (existing?.provider_subscriber_email ?? null),
    interval: existing?.interval ?? null,
    current_period_end: existing?.current_period_end ?? null,
    cancel_at_period_end: existing?.cancel_at_period_end ?? false,
    cancelled_at: existing?.cancelled_at ?? null,
    metadata: {
      ...(existing?.metadata ?? {}),
      ...(inputMetadata ?? {}),
    },
    ...subscriptionInput,
    updated_at: now,
  }

  const { data, error } = await supabase
    .from("billing_subscriptions")
    .upsert(row, { onConflict: "provider,provider_subscription_id" })
    .select("*")
    .single()

  if (error) throw error
  return data as BillingSubscriptionRow
}

export async function findBillingSubscriptionByProviderId(
  supabase: SupabaseBillingClient,
  provider: BillingProvider,
  providerSubscriptionId: string,
): Promise<BillingSubscriptionRow | null> {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select("*")
    .eq("provider", provider)
    .eq("provider_subscription_id", providerSubscriptionId)
    .maybeSingle()

  if (error) throw error
  return (data as BillingSubscriptionRow | null) ?? null
}

export async function findCurrentBillingSubscriptionForUser(
  supabase: SupabaseBillingClient,
  userId: string,
  now: Date = new Date(),
): Promise<BillingSubscriptionRow | null> {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select("*")
    .eq("user_id", userId)

  if (error) throw error

  const rows = ((data as BillingSubscriptionRow[] | null) ?? []).filter((row) =>
    hasCurrentBillingAccess(row, now),
  )
  rows.sort((left, right) => {
    const statusDelta =
      entitlementPriority(left.entitlement_status) - entitlementPriority(right.entitlement_status)
    if (statusDelta !== 0) return statusDelta
    return compareNullableIsoDesc(left.current_period_end, right.current_period_end)
  })

  return rows[0] ?? null
}

export async function findVisibleBillingSubscriptionForUser(
  supabase: SupabaseBillingClient,
  userId: string,
  now: Date = new Date(),
): Promise<BillingSubscriptionRow | null> {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select(
      "id, user_id, provider, provider_customer_id, provider_subscriber_email, provider_subscription_id, provider_status, entitlement_status, interval, current_period_end, cancel_at_period_end, cancelled_at, metadata, created_at, updated_at",
    )
    .eq("user_id", userId)
    .in("entitlement_status", ["active", "past_due", "canceled"])
    .order("current_period_end", { ascending: false })

  if (error) throw error
  const rows = ((data as BillingSubscriptionRow[] | null) ?? []).filter((row) =>
    hasCurrentBillingAccess(row, now),
  )
  return rows[0] ?? null
}

export async function assertCanStartCheckout(
  supabase: SupabaseBillingClient,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const current = await findCurrentBillingSubscriptionForUser(supabase, userId, now)
  if (current) {
    throw new Error(ACCESS_ALREADY_EXISTS_ERROR)
  }

  const manualGrant = await findCurrentManualAccessGrant(supabase, { userId }, now)
  if (manualGrant) {
    throw new Error(ACCESS_ALREADY_EXISTS_ERROR)
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id, subscription_status, current_period_end")
    .eq("id", userId)
    .maybeSingle()

  if (error) throw error
  const profile = data as LegacyProfileSubscription | null

  if (profile && hasCurrentLegacyProfileAccess(profile, now)) {
    throw new Error(ACCESS_ALREADY_EXISTS_ERROR)
  }
}

export async function assertCanStartCheckoutForEmail(
  supabase: SupabaseBillingClient,
  email: string,
  now: Date = new Date(),
): Promise<void> {
  const manualGrant = await findCurrentManualAccessGrant(supabase, { email }, now)
  if (manualGrant) {
    throw new Error(ACCESS_ALREADY_EXISTS_ERROR)
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id, subscription_status, current_period_end")
    .ilike("email", email)
    .maybeSingle()

  if (error) throw error
  const profile = data as LegacyProfileSubscription | null
  if (!profile?.id) return

  await assertCanStartCheckout(supabase, profile.id, now)
}

export async function hasCurrentAppAccess(
  supabase: SupabaseBillingClient,
  lookup: { userId: string; email?: string | null },
  now: Date = new Date(),
): Promise<boolean> {
  const current = await findCurrentBillingSubscriptionForUser(supabase, lookup.userId, now)
  if (current) return true

  const manualGrant = await findCurrentManualAccessGrant(supabase, lookup, now)
  if (manualGrant) return true

  const { data, error } = await supabase
    .from("profiles")
    .select("subscription_status, current_period_end")
    .eq("id", lookup.userId)
    .maybeSingle()

  if (error) throw error
  const profile = data as LegacyProfileSubscription | null
  return profile ? hasCurrentLegacyProfileAccess(profile, now) : false
}

export async function findCurrentManualAccessGrant(
  supabase: SupabaseBillingClient,
  lookup: { userId?: string | null; email?: string | null },
  now: Date = new Date(),
): Promise<ManualAccessGrantRow | null> {
  const grants: ManualAccessGrantRow[] = []

  if (lookup.userId) {
    const { data, error } = await supabase
      .from("manual_access_grants")
      .select("id, user_id, email, expires_at, revoked_at")
      .eq("user_id", lookup.userId)

    if (error) {
      if (isMissingManualAccessGrantsTableError(error)) return null
      throw error
    }
    grants.push(...((data as ManualAccessGrantRow[] | null) ?? []))
  }

  const email = lookup.email?.trim().toLowerCase()
  if (email) {
    const { data, error } = await supabase
      .from("manual_access_grants")
      .select("id, user_id, email, expires_at, revoked_at")
      .eq("email", email)

    if (error) {
      if (isMissingManualAccessGrantsTableError(error)) return null
      throw error
    }
    grants.push(...((data as ManualAccessGrantRow[] | null) ?? []))
  }

  const current = grants.filter((grant) => hasCurrentManualAccess(grant, now))
  current.sort((left, right) => compareNullableIsoDesc(left.expires_at, right.expires_at))
  return current[0] ?? null
}

function isMissingManualAccessGrantsTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as { code?: unknown; message?: unknown }
  const code = typeof candidate.code === "string" ? candidate.code : ""
  const message = typeof candidate.message === "string" ? candidate.message : ""
  return (code === "PGRST205" || code === "42P01") && message.includes("manual_access_grants")
}

export function hasCurrentManualAccess(
  grant: Pick<ManualAccessGrantRow, "expires_at" | "revoked_at">,
  now: Date = new Date(),
): boolean {
  if (grant.revoked_at) return false
  return !grant.expires_at || isFutureIso(grant.expires_at, now)
}

export function hasCurrentBillingAccess(
  row: BillingSubscriptionRow,
  now: Date = new Date(),
): boolean {
  if (OPEN_ENTITLEMENTS.has(row.entitlement_status)) return true
  return (
    row.entitlement_status === "canceled" &&
    row.cancel_at_period_end &&
    isFutureIso(row.current_period_end, now)
  )
}

export function hasCurrentLegacyProfileAccess(
  profile: Pick<LegacyProfileSubscription, "subscription_status" | "current_period_end">,
  now: Date = new Date(),
): boolean {
  if (profile.subscription_status === "active" || profile.subscription_status === "past_due")
    return true
  return profile.subscription_status === "canceled" && isFutureIso(profile.current_period_end, now)
}

export function isFutureIso(value: string | null | undefined, now: Date = new Date()): boolean {
  if (!value) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp > now.getTime()
}

function entitlementPriority(status: BillingEntitlementStatus): number {
  if (status === "active") return 0
  if (status === "past_due") return 1
  if (status === "incomplete") return 2
  return 3
}

function compareNullableIsoDesc(left: string | null, right: string | null): number {
  if (left === right) return 0
  if (!left) return 1
  if (!right) return -1
  return right.localeCompare(left)
}
