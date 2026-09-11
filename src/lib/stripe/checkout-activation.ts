import { createHash } from "node:crypto"
import type Stripe from "stripe"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  findBillingSubscriptionByProviderId,
  upsertBillingSubscription,
} from "@/lib/billing/subscriptions"
import { assertStripeCreatedAfterModeratorResetCutoff } from "@/lib/billing/moderator-reset-cutoff"
import {
  activateVerifiedOneTimePayment,
  OneTimeActivationError,
  processPersonalPlanOneTimeFulfillmentJob,
  type VerifiedOneTimePayment,
} from "@/lib/billing/personal-plan-one-time-activation"
import { findPersonalPlanOneTimeConsentById } from "@/lib/billing/personal-plan-one-time-consents"
import type {
  BillingOneTimePurchaseRow,
  OneTimeAccessState,
  PersonalPlanOneTimeFulfillmentJobRow,
  SupabaseBillingAnalyticsClient,
} from "@/lib/billing/types"
import { sendPersonalPlanOneTimeConfirmation } from "@/lib/customerio/personal-plan-one-time-confirmation"
import {
  getPersonalPlanOnceStripePriceId,
  PERSONAL_PLAN_ONCE_KIND,
  PERSONAL_PLAN_ONCE_PRODUCT,
} from "@/lib/billing/offer-products"
import { intervalFromPrice } from "./intervals"
import { getStripePriceCatalogForId } from "./client"
import { resolveLegacyQuizFuturePurchaseEligibility } from "@/lib/personal-plan/legacy-cutover-eligibility"

export interface CheckoutActivationDeps {
  supabase: SupabaseClient
  stripe: Stripe
  premiumTierId: string
  linkQuizToProfile?: (userId: string, email: string | undefined, leadId?: string) => Promise<void>
  profileLinkMode?: "await" | "defer" | "skip"
  defer?: (work: () => void | Promise<void>) => void
  now?: () => Date
  sendOneTimeConfirmation?: typeof sendPersonalPlanOneTimeConfirmation
}

export type CheckoutActivationErrorCode =
  | "checkout_session_id_missing"
  | "checkout_session_missing_id"
  | "checkout_session_incomplete"
  | "checkout_session_email_missing"
  | "checkout_session_customer_missing"
  | "checkout_session_subscription_missing"
  | "checkout_session_unpaid"
  | "checkout_preparation_unclaimed"
  | "checkout_subscription_inactive"
  | "checkout_subscription_expired"
  | "checkout_ownership_conflict"
  | "checkout_moderator_reset_cutoff"
  | "checkout_user_race_unresolved"
  | "checkout_one_time_invalid"
  | "checkout_one_time_payment_intent_missing"
  | "checkout_one_time_consent_missing"
  | "checkout_one_time_charge_revoked"
  | "checkout_one_time_confirmation_failed"

export class CheckoutActivationError extends Error {
  code: CheckoutActivationErrorCode

  constructor(code: CheckoutActivationErrorCode, message: string) {
    super(message)
    this.name = "CheckoutActivationError"
    this.code = code
  }
}

export interface CheckoutAccountResult {
  userId: string
  email: string
  canSetInitialPassword: boolean
  leadId?: string
  checkoutContext?: string
  subscriptionInterval?: string
  stripeCustomerId?: string
  stripeSubscriptionId?: string
  subscriptionStatus?: string
  legacyQuizFuturePurchaseEligible?: boolean
}

interface OneTimeCheckoutPaymentResult {
  email: string
  leadId?: string
  checkoutContext?: string
  stripeCustomerId?: string
  paymentIntentId: string
  chargeId?: string
  purchaseId: string
}

export type OneTimeCheckoutAccountResult =
  | (CheckoutAccountResult &
      OneTimeCheckoutPaymentResult & {
        state: "active"
      })
  | (OneTimeCheckoutPaymentResult & {
      state: Exclude<OneTimeAccessState, "active">
    })

export type OneTimeCheckoutActivationDeps = CheckoutActivationDeps

export const PERSONAL_PLAN_PREPARED_ARTIFACT_DELIVERY_PROVIDER = "personal_plan_prepared_artifacts"

interface ProfileRow {
  id: string
  email?: string | null
  stripe_customer_id?: string | null
}

interface SubscriptionProfilePatch {
  email: string
  stripe_customer_id: string
  stripe_subscription_id: string
  subscription_status: "active"
  subscription_interval: string | null
  current_period_end: string
  subscription_tier_id: string
}

/** Shape we actually read from the retrieved subscription. */
export interface RetrievedSub {
  id: string
  created?: number
  status?: string
  current_period_end?: number
  items: {
    data: Array<{
      current_period_end?: number
      price: {
        id?: string
        interval?: string
        interval_count?: number
        recurring?: { interval: string; interval_count: number }
      }
    }>
  }
}

interface ValidCheckoutSession {
  id: string
  email: string
  customerId: string
  subscriptionId: string
}

interface ValidOneTimeCheckoutSession {
  id: string
  email: string
  customerId: string | null
  paymentIntentId: string
  chargeId?: string
  consentId: string
  leadId: string
  funnelSessionId: string
  offerVariant?: string
  paidAt: string
}

interface VerifiedOneTimeCheckoutSessionCandidate extends Omit<
  ValidOneTimeCheckoutSession,
  "leadId" | "funnelSessionId" | "offerVariant"
> {
  leadId?: string
  funnelSessionId?: string
  offerVariant?: string
}

export type StripeOneTimeRecoveryVerification = {
  payment: VerifiedOneTimePayment
  refs: {
    checkoutSessionId: string
    consentId: string
    leadId: string
    funnelSessionId: string
    paymentIntentId: string
    chargeId?: string
    hasStripeCustomer: boolean
  }
}

/**
 * The retrieve half of `verifyCheckoutSessionForActivation`, with none of its assertions.
 *
 * Split out for callers that must decide something about the Session BEFORE its payment
 * state is classified — the Premium sheet's completion endpoint checks ownership first, so
 * a caller who supplies somebody else's Session id learns nothing about it
 * (freemium-scanner-first T14, fix round 1 F6).
 */
export async function retrieveCheckoutSessionForActivation(
  sessionId: string,
  stripe?: Stripe,
): Promise<Stripe.Checkout.Session> {
  if (!sessionId) {
    throw new CheckoutActivationError(
      "checkout_session_id_missing",
      "checkout session id is required",
    )
  }

  const stripeClient = stripe ?? (await import("./client")).getStripe()
  return measureCheckoutStep("stripe.checkout.sessions.retrieve", () =>
    stripeClient.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items.data.price", "payment_intent.latest_charge"],
    }),
  )
}

/** The assertion half: throws `CheckoutActivationError` for a Session that cannot activate. */
export function assertCheckoutSessionActivatable(
  session: Stripe.Checkout.Session,
): Stripe.Checkout.Session {
  if (session.metadata?.product_kind === PERSONAL_PLAN_ONCE_KIND) {
    assertOneTimeCheckoutSession(session as OneTimeSession)
    return session
  }
  assertCheckoutSessionShape(session)
  assertCheckoutPaymentAuthorized(session)
  assertCheckoutPreparationClaimed(session)
  return session
}

export async function verifyCheckoutSessionForActivation(
  sessionId: string,
  stripe?: Stripe,
): Promise<Stripe.Checkout.Session> {
  return assertCheckoutSessionActivatable(
    await retrieveCheckoutSessionForActivation(sessionId, stripe),
  )
}

export async function ensureCheckoutAccount(
  session: Stripe.Checkout.Session,
  deps: CheckoutActivationDeps,
): Promise<CheckoutAccountResult> {
  const startedAt = Date.now()
  const valid = assertCheckoutSessionShape(session)
  const sessionHash = checkoutSessionHash(valid.id).slice(0, 12)
  assertCheckoutPaymentAuthorized(session)
  assertCheckoutPreparationClaimed(session)
  const sub = await retrieveCheckoutSubscription(deps.stripe, valid.subscriptionId)
  assertCurrentCheckoutSubscription(sub, deps.now?.() ?? new Date())

  const existingProfile = await measureCheckoutStep("profiles.findExisting", () =>
    findExistingProfile(deps, valid.email, valid.customerId, sub.id),
  )

  let userId: string
  let canSetInitialPassword = false

  if (existingProfile) {
    userId = existingProfile.id
    const authUser = await readExistingCheckoutAuthUser(deps, userId)
    assertCheckoutAfterModeratorResetCutoff(authUser.app_metadata, session, sub)
    canSetInitialPassword = canSetPasswordForAuthUser(authUser, valid.id)
  } else {
    const created = await measureCheckoutStep("auth.createCheckoutUser", () =>
      createCheckoutUser(deps, valid.email, valid.id, valid.customerId, sub.id),
    )
    userId = created.userId
    if (created.created) {
      canSetInitialPassword = true
    } else {
      const authUser = await readExistingCheckoutAuthUser(deps, userId)
      assertCheckoutAfterModeratorResetCutoff(authUser.app_metadata, session, sub)
      // A duplicate-create recovery never receives a password capability, even when
      // the recovered account still has an old matching activation marker.
      canSetInitialPassword = false
    }
  }

  const price = sub.items.data[0].price
  const interval = intervalFromPrice({
    interval: price.recurring?.interval ?? price.interval ?? "",
    interval_count: price.recurring?.interval_count ?? price.interval_count ?? 1,
  })

  await measureCheckoutStep("profiles.upsertSubscription", () =>
    upsertSubscriptionProfile(deps, userId, {
      email: valid.email,
      stripe_customer_id: valid.customerId,
      stripe_subscription_id: sub.id,
      subscription_status: "active",
      subscription_interval: interval,
      current_period_end: subPeriodEndIso(sub),
      subscription_tier_id: deps.premiumTierId,
    }),
  )

  await measureCheckoutStep("billing.upsertSubscription", () =>
    upsertBillingSubscription(deps.supabase, {
      user_id: userId,
      provider: "stripe",
      provider_customer_id: valid.customerId,
      provider_subscription_id: sub.id,
      provider_status: sub.status ?? "active",
      entitlement_status: stripeEntitlementStatus(sub.status),
      interval,
      current_period_end: subPeriodEndIso(sub),
      cancel_at_period_end: false,
      metadata: {
        checkout_session_id: valid.id,
        payment_status: session.payment_status ?? "unknown",
        ...stripePricingMetadata(price.id),
      },
    }),
  )

  await linkCheckoutQuizProfile(session, deps, userId, valid.email)
  const subscriptionPaidAtSeconds = typeof sub.created === "number" ? sub.created : null
  const legacyQuizFuturePurchaseEligible =
    typeof subscriptionPaidAtSeconds === "number"
      ? await resolveLegacyQuizFuturePurchaseEligibility(deps.supabase, {
          userId,
          leadId: session.metadata?.lead_id,
          paidAt: new Date(subscriptionPaidAtSeconds * 1000).toISOString(),
          provider: "stripe",
        })
      : false

  console.info("[checkout-activation] account ensured", {
    sessionHash,
    userId,
    profileLinkMode: deps.profileLinkMode ?? "await",
    durationMs: Date.now() - startedAt,
  })

  return {
    userId,
    email: valid.email,
    canSetInitialPassword,
    leadId: session.metadata?.lead_id || undefined,
    checkoutContext: session.metadata?.checkout_context || undefined,
    subscriptionInterval: interval,
    stripeCustomerId: valid.customerId,
    stripeSubscriptionId: sub.id,
    subscriptionStatus: sub.status ?? "active",
    legacyQuizFuturePurchaseEligible,
  }
}

export function stripePricingMetadata(priceId: string | undefined): Record<string, string> {
  const normalizedPriceId = priceId?.trim() || null
  if (!normalizedPriceId) return {}
  const priceCatalog = normalizedPriceId ? getStripePriceCatalogForId(normalizedPriceId) : null
  if (!priceCatalog) return { stripe_price_id: normalizedPriceId }
  return {
    stripe_price_id: normalizedPriceId,
    pricing_catalog: priceCatalog.family,
  }
}

/** Activates the one-time personal-plan entitlement without touching subscription state. */
export async function ensureOneTimeCheckoutAccount(
  session: Stripe.Checkout.Session,
  deps: OneTimeCheckoutActivationDeps,
): Promise<OneTimeCheckoutAccountResult> {
  const verified = await retrieveOneTimeCheckoutSession(session, deps.stripe)
  const valid = await assertStripeOneTimeConsentReference(
    deps.supabase,
    assertOneTimeCheckoutSession(verified),
  )
  let accountResult:
    | { userId: string; canSetInitialPassword: boolean; created: boolean }
    | undefined
  const activation = await activateVerifiedOneTimePayment(
    verifiedStripeOneTimePayment(verified, valid),
    {
      supabase: deps.supabase as SupabaseBillingAnalyticsClient,
      sendConfirmation: deps.sendOneTimeConfirmation,
      ensureAccount: async () => {
        const existingProfile = await findExistingProfile(deps, valid.email, valid.customerId)
        const created = existingProfile
          ? { userId: existingProfile.id, created: false }
          : await createCheckoutUser(deps, valid.email, valid.id, valid.customerId)
        const canSetInitialPassword = created.created
          ? true
          : await canSetPasswordForCheckoutSession(deps, created.userId, valid.id)
        await upsertOneTimeProfile(deps, created.userId, valid.email, valid.customerId)
        accountResult = { ...created, canSetInitialPassword }
        return { userId: created.userId }
      },
      linkQuizToProfile: async ({ userId }) => {
        // Locked-plan finalization reads the prepared artifact by the purchase user.
        // One-time fulfillment therefore cannot defer this link as subscriptions can.
        await linkCheckoutQuizProfile(
          verified,
          { ...deps, profileLinkMode: "await" },
          userId,
          valid.email,
          valid.leadId,
        )
      },
      finalizeLockedPlan: async ({ consent, purchase }) => {
        const artifact = await bindAndLoadPreparedLockedPlanArtifact(
          deps.supabase,
          consent.lead_id,
          requireBoundOneTimePurchaseUser(purchase),
        )
        return {
          lockedPlan: artifact.locked_plan,
          deliveryProvider: PERSONAL_PLAN_PREPARED_ARTIFACT_DELIVERY_PROVIDER,
          deliveryReference: artifact.id,
        }
      },
      defer: deps.defer,
      now: deps.now,
    },
  )
  const userId = accountResult?.userId ?? activation.purchase.user_id
  const baseOneTimeResult: OneTimeCheckoutPaymentResult = {
    email: valid.email,
    leadId: valid.leadId,
    checkoutContext: verified.metadata?.checkout_context || undefined,
    stripeCustomerId: valid.customerId ?? undefined,
    paymentIntentId: valid.paymentIntentId,
    chargeId: valid.chargeId,
    purchaseId: activation.purchase.id,
  }

  if (activation.state !== "active" || !userId) {
    return {
      ...baseOneTimeResult,
      state: activation.state === "active" ? "paid_pending" : activation.state,
    }
  }

  return {
    ...baseOneTimeResult,
    userId,
    canSetInitialPassword:
      accountResult?.canSetInitialPassword ??
      (await canSetPasswordForCheckoutSession(deps, userId, valid.id)),
    state: activation.state,
    legacyQuizFuturePurchaseEligible: await resolveLegacyQuizFuturePurchaseEligibility(
      deps.supabase,
      { userId, leadId: valid.leadId, paidAt: valid.paidAt, provider: "stripe" },
    ),
  }
}

export async function verifyStripeOneTimePaymentForRecovery(
  sessionId: string,
  stripe: Stripe,
  supabase: SupabaseClient,
): Promise<StripeOneTimeRecoveryVerification> {
  const verified = await retrieveOneTimeCheckoutSession(
    { id: sessionId } as Stripe.Checkout.Session,
    stripe,
  )
  const valid = await assertStripeOneTimeConsentReference(
    supabase,
    assertOneTimeCheckoutSession(verified),
  )
  return {
    payment: verifiedStripeOneTimePayment(verified, valid),
    refs: {
      checkoutSessionId: valid.id,
      consentId: valid.consentId,
      leadId: valid.leadId,
      funnelSessionId: valid.funnelSessionId,
      paymentIntentId: valid.paymentIntentId,
      chargeId: valid.chargeId,
      hasStripeCustomer: Boolean(valid.customerId),
    },
  }
}

export async function processStripeOneTimeFulfillmentJob(
  job: PersonalPlanOneTimeFulfillmentJobRow,
  deps: OneTimeCheckoutActivationDeps,
) {
  let retryContext: {
    session: OneTimeSession
    valid: ValidOneTimeCheckoutSession
  } | null = null

  const requireRetryContext = () => {
    if (!retryContext) {
      throw new CheckoutActivationError(
        "checkout_one_time_invalid",
        "Stripe one-time retry has no verified payment context",
      )
    }
    return retryContext
  }

  return processPersonalPlanOneTimeFulfillmentJob(job, {
    supabase: deps.supabase as SupabaseBillingAnalyticsClient,
    sendConfirmation: deps.sendOneTimeConfirmation,
    ensureAccount: async () => {
      const { valid } = requireRetryContext()
      const existingProfile = await findExistingProfile(deps, valid.email, valid.customerId)
      const created = existingProfile
        ? { userId: existingProfile.id, created: false }
        : await createCheckoutUser(deps, valid.email, valid.id, valid.customerId)
      await upsertOneTimeProfile(deps, created.userId, valid.email, valid.customerId)
      return { userId: created.userId }
    },
    linkQuizToProfile: async ({ userId }) => {
      const { session, valid } = requireRetryContext()
      await linkCheckoutQuizProfile(session, deps, userId, valid.email, valid.leadId)
    },
    finalizeLockedPlan: async ({ consent, purchase }) => {
      const artifact = await bindAndLoadPreparedLockedPlanArtifact(
        deps.supabase,
        consent.lead_id,
        requireBoundOneTimePurchaseUser(purchase),
      )
      return {
        lockedPlan: artifact.locked_plan,
        deliveryProvider: PERSONAL_PLAN_PREPARED_ARTIFACT_DELIVERY_PROVIDER,
        deliveryReference: artifact.id,
      }
    },
    now: deps.now,
    resolveVerifiedPaymentForRetry: async ({ purchase, consent }) => {
      try {
        if (purchase.provider !== "stripe") {
          throw new CheckoutActivationError(
            "checkout_one_time_invalid",
            "one-time fulfillment job is not a Stripe purchase",
          )
        }
        if (!purchase.provider_order_id) {
          throw new CheckoutActivationError(
            "checkout_one_time_invalid",
            "Stripe one-time purchase has no Checkout Session reference",
          )
        }
        const session = await retrieveOneTimeCheckoutSession(
          { id: purchase.provider_order_id } as Stripe.Checkout.Session,
          deps.stripe,
        )
        const valid = await assertStripeOneTimeConsentReference(
          deps.supabase,
          assertOneTimeCheckoutSession(session),
        )
        assertStripeRetryIdentity({ purchase, consent, valid })
        retryContext = { session, valid }
        return verifiedStripeOneTimePayment(session, valid)
      } catch (error) {
        throw stripeRetryVerificationError(error)
      }
    },
  })
}

function stripeRetryVerificationError(error: unknown): unknown {
  if (error instanceof OneTimeActivationError) return error
  if (!(error instanceof CheckoutActivationError)) return error
  return new OneTimeActivationError(
    `stripe_${error.code}`,
    error.message,
    isRetryableStripeOneTimeVerificationError(error),
  )
}

function isRetryableStripeOneTimeVerificationError(error: CheckoutActivationError) {
  return error.code === "checkout_session_incomplete" || error.code === "checkout_session_unpaid"
}

async function assertStripeOneTimeConsentReference(
  supabase: SupabaseClient,
  candidate: VerifiedOneTimeCheckoutSessionCandidate,
): Promise<ValidOneTimeCheckoutSession> {
  const consent = await findPersonalPlanOneTimeConsentById(supabase, candidate.consentId)
  if (!consent) {
    throw new CheckoutActivationError(
      "checkout_one_time_consent_missing",
      "one-time checkout consent is missing",
    )
  }
  if (consent.stripe_checkout_session_id !== candidate.id) {
    throw new CheckoutActivationError(
      "checkout_one_time_invalid",
      "one-time checkout consent does not belong to this Stripe checkout session",
    )
  }
  if (
    (candidate.leadId && consent.lead_id !== candidate.leadId) ||
    (candidate.funnelSessionId && consent.funnel_session_id !== candidate.funnelSessionId) ||
    (candidate.offerVariant && consent.offer_variant !== candidate.offerVariant)
  ) {
    throw new CheckoutActivationError(
      "checkout_one_time_invalid",
      "one-time checkout consent does not match Stripe checkout metadata",
    )
  }
  return {
    ...candidate,
    leadId: consent.lead_id,
    funnelSessionId: consent.funnel_session_id,
    offerVariant: consent.offer_variant || undefined,
  }
}

type OneTimeSession = Stripe.Checkout.Session & {
  payment_intent?:
    | string
    | {
        id?: string
        created?: number
        latest_charge?:
          | string
          | {
              id?: string
              created?: number
              amount?: number
              amount_refunded?: number
              refunded?: boolean
              disputed?: boolean
            }
          | null
      }
    | null
  line_items?: { data?: Array<{ price?: { id?: string } | null }> } | null
}

async function retrieveOneTimeCheckoutSession(session: Stripe.Checkout.Session, stripe: Stripe) {
  if (!session.id)
    throw new CheckoutActivationError("checkout_session_missing_id", "checkout session has no id")
  return (await stripe.checkout.sessions.retrieve(session.id, {
    expand: ["line_items.data.price", "payment_intent.latest_charge"],
  })) as OneTimeSession
}

function assertOneTimeCheckoutSession(
  session: OneTimeSession,
): VerifiedOneTimeCheckoutSessionCandidate {
  assertCheckoutPreparationClaimed(session)
  const email = session.customer_details?.email
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id
  const paymentIntentId = stripeObjectId(session.payment_intent)
  const chargeId =
    typeof session.payment_intent === "object"
      ? stripeObjectId(session.payment_intent?.latest_charge)
      : null
  const paidAt = stripeOneTimePaidAt(session)
  const expectedPriceId = getPersonalPlanOnceStripePriceId()
  const lineItemPriceIds =
    session.line_items?.data?.map((item) => item.price?.id).filter(Boolean) ?? []
  const consentId = session.metadata?.personal_plan_once_consent_id
  const leadId = session.metadata?.lead_id
  const funnelSessionId = session.metadata?.funnel_session_id
  const offerVariant = session.metadata?.offer_variant
  if (session.status !== "complete") {
    throw new CheckoutActivationError(
      "checkout_session_incomplete",
      "one-time checkout session is not complete",
    )
  }
  if (session.payment_status !== "paid") {
    throw new CheckoutActivationError(
      "checkout_session_unpaid",
      "one-time checkout session payment is not paid",
    )
  }
  if (
    session.metadata?.product_kind !== PERSONAL_PLAN_ONCE_KIND ||
    session.mode !== "payment" ||
    session.amount_total !== PERSONAL_PLAN_ONCE_PRODUCT.amountMinor ||
    session.currency?.toLowerCase() !== "eur" ||
    !expectedPriceId ||
    lineItemPriceIds.length !== 1 ||
    lineItemPriceIds[0] !== expectedPriceId ||
    !email ||
    !isUuid(consentId) ||
    (leadId !== undefined && !isUuid(leadId)) ||
    (funnelSessionId !== undefined && !isUuid(funnelSessionId))
  ) {
    throw new CheckoutActivationError(
      "checkout_one_time_invalid",
      "one-time checkout session failed validation",
    )
  }
  if (!paymentIntentId) {
    throw new CheckoutActivationError(
      "checkout_one_time_payment_intent_missing",
      "one-time checkout session has no payment intent",
    )
  }
  if (!paidAt) {
    throw new CheckoutActivationError(
      "checkout_one_time_invalid",
      "one-time checkout session has no charge or payment intent paid timestamp",
    )
  }
  assertOneTimeLatestChargeIsNotRevoked(session)
  return {
    id: session.id!,
    email,
    customerId: customerId ?? null,
    paymentIntentId,
    chargeId: chargeId ?? undefined,
    consentId: consentId!,
    leadId: leadId || undefined,
    funnelSessionId: funnelSessionId || undefined,
    offerVariant: offerVariant || undefined,
    paidAt,
  }
}

function assertOneTimeLatestChargeIsNotRevoked(session: OneTimeSession) {
  if (typeof session.payment_intent !== "object" || session.payment_intent === null) return
  const charge = session.payment_intent.latest_charge
  if (!charge || typeof charge === "string") return

  const fullyRefunded =
    charge.refunded === true ||
    (typeof charge.amount === "number" &&
      charge.amount > 0 &&
      typeof charge.amount_refunded === "number" &&
      charge.amount_refunded >= charge.amount)
  if (fullyRefunded || charge.disputed === true) {
    throw new CheckoutActivationError(
      "checkout_one_time_charge_revoked",
      "one-time checkout latest charge is fully refunded or disputed",
    )
  }
}

function verifiedStripeOneTimePayment(
  session: OneTimeSession,
  valid: ValidOneTimeCheckoutSession,
): VerifiedOneTimePayment {
  return {
    provider: "stripe",
    providerTransactionId: valid.paymentIntentId,
    providerOrderId: valid.id,
    providerCustomerId: valid.customerId,
    consentId: valid.consentId,
    email: valid.email,
    amountMinor: PERSONAL_PLAN_ONCE_PRODUCT.amountMinor,
    currency: "eur",
    paidAt: valid.paidAt,
    providerEvidence: stripeOneTimeProviderEvidence(session, valid),
  }
}

function assertStripeRetryIdentity(input: {
  purchase: BillingOneTimePurchaseRow
  consent: { id: string }
  valid: ValidOneTimeCheckoutSession
}) {
  if (
    input.valid.id !== input.purchase.provider_order_id ||
    input.valid.paymentIntentId !== input.purchase.provider_transaction_id ||
    input.valid.consentId !== input.purchase.consent_id ||
    input.valid.consentId !== input.consent.id
  ) {
    throw new CheckoutActivationError(
      "checkout_one_time_invalid",
      "Stripe one-time retry payment does not match the fulfillment job purchase",
    )
  }
}

function stripeObjectId(value: string | { id?: string } | null | undefined): string | null {
  return typeof value === "string" ? value : (value?.id ?? null)
}

function stripeObjectCreatedAt(value: { created?: number } | string | null | undefined) {
  return typeof value === "object" && value !== null && typeof value.created === "number"
    ? value.created
    : null
}

function stripeOneTimePaidAt(session: OneTimeSession): string | null {
  if (typeof session.payment_intent !== "object" || session.payment_intent === null) return null
  const chargeCreated =
    typeof session.payment_intent.latest_charge === "object"
      ? stripeObjectCreatedAt(session.payment_intent.latest_charge)
      : null
  const unix = chargeCreated ?? stripeObjectCreatedAt(session.payment_intent)
  return typeof unix === "number" ? new Date(unix * 1000).toISOString() : null
}

function stripeOneTimeProviderEvidence(
  session: OneTimeSession,
  valid: ValidOneTimeCheckoutSession,
): Record<string, unknown> {
  return {
    checkout_session_id: valid.id,
    payment_intent_id: valid.paymentIntentId,
    ...(valid.chargeId ? { stripe_charge_id: valid.chargeId } : {}),
    checkout_status: session.status ?? null,
    payment_status: session.payment_status ?? null,
    line_item_price_id: session.line_items?.data?.[0]?.price?.id ?? null,
  }
}

async function measureCheckoutStep<T>(label: string, work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  try {
    return await work()
  } finally {
    console.info("[checkout-activation] step", {
      label,
      durationMs: Date.now() - startedAt,
    })
  }
}

async function linkCheckoutQuizProfile(
  session: Stripe.Checkout.Session,
  deps: CheckoutActivationDeps,
  userId: string,
  email: string,
  canonicalLeadId?: string,
) {
  if (!deps.linkQuizToProfile || deps.profileLinkMode === "skip") return

  const leadId = canonicalLeadId ?? session.metadata?.lead_id ?? undefined
  const work = async () => {
    const startedAt = Date.now()
    try {
      await deps.linkQuizToProfile?.(userId, email, leadId)
      console.info("[checkout-activation] quiz profile linked", {
        userId,
        hasLeadId: Boolean(leadId),
        durationMs: Date.now() - startedAt,
      })
    } catch (err) {
      console.error("[stripe] linkQuizToProfile failed:", err)
    }
  }

  if (deps.profileLinkMode === "defer" && deps.defer) {
    deps.defer(work)
    return
  }

  await work()
}

function assertCurrentCheckoutSubscription(sub: RetrievedSub, now: Date) {
  if (sub.status && sub.status !== "active") {
    throw new CheckoutActivationError(
      "checkout_subscription_inactive",
      "checkout subscription is not active",
    )
  }

  const periodEnd = subPeriodEndIso(sub)
  if (new Date(periodEnd).getTime() <= now.getTime()) {
    throw new CheckoutActivationError(
      "checkout_subscription_expired",
      "checkout subscription period has expired",
    )
  }
}

/**
 * In Stripe API version 2025-08-27.basil, current_period_end moved from the
 * Subscription root to each SubscriptionItem. Read item first, fall back to
 * root for older API versions.
 */
export function subPeriodEndIso(sub: RetrievedSub): string {
  const itemEnd = sub.items.data[0]?.current_period_end
  const rootEnd = sub.current_period_end
  const unix = itemEnd ?? rootEnd
  if (typeof unix !== "number" || Number.isNaN(unix)) {
    throw new Error("subscription has no current_period_end on item or root")
  }
  return new Date(unix * 1000).toISOString()
}

export function stripeEntitlementStatus(status: string | undefined) {
  if (status === "past_due") return "past_due"
  if (status === "incomplete" || status === "incomplete_expired") return "incomplete"
  if (status && status !== "active" && status !== "trialing") return "canceled"
  return "active"
}

async function retrieveCheckoutSubscription(
  stripe: Stripe,
  subscriptionId: string,
): Promise<RetrievedSub> {
  return (await measureCheckoutStep("stripe.subscriptions.retrieve", () =>
    stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["items.data.price"],
    }),
  )) as unknown as RetrievedSub
}

function assertCheckoutSessionShape(session: Stripe.Checkout.Session): ValidCheckoutSession {
  if (!session.id) {
    throw new CheckoutActivationError("checkout_session_missing_id", "checkout session has no id")
  }
  if (session.status !== "complete") {
    throw new CheckoutActivationError(
      "checkout_session_incomplete",
      "checkout session is not complete",
    )
  }
  const email = session.customer_details?.email
  if (!email) {
    throw new CheckoutActivationError(
      "checkout_session_email_missing",
      "checkout session has no customer email",
    )
  }
  if (typeof session.customer !== "string") {
    throw new CheckoutActivationError(
      "checkout_session_customer_missing",
      "checkout session customer is missing",
    )
  }
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : isRecord(session.subscription) && typeof session.subscription.id === "string"
        ? session.subscription.id
        : null
  if (!subscriptionId) {
    throw new CheckoutActivationError(
      "checkout_session_subscription_missing",
      "checkout session subscription is missing",
    )
  }

  return {
    id: session.id,
    email,
    customerId: session.customer,
    subscriptionId,
  }
}

function assertCheckoutPaymentAuthorized(session: Stripe.Checkout.Session) {
  if (session.payment_status === "paid") return
  if (session.payment_status === "no_payment_required") return

  throw new CheckoutActivationError(
    "checkout_session_unpaid",
    "checkout session payment is not paid",
  )
}

function assertCheckoutPreparationClaimed(session: Stripe.Checkout.Session) {
  const metadata = session.metadata
  if (!metadata || !Object.keys(metadata).some((key) => key.startsWith("checkout_preparation_"))) {
    return
  }

  if (
    metadata.checkout_preparation_status === "claimed" &&
    isUuid(metadata.checkout_preparation_id) &&
    isUuid(metadata.checkout_attempt_id) &&
    isUuid(metadata.checkout_funnel_event_id)
  ) {
    return
  }

  throw new CheckoutActivationError(
    "checkout_preparation_unclaimed",
    "prepared checkout session must be claimed before activation",
  )
}

function isUuid(value: string | undefined): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? "")
}

async function findExistingProfile(
  deps: CheckoutActivationDeps,
  email: string,
  customerId: string | null,
  subscriptionId?: string,
): Promise<ProfileRow | null> {
  const [byEmail, byCustomer, existingSubscription] = await Promise.all([
    findProfileBy(deps, "email", email),
    customerId ? findProfileBy(deps, "stripe_customer_id", customerId) : Promise.resolve(null),
    subscriptionId
      ? findBillingSubscriptionByProviderId(deps.supabase, "stripe", subscriptionId)
      : Promise.resolve(null),
  ])
  const candidates = [byEmail, byCustomer].filter((profile): profile is ProfileRow => !!profile)
  const candidateIds = new Set(candidates.map((profile) => profile.id))
  if (candidateIds.size > 1) {
    throw checkoutOwnershipConflict(
      "checkout email and Stripe customer resolve to different profiles",
    )
  }
  if (!existingSubscription) return candidates[0] ?? null
  if (!existingSubscription.user_id) {
    throw checkoutOwnershipConflict("existing Stripe subscription has no immutable user owner")
  }
  const ownerProfile = await findProfileBy(deps, "id", existingSubscription.user_id)
  if (!ownerProfile) {
    throw checkoutOwnershipConflict("existing Stripe subscription owner profile is missing")
  }
  if (candidateIds.size > 0 && !candidateIds.has(ownerProfile.id)) {
    throw checkoutOwnershipConflict(
      "checkout identity conflicts with existing Stripe subscription owner",
    )
  }
  if (ownerProfile.stripe_customer_id && ownerProfile.stripe_customer_id !== customerId) {
    throw checkoutOwnershipConflict(
      "checkout customer conflicts with existing Stripe subscription owner",
    )
  }
  return ownerProfile
}

async function findProfileBy(
  deps: CheckoutActivationDeps,
  column: "id" | "email" | "stripe_customer_id",
  value: string,
): Promise<ProfileRow | null> {
  const { data, error } = await deps.supabase
    .from("profiles")
    .select("id, email, stripe_customer_id")
    .eq(column, value)
    .maybeSingle()
  if (error) throw new Error(`profile lookup failed: ${error.message}`)
  return data as ProfileRow | null
}

async function upsertSubscriptionProfile(
  deps: CheckoutActivationDeps,
  userId: string,
  patch: SubscriptionProfilePatch,
) {
  const { error } = await deps.supabase.from("profiles").upsert(
    {
      id: userId,
      ...patch,
    },
    { onConflict: "id" },
  )

  if (error) {
    throw new Error(`profile upsert failed: ${error.message}`)
  }
}

async function upsertOneTimeProfile(
  deps: CheckoutActivationDeps,
  userId: string,
  email: string,
  customerId: string | null,
) {
  const patch = customerId
    ? { id: userId, email, stripe_customer_id: customerId }
    : { id: userId, email }
  const { error } = await deps.supabase.from("profiles").upsert(patch, { onConflict: "id" })
  if (error) throw new Error(`profile upsert failed: ${error.message}`)
}

async function createCheckoutUser(
  deps: CheckoutActivationDeps,
  email: string,
  sessionId: string,
  customerId: string | null,
  subscriptionId?: string,
): Promise<{ userId: string; created: boolean }> {
  const { data, error } = await deps.supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: {
      checkout_activation_session_hash: checkoutSessionHash(sessionId),
    },
  })

  if (!error && data.user) return { userId: data.user.id, created: true }

  if (isDuplicateUserError(error)) {
    const existingProfile = await findExistingProfile(deps, email, customerId, subscriptionId)
    if (existingProfile) return { userId: existingProfile.id, created: false }

    const existingAuthUserId = await findAuthUserIdByEmail(deps, email)
    if (existingAuthUserId) return { userId: existingAuthUserId, created: false }

    throw new CheckoutActivationError(
      "checkout_user_race_unresolved",
      "createUser reported a duplicate email but no existing user could be found",
    )
  }

  throw new Error(`createUser failed: ${error?.message ?? "unknown"}`)
}

/**
 * The entitlement finalizer owns the artifact-to-user binding.  The generic
 * quiz/profile projection is best-effort and must not decide whether a paid
 * customer receives their prepared plan.
 */
async function bindAndLoadPreparedLockedPlanArtifact(
  supabase: SupabaseClient,
  leadId: string,
  userId: string,
): Promise<{ id: string; locked_plan: unknown }> {
  const { data, error } = await supabase.rpc("link_personal_plan_artifact_to_user", {
    p_lead_id: leadId,
    p_user_id: userId,
  })
  if (error) throw new Error(`prepared locked plan binding failed: ${error.message}`)
  const artifact = Array.isArray(data) ? data[0] : data
  if (
    !artifact ||
    typeof (artifact as { artifact_id?: unknown }).artifact_id !== "string" ||
    !hasMeaningfulLockedPlan((artifact as { locked_plan?: unknown }).locked_plan)
  ) {
    throw new Error("prepared locked plan is missing for paid one-time checkout")
  }
  return {
    id: (artifact as { artifact_id: string }).artifact_id,
    locked_plan: (artifact as { locked_plan: unknown }).locked_plan,
  }
}

function hasMeaningfulLockedPlan(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") return Object.keys(value).length > 0
  return true
}

function requireBoundOneTimePurchaseUser(
  purchase: Pick<BillingOneTimePurchaseRow, "user_id">,
): string {
  if (!purchase.user_id) {
    throw new CheckoutActivationError(
      "checkout_one_time_invalid",
      "one-time purchase must be user-bound before locked-plan finalization",
    )
  }
  return purchase.user_id
}

function checkoutSessionHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex")
}

async function canSetPasswordForCheckoutSession(
  deps: CheckoutActivationDeps,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const user = await getAuthUserById(deps, userId)
  if (!user) return false

  return canSetPasswordForAuthUser(user, sessionId)
}

function canSetPasswordForAuthUser(user: { app_metadata?: unknown }, sessionId: string): boolean {
  const appMetadata = isRecord(user.app_metadata) ? user.app_metadata : {}
  if (Object.prototype.hasOwnProperty.call(appMetadata, "password_initialized_at")) return false

  return appMetadata.checkout_activation_session_hash === checkoutSessionHash(sessionId)
}

async function readExistingCheckoutAuthUser(
  deps: CheckoutActivationDeps,
  userId: string,
): Promise<{ app_metadata?: unknown }> {
  const user = await getAuthUserById(deps, userId)
  if (!user) throw checkoutOwnershipConflict("existing checkout owner Auth record is unavailable")
  return user
}

function assertCheckoutAfterModeratorResetCutoff(
  metadata: unknown,
  session: Stripe.Checkout.Session,
  subscription: RetrievedSub,
): void {
  try {
    assertStripeCreatedAfterModeratorResetCutoff({
      metadata,
      checkoutSessionCreated: session.created,
      subscriptionCreated: subscription.created,
    })
  } catch (error) {
    throw new CheckoutActivationError(
      "checkout_moderator_reset_cutoff",
      error instanceof Error ? error.message : "moderator reset cutoff rejected checkout",
    )
  }
}

function checkoutOwnershipConflict(message: string): CheckoutActivationError {
  return new CheckoutActivationError("checkout_ownership_conflict", message)
}

async function getAuthUserById(
  deps: CheckoutActivationDeps,
  userId: string,
): Promise<{ app_metadata?: unknown } | null> {
  const admin = deps.supabase.auth.admin as unknown as {
    getUserById?: (userId: string) => Promise<{
      data?: { user?: { app_metadata?: unknown } | null }
      error?: { message?: string } | null
    }>
  }

  if (typeof admin.getUserById !== "function") return null
  const { data, error } = await admin.getUserById(userId)
  if (error) throw new Error(`getUserById failed: ${error.message ?? "unknown"}`)
  return data?.user ?? null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isDuplicateUserError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const err = error as { message?: unknown; code?: unknown; status?: unknown }
  const text = `${String(err.message ?? "")} ${String(err.code ?? "")}`.toLowerCase()
  return (
    text.includes("already registered") ||
    text.includes("already exists") ||
    text.includes("duplicate") ||
    text.includes("email_exists") ||
    text.includes("user_already_exists") ||
    err.status === 422
  )
}

async function findAuthUserIdByEmail(
  deps: CheckoutActivationDeps,
  email: string,
): Promise<string | null> {
  const admin = deps.supabase.auth.admin as unknown as {
    listUsers?: (params?: { page?: number; perPage?: number }) => Promise<{
      data?: { users?: Array<{ id: string; email?: string | null }> }
      error?: { message?: string } | null
    }>
  }

  if (typeof admin.listUsers !== "function") return null
  const { data, error } = await admin.listUsers({ page: 1, perPage: 1000 })
  if (error) throw new Error(`listUsers failed: ${error.message ?? "unknown"}`)

  const normalized = email.toLowerCase()
  return data?.users?.find((user) => user.email?.toLowerCase() === normalized)?.id ?? null
}
