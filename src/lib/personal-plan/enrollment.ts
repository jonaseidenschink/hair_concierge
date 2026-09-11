import "server-only"

import {
  findOneTimePurchaseEntitlementForUser,
  resolveOneTimePurchaseAccessState,
} from "@/lib/billing/purchases"
import { PERSONAL_PLAN_LAUNCH_PRICING_CATALOG } from "@/lib/billing/pricing-catalog"
import { findCurrentBillingSubscriptionsForUser } from "@/lib/billing/subscriptions"
import type { OneTimeAccessState, SupabaseBillingClient } from "@/lib/billing/types"
import {
  isMissingPersonalPlanFieldTestRelation,
  isMissingRegularQuizFieldTestRelation,
} from "@/lib/personal-plan-field-test/errors"
import {
  getPersonalPlanNewBuyerCohortCutoff,
  isPersonalPlanLegacyQuizCutoverEnabled,
} from "@/lib/personal-plan/release"
import { isPersonalPlanAppV1AllowedForUser } from "@/lib/personal-plan/rollout-access"
import {
  isPersonalPlanLegacyMigrationEnabled,
  resolvePersonalPlanMigrationAdmission,
} from "./migration-admission"
import { resolveFreemiumPlanEnrollment } from "./freemium-enrollment"

/**
 * `"freemium"` (freemium-scanner-first T14) is the Premium-sheet purchase source: a
 * STANDARD-catalog subscription admitted by an explicit `freemium_plan_admissions` record.
 * It is a peer of the other kinds, not a variant of `"launch_subscription"` — that branch
 * is untouched.
 */
export type PersonalPlanEnrollmentSourceKind =
  | "one_time"
  | "launch_subscription"
  | "field_test"
  | "partner"
  | "migration"
  | "freemium"

export type PersonalPlanEnrollment = {
  accessState: OneTimeAccessState
  sourceId: string | null
  paidAt: string | null
  qualifiedAt: string | null
  artifactLeadId: string | null
  quizSourceKind: "personal_plan" | "legacy" | null
  sourceKind: PersonalPlanEnrollmentSourceKind | null
}

type CorrelationRow = {
  lead_id?: unknown
  purchase_completed_at?: unknown
}

type LeadRow = {
  quiz_kind?: unknown
  user_id?: unknown
}

type EnrollmentReleaseDependencies = {
  legacyQuizCutoverEnabled: () => boolean
  migrationEnabled?: () => boolean
  cohortCutoff: () => Date | null
  appAllowedForUser: (userId: string, client: unknown) => Promise<boolean>
}

const defaultReleaseDependencies: EnrollmentReleaseDependencies = {
  legacyQuizCutoverEnabled: isPersonalPlanLegacyQuizCutoverEnabled,
  migrationEnabled: () => isPersonalPlanLegacyMigrationEnabled(),
  cohortCutoff: getPersonalPlanNewBuyerCohortCutoff,
  appAllowedForUser: (userId, client) => isPersonalPlanAppV1AllowedForUser(userId, client as never),
}

type FieldTestEnrollmentRow = {
  id?: unknown
  user_id?: unknown
  lead_id?: unknown
  manual_access_grant_id?: unknown
  status?: unknown
  activated_at?: unknown
  expires_at?: unknown
  revoked_at?: unknown
  quiz_source_kind?: unknown
  manual_access_grants?: unknown
}

type ManualAccessGrantRow = {
  id?: unknown
  user_id?: unknown
  reason?: unknown
  expires_at?: unknown
  revoked_at?: unknown
}

type PartnerInvitationEnrollmentRow = {
  id?: unknown
  claimed_user_id?: unknown
  lead_id?: unknown
  activated_at?: unknown
  revoked_at?: unknown
  current_manual_access_grant_id?: unknown
  current_grant?: unknown
}

type EnrollmentQueryBuilder = {
  select: (columns: string) => EnrollmentQueryBuilder
  eq: (column: string, value: unknown) => EnrollmentQueryBuilder
  is: (column: string, value: unknown) => EnrollmentQueryBuilder
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>
}

type EnrollmentSupabaseClient = {
  from: (table: string) => EnrollmentQueryBuilder
}

function emptyEnrollment(accessState: OneTimeAccessState = "none"): PersonalPlanEnrollment {
  return {
    accessState,
    sourceId: null,
    paidAt: null,
    qualifiedAt: null,
    artifactLeadId: null,
    quizSourceKind: null,
    sourceKind: null,
  }
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function futureTimestamp(value: unknown, now: Date): string | null {
  if (typeof value !== "string") return null
  const timestamp = new Date(value)
  return !Number.isNaN(timestamp.getTime()) && timestamp.getTime() > now.getTime() ? value : null
}

function resolvePersonalPlanFieldTestQuizSourceKind(
  row: FieldTestEnrollmentRow | null,
): "personal_plan" | "legacy" | null {
  if (row?.quiz_source_kind === "personal_plan" || row?.quiz_source_kind === "legacy") {
    return row.quiz_source_kind
  }
  return null
}

function resolveActiveFieldTestEnrollment(
  row: FieldTestEnrollmentRow | null,
  userId: string,
  now: Date,
  quizSourceKind: "personal_plan" | "legacy",
): PersonalPlanEnrollment | null {
  if (!row || row.status !== "active" || row.revoked_at !== null) return null
  const sourceId = typeof row.id === "string" ? row.id : null
  const leadId = typeof row.lead_id === "string" ? row.lead_id : null
  const activatedAt = typeof row.activated_at === "string" ? row.activated_at : null
  const enrollmentExpiresAt = futureTimestamp(row.expires_at, now)
  const grant = row.manual_access_grants as ManualAccessGrantRow | null
  if (
    !sourceId ||
    !leadId ||
    !activatedAt ||
    !enrollmentExpiresAt ||
    row.user_id !== userId ||
    typeof row.manual_access_grant_id !== "string" ||
    !grant ||
    grant.id !== row.manual_access_grant_id ||
    grant.user_id !== userId ||
    grant.reason !== "tester" ||
    grant.revoked_at !== null ||
    !futureTimestamp(grant.expires_at, now)
  ) {
    return null
  }
  return {
    accessState: "active",
    sourceId,
    paidAt: null,
    qualifiedAt: activatedAt,
    artifactLeadId: leadId,
    quizSourceKind,
    sourceKind: "field_test",
  }
}

/**
 * Resolves the single paid source that owns a Personal Plan. Memberships are
 * accepted only when their provider purchase is correlated to one exact
 * Personal Plan quiz lead; user or email proximity is never sufficient.
 */
export async function findPersonalPlanEnrollmentForUser(
  supabase: SupabaseBillingClient,
  userId: string,
  now: Date = new Date(),
  release: EnrollmentReleaseDependencies = defaultReleaseDependencies,
): Promise<PersonalPlanEnrollment> {
  // A durable migration binding remains the Plan's source when billing changes.
  // The read RPC rechecks current paid authority; this record grants no access.
  const migration = await resolvePersonalPlanMigrationAdmission({
    client: supabase as never,
    userId,
  })
  if (migration.status === "ready") {
    return {
      accessState: "active",
      sourceId: migration.enrollmentId,
      paidAt: null,
      qualifiedAt: migration.admittedAt,
      artifactLeadId: migration.leadId,
      quizSourceKind: migration.quizSourceKind,
      sourceKind: "migration",
    }
  }
  const oneTime = await findOneTimePurchaseEntitlementForUser(supabase, userId)
  const oneTimeState = resolveOneTimePurchaseAccessState(oneTime)
  if (oneTimeState === "active" && oneTime?.consent?.lead_id) {
    const quizSourceKind = await resolveEligibleQuizSourceKind({
      supabase,
      userId,
      leadId: oneTime.consent.lead_id,
      qualifiedAt: oneTime.purchase.paid_at,
      release,
    })
    if (quizSourceKind) {
      return {
        accessState: "active",
        sourceId: oneTime.purchase.id,
        paidAt: oneTime.purchase.paid_at,
        qualifiedAt: oneTime.purchase.paid_at,
        artifactLeadId: oneTime.consent.lead_id,
        quizSourceKind,
        sourceKind: "one_time",
      }
    }
  }

  const subscriptions = await findCurrentBillingSubscriptionsForUser(supabase, userId, now)
  const subscription = subscriptions.find(
    (candidate) =>
      metadataString(candidate.metadata, "pricing_catalog") ===
      PERSONAL_PLAN_LAUNCH_PRICING_CATALOG,
  )
  if (subscription) {
    const purchaseReference =
      subscription.provider === "paypal"
        ? subscription.provider_subscription_id
        : metadataString(subscription.metadata, "checkout_session_id")
    if (purchaseReference) {
      const enrollmentClient = supabase as unknown as EnrollmentSupabaseClient
      const { data: correlationData, error: correlationError } = await enrollmentClient
        .from("funnel_sessions")
        .select("lead_id,purchase_completed_at")
        .eq("user_id", userId)
        .eq("purchase_provider", subscription.provider)
        .eq("purchase_reference", purchaseReference)
        .maybeSingle()
      if (correlationError) throw correlationError

      const correlation = (correlationData as CorrelationRow | null) ?? null
      const leadId = typeof correlation?.lead_id === "string" ? correlation.lead_id : null
      const paidAt =
        typeof correlation?.purchase_completed_at === "string"
          ? correlation.purchase_completed_at
          : null
      if (leadId && paidAt) {
        const { data: leadData, error: leadError } = await enrollmentClient
          .from("leads")
          .select("quiz_kind,user_id")
          .eq("id", leadId)
          .maybeSingle()
        if (leadError) throw leadError
        const lead = leadData as LeadRow | null
        const quizSourceKind = await resolveEligibleLeadKind({
          lead,
          userId,
          qualifiedAt: paidAt,
          supabase,
          release,
        })
        if (quizSourceKind) {
          return {
            accessState: "active",
            sourceId: subscription.id,
            paidAt,
            qualifiedAt: paidAt,
            artifactLeadId: leadId,
            quizSourceKind,
            sourceKind: "launch_subscription",
          }
        }
      }
    }
  }

  // Freemium (Premium-sheet) admission — T14. Deliberately AFTER the launch-subscription
  // branch above, so a user who somehow holds both keeps the launch enrollment they already
  // had; and gated on an explicit `freemium_plan_admissions` row plus a live paid-authority
  // recheck inside the resolver, so it is inert for every pre-T14 user and with the flag off.
  const freemium = await resolveFreemiumPlanEnrollment(supabase, userId, now)
  if (freemium) {
    return {
      accessState: "active",
      sourceId: freemium.sourceId,
      paidAt: freemium.admittedAt,
      qualifiedAt: freemium.admittedAt,
      artifactLeadId: freemium.leadId,
      quizSourceKind: "personal_plan",
      sourceKind: "freemium",
    }
  }

  const enrollmentClient = supabase as unknown as EnrollmentSupabaseClient
  const { data: partnerData, error: partnerError } = await enrollmentClient
    .from("partner_access_invitations")
    .select(
      "id,claimed_user_id,lead_id,activated_at,revoked_at,current_manual_access_grant_id,current_grant:manual_access_grants!partner_access_invitations_current_manual_access_grant_id_fkey!inner(id,user_id,reason,expires_at,revoked_at,partner_access_invitation_id)",
    )
    .eq("claimed_user_id", userId)
    .is("revoked_at", null)
    .maybeSingle()
  if (partnerError && !isMissingPartnerAccessRelation(partnerError)) throw partnerError
  const partner = (partnerData as PartnerInvitationEnrollmentRow | null) ?? null
  const partnerGrant = partner?.current_grant as
    | (ManualAccessGrantRow & {
        partner_access_invitation_id?: unknown
      })
    | null
  if (
    partner &&
    typeof partner.id === "string" &&
    typeof partner.lead_id === "string" &&
    typeof partner.activated_at === "string" &&
    partner.claimed_user_id === userId &&
    partner.revoked_at === null &&
    typeof partner.current_manual_access_grant_id === "string" &&
    partnerGrant?.id === partner.current_manual_access_grant_id &&
    partnerGrant.user_id === userId &&
    partnerGrant.reason === "partner" &&
    partnerGrant.expires_at === null &&
    partnerGrant.revoked_at === null &&
    partnerGrant.partner_access_invitation_id === partner.id
  ) {
    return {
      accessState: "active",
      sourceId: partner.id,
      paidAt: null,
      qualifiedAt: partner.activated_at,
      artifactLeadId: partner.lead_id,
      quizSourceKind: "legacy",
      sourceKind: "partner",
    }
  }

  // Deploy the source-discriminator migration before this reader. A missing
  // column is a schema error, not proof that the user has no test access.
  const { data: fieldTestData, error: fieldTestError } = await enrollmentClient
    .from("personal_plan_test_enrollments")
    .select(
      "id,user_id,lead_id,manual_access_grant_id,status,activated_at,expires_at,revoked_at,quiz_source_kind,manual_access_grants!inner(id,user_id,reason,expires_at,revoked_at)",
    )
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle()
  if (fieldTestError) {
    if (isMissingPersonalPlanFieldTestRelation(fieldTestError)) return emptyEnrollment(oneTimeState)
    throw fieldTestError
  }
  const personalPlanFieldTestRow = (fieldTestData as FieldTestEnrollmentRow | null) ?? null
  const personalPlanFieldTestQuizSourceKind =
    resolvePersonalPlanFieldTestQuizSourceKind(personalPlanFieldTestRow)
  if (personalPlanFieldTestQuizSourceKind) {
    const personalPlanFieldTest = resolveActiveFieldTestEnrollment(
      personalPlanFieldTestRow,
      userId,
      now,
      personalPlanFieldTestQuizSourceKind,
    )
    if (personalPlanFieldTest) return personalPlanFieldTest
  }

  const { data: regularFieldTestData, error: regularFieldTestError } = await enrollmentClient
    .from("regular_quiz_test_enrollments")
    .select(
      "id,user_id,lead_id,manual_access_grant_id,status,activated_at,expires_at,revoked_at,manual_access_grants!inner(id,user_id,reason,expires_at,revoked_at)",
    )
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle()
  if (regularFieldTestError) {
    if (isMissingRegularQuizFieldTestRelation(regularFieldTestError)) {
      return emptyEnrollment(oneTimeState)
    }
    throw regularFieldTestError
  }
  return (
    resolveActiveFieldTestEnrollment(
      (regularFieldTestData as FieldTestEnrollmentRow | null) ?? null,
      userId,
      now,
      "legacy",
    ) ?? emptyEnrollment(oneTimeState)
  )
}

function isMissingPartnerAccessRelation(error: unknown) {
  if (!error || typeof error !== "object") return false
  const value = error as { code?: unknown; message?: unknown }
  return (
    (value.code === "PGRST200" ||
      value.code === "PGRST204" ||
      value.code === "PGRST205" ||
      value.code === "42P01") &&
    typeof value.message === "string" &&
    value.message.includes("partner_access_invitations")
  )
}

async function resolveEligibleQuizSourceKind(input: {
  supabase: SupabaseBillingClient
  userId: string
  leadId: string
  qualifiedAt: string
  release: EnrollmentReleaseDependencies
}): Promise<"personal_plan" | "legacy" | null> {
  const client = input.supabase as unknown as EnrollmentSupabaseClient
  const { data, error } = await client
    .from("leads")
    .select("quiz_kind,user_id")
    .eq("id", input.leadId)
    .maybeSingle()
  if (error) throw error
  return resolveEligibleLeadKind({
    lead: data as LeadRow | null,
    userId: input.userId,
    qualifiedAt: input.qualifiedAt,
    supabase: input.supabase,
    release: input.release,
  })
}

async function resolveEligibleLeadKind(input: {
  lead: LeadRow | null
  userId: string
  qualifiedAt: string
  supabase: SupabaseBillingClient
  release: EnrollmentReleaseDependencies
}): Promise<"personal_plan" | "legacy" | null> {
  if (input.lead?.user_id !== input.userId) return null
  if (input.lead.quiz_kind === "personal_plan") return "personal_plan"
  if (input.lead.quiz_kind !== "legacy") return null
  const qualifiedAt = new Date(input.qualifiedAt)
  if (Number.isNaN(qualifiedAt.getTime())) return null
  const historicalPaidEnabled = input.release.migrationEnabled?.() === true
  const cutoff = input.release.cohortCutoff()
  if (
    !historicalPaidEnabled &&
    (!input.release.legacyQuizCutoverEnabled() ||
      !cutoff ||
      qualifiedAt.getTime() < cutoff.getTime())
  ) {
    return null
  }
  return (await input.release.appAllowedForUser(input.userId, input.supabase)) ? "legacy" : null
}
