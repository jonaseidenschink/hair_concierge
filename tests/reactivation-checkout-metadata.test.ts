import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { PaymentMethodCheckout } from "../src/components/checkout/payment-method-checkout"
import {
  canChangeReactivationCheckoutPlan,
  getReactivationRetryAttemptId,
} from "../src/components/reactivation/membership-reactivation-checkout"
import { getAuthenticatedCheckoutSuccessRedirect } from "../src/lib/billing/checkout-success-redirect"
import {
  createOrAdoptPayPalReactivationCheckoutIntent,
  type PayPalCheckoutIntentRow,
} from "../src/lib/paypal/checkout-intents"
import {
  bindMembershipReactivationProviderReference,
  claimMembershipReactivationProvider,
  expireMembershipReactivationCheckoutReservation,
  markMembershipReactivationCheckoutCompleted,
  MembershipReactivationCheckoutConflictError,
  type MembershipReactivationCheckoutReservation,
} from "../src/lib/reactivation/checkout-reservations"
import { buildStripeCheckoutSessionParams } from "../src/lib/stripe/checkout-session-params"

test("reactivation Stripe checkout carries only server-validated routing metadata", () => {
  const params = buildStripeCheckoutSessionParams({
    origin: "https://chaarlie.de",
    priceId: "price_quarter",
    customerId: "cus_existing",
    checkoutContext: "membership_reactivation",
    returnDestination: "/routine?view=current",
    reactivationReservationId: "00000000-0000-4000-8000-000000000001",
  })

  assert.deepEqual(params.metadata, {
    checkout_context: "membership_reactivation",
    return_destination: "/routine?view=current",
    reactivation_reservation_id: "00000000-0000-4000-8000-000000000001",
  })
  assert.equal(params.return_url, "https://chaarlie.de/welcome?session_id={CHECKOUT_SESSION_ID}")
})

test("onboarding overrides saved reactivation return destinations", () => {
  assert.equal(getAuthenticatedCheckoutSuccessRedirect(false, "/routine"), "/onboarding")
  assert.equal(getAuthenticatedCheckoutSuccessRedirect(null, "/routine"), "/onboarding")
  assert.equal(getAuthenticatedCheckoutSuccessRedirect(true, "/routine"), "/routine")
  assert.equal(
    getAuthenticatedCheckoutSuccessRedirect(true, null),
    "/profile?membership=reactivated",
  )
})

const recoveringStripeReservation: MembershipReactivationCheckoutReservation = {
  id: "00000000-0000-4000-8000-000000000001",
  user_id: "00000000-0000-4000-8000-000000000002",
  checkout_attempt_id: "00000000-0000-4000-8000-000000000003",
  interval: "quarter",
  return_destination: "/chat",
  provider: "stripe",
  provider_reference: null,
  status: "reconciliation_required",
  expires_at: "2026-07-13T00:00:00.000Z",
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
}

test("same-attempt, same-provider claims can recover reconciliation reservations", async () => {
  const calls: unknown[][] = []
  const supabase = {
    from: () => {
      throw new Error("not used")
    },
    rpc: async (...args: unknown[]) => {
      calls.push(args)
      return { data: recoveringStripeReservation, error: null }
    },
  }

  const reservation = await claimMembershipReactivationProvider(
    supabase as never,
    recoveringStripeReservation.id,
    recoveringStripeReservation.user_id,
    "stripe",
  )

  assert.equal(reservation.status, "reconciliation_required")
  assert.equal(reservation.provider, "stripe")
  assert.deepEqual(calls, [
    [
      "claim_membership_reactivation_checkout_provider",
      {
        p_reservation_id: recoveringStripeReservation.id,
        p_user_id: recoveringStripeReservation.user_id,
        p_provider: "stripe",
      },
    ],
  ])
})

test("cross-provider recovery claims remain conflicts", async () => {
  const supabase = {
    from: () => {
      throw new Error("not used")
    },
    rpc: async () => ({
      data: null,
      error: {
        code: "P0001",
        message: "reactivation checkout provider already selected",
      },
    }),
  }

  await assert.rejects(
    claimMembershipReactivationProvider(
      supabase as never,
      recoveringStripeReservation.id,
      recoveringStripeReservation.user_id,
      "paypal",
    ),
    MembershipReactivationCheckoutConflictError,
  )
})

function createZeroMatchReservationClient() {
  const builder = {
    update: () => builder,
    eq: () => builder,
    is: () => builder,
    in: () => builder,
    select: () => builder,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (value: { error: null }) => unknown) =>
      Promise.resolve({ error: null }).then(resolve),
  }
  return {
    from: () => builder,
    rpc: async () => ({ data: null, error: null }),
  }
}

function createReservationReferenceClient() {
  const state = {
    providerReference: null as string | null,
    status: "provider_selected",
  }

  return {
    state,
    client: {
      from: () => ({
        update: (values: Record<string, unknown>) => {
          let requiresNullReference = false
          const execute = async () => {
            if (typeof values.provider_reference === "string") {
              if (requiresNullReference && state.providerReference === null) {
                state.providerReference = values.provider_reference
                state.status = String(values.status)
                return {
                  data: {
                    id: recoveringStripeReservation.id,
                    provider_reference: state.providerReference,
                  },
                  error: null,
                }
              }
              return { data: null, error: null }
            }

            if (typeof values.status === "string") state.status = values.status
            return { data: null, error: null }
          }
          const builder = {
            eq: () => builder,
            is: (column: string, value: unknown) => {
              if (column === "provider_reference" && value === null) requiresNullReference = true
              return builder
            },
            in: () => builder,
            select: () => builder,
            maybeSingle: execute,
            then: (
              resolve: (value: Awaited<ReturnType<typeof execute>>) => unknown,
              reject?: (reason: unknown) => unknown,
            ) => execute().then(resolve, reject),
          }
          return builder
        },
        select: () => {
          const builder = {
            eq: () => builder,
            maybeSingle: async () => ({
              data: { provider_reference: state.providerReference },
              error: null,
            }),
          }
          return builder
        },
      }),
      rpc: async () => ({ data: null, error: null }),
    },
  }
}

test("provider binding and completion reject zero-row state transitions", async () => {
  const bindClient = createZeroMatchReservationClient()
  await assert.rejects(
    bindMembershipReactivationProviderReference(
      bindClient as never,
      recoveringStripeReservation.id,
      "cs_existing",
    ),
    MembershipReactivationCheckoutConflictError,
  )

  const completeClient = createZeroMatchReservationClient()
  await assert.rejects(
    markMembershipReactivationCheckoutCompleted(
      completeClient as never,
      recoveringStripeReservation.id,
      recoveringStripeReservation.user_id,
    ),
    MembershipReactivationCheckoutConflictError,
  )

  const expireClient = createZeroMatchReservationClient()
  await assert.rejects(
    expireMembershipReactivationCheckoutReservation(expireClient as never, {
      reservationId: recoveringStripeReservation.id,
      userId: recoveringStripeReservation.user_id,
      providerReference: "cs_missing",
    }),
    MembershipReactivationCheckoutConflictError,
  )
})

test("provider reference binding is compare-and-set and idempotent for the canonical reference", async () => {
  const { client, state } = createReservationReferenceClient()

  await bindMembershipReactivationProviderReference(
    client as never,
    recoveringStripeReservation.id,
    "intent-canonical",
  )
  await bindMembershipReactivationProviderReference(
    client as never,
    recoveringStripeReservation.id,
    "intent-canonical",
  )

  assert.equal(state.providerReference, "intent-canonical")
  assert.equal(state.status, "provider_created")

  await assert.rejects(
    bindMembershipReactivationProviderReference(
      client as never,
      recoveringStripeReservation.id,
      "intent-competing",
    ),
    MembershipReactivationCheckoutConflictError,
  )
  assert.equal(state.providerReference, "intent-canonical")
  assert.equal(state.status, "reconciliation_required")
})

test("PayPal reactivation intent creation adopts the canonical row after a unique race", async () => {
  const reservationId = recoveringStripeReservation.id
  const canonicalIntent: PayPalCheckoutIntentRow = {
    id: "00000000-0000-4000-8000-000000000010",
    token: "canonical-token",
    interval: "quarter",
    source: "pricing_page",
    lead_id: null,
    email: "member@example.com",
    user_id: recoveringStripeReservation.user_id,
    reactivation_reservation_id: reservationId,
    provider_subscription_id: null,
    status: "created",
    duplicate_reason: null,
    expires_at: "2026-07-16T00:00:00.000Z",
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    metadata: { reactivation_reservation_id: reservationId },
  }
  const insertedValues: Record<string, unknown>[] = []
  let selectedColumn: string | null = null
  const client = {
    from: () => ({
      insert: (values: Record<string, unknown>) => {
        insertedValues.push(values)
        return {
          select: () => ({
            single: async () => ({
              data: null,
              error: { code: "23505", message: "duplicate key value violates unique constraint" },
            }),
          }),
        }
      },
      select: () => ({
        eq: (column: string, value: string) => {
          selectedColumn = column
          assert.equal(value, reservationId)
          return {
            maybeSingle: async () => ({ data: canonicalIntent, error: null }),
          }
        },
      }),
    }),
  }

  const intent = await createOrAdoptPayPalReactivationCheckoutIntent(client as never, {
    interval: "quarter",
    source: "pricing_page",
    email: "Member@Example.com",
    userId: recoveringStripeReservation.user_id,
    reactivationReservationId: reservationId,
  })

  assert.equal(intent.id, canonicalIntent.id)
  assert.equal(selectedColumn, "reactivation_reservation_id")
  assert.equal(insertedValues[0]?.reactivation_reservation_id, reservationId)
  assert.deepEqual(insertedValues[0]?.metadata, { reactivation_reservation_id: reservationId })
})

test("reactivation retries preserve the attempt and provider start locks plan changes", () => {
  const attemptId = "00000000-0000-4000-8000-000000000003"

  assert.equal(getReactivationRetryAttemptId(attemptId), attemptId)
  assert.throws(() => getReactivationRetryAttemptId(null), /checkout attempt missing/)
  assert.equal(canChangeReactivationCheckoutPlan(null), true)
  assert.equal(canChangeReactivationCheckoutPlan("stripe"), false)
  assert.equal(canChangeReactivationCheckoutPlan("paypal"), false)

  const componentSource = readFileSync(
    new URL("../src/components/reactivation/membership-reactivation-checkout.tsx", import.meta.url),
    "utf8",
  )
  assert.doesNotMatch(componentSource, /checkoutAttemptController\.retry\(\)/)
  assert.match(componentSource, /lockedProvider=\{lockedProvider\}/)
  assert.doesNotMatch(componentSource, /onPaymentMethodSelected=\{lockCheckoutToProvider\}/)

  const stripeLockIndex = componentSource.indexOf('lockCheckoutToProvider("stripe")')
  const clientSecretValidationIndex = componentSource.indexOf("if (!clientSecret)")
  assert.ok(clientSecretValidationIndex > -1)
  assert.ok(stripeLockIndex > clientSecretValidationIndex)
})

test("a locked provider checkout hides fallback providers and disables plan changes", () => {
  const previousPayPalEnabled = process.env.NEXT_PUBLIC_PAYPAL_ENABLED
  process.env.NEXT_PUBLIC_PAYPAL_ENABLED = "true"

  try {
    const commonProps = {
      checkoutAttemptId: recoveringStripeReservation.checkout_attempt_id,
      checkoutContext: "membership_reactivation" as const,
      checkoutError: "Bitte versuche es erneut.",
      checkoutKey: "quarter:attempt",
      fetchClientSecret: async () => "secret",
      interval: "quarter" as const,
      onChangePlan: () => undefined,
      onPayPalCheckoutStarted: () => undefined,
      onRetry: () => undefined,
      planLabel: "Quartalsplan",
      source: "pricing_page" as const,
      stripe: Promise.resolve(null),
    }

    const stripeHtml = renderToStaticMarkup(
      createElement(PaymentMethodCheckout, { ...commonProps, lockedProvider: "stripe" }),
    )
    assert.match(stripeHtml, /Dein Karten-Checkout läuft bereits/)
    assert.match(stripeHtml, /disabled=""/)
    assert.doesNotMatch(stripeHtml, /PayPal öffnet sich/)
    assert.doesNotMatch(stripeHtml, /Karte &amp; weitere/)

    const paypalHtml = renderToStaticMarkup(
      createElement(PaymentMethodCheckout, { ...commonProps, lockedProvider: "paypal" }),
    )
    assert.match(paypalHtml, /Dein PayPal-Checkout läuft bereits/)
    assert.match(paypalHtml, /disabled=""/)
    assert.match(paypalHtml, /PayPal öffnet sich/)
    assert.doesNotMatch(paypalHtml, /Karte &amp; weitere/)
    assert.doesNotMatch(paypalHtml, /Bitte versuche es erneut/)
  } finally {
    if (previousPayPalEnabled === undefined) {
      delete process.env.NEXT_PUBLIC_PAYPAL_ENABLED
    } else {
      process.env.NEXT_PUBLIC_PAYPAL_ENABLED = previousPayPalEnabled
    }
  }
})

test("reservation SQL permits same-provider reconciliation but rejects provider switching", () => {
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20260714200000_membership_reactivation_checkout_reservations.sql",
      import.meta.url,
    ),
    "utf8",
  )

  assert.match(
    migration,
    /reservation\.status <> 'reconciliation_required'[\s\S]*reservation\.expires_at <= now\(\)/,
  )
  assert.doesNotMatch(migration, /requires reconciliation/)
  assert.match(
    migration,
    /reservation\.provider IS NOT NULL AND reservation\.provider <> p_provider/,
  )
})

test("reservation acquisition adopts compatible authoritative attempts across reloads", () => {
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20260714200000_membership_reactivation_checkout_reservations.sql",
      import.meta.url,
    ),
    "utf8",
  )
  const acquireFunction = migration.slice(
    migration.indexOf("CREATE OR REPLACE FUNCTION acquire_membership_reactivation_checkout"),
    migration.indexOf("CREATE OR REPLACE FUNCTION claim_membership_reactivation_checkout_provider"),
  )

  assert.match(
    acquireFunction,
    /status IN \('open', 'provider_selected', 'provider_created', 'reconciliation_required'\)[\s\S]*FOR UPDATE/,
  )
  assert.match(
    acquireFunction,
    /reservation\.interval <> p_interval OR reservation\.return_destination <> p_return_destination[\s\S]*already in progress/,
  )
  assert.match(acquireFunction, /IF FOUND THEN[\s\S]*RETURN reservation;/)

  const reconciliationIndex = acquireFunction.indexOf("'reconciliation_required'")
  const adoptionReturnIndex = acquireFunction.indexOf(
    "RETURN reservation;",
    acquireFunction.indexOf("FOR UPDATE", reconciliationIndex),
  )
  assert.ok(reconciliationIndex > -1)
  assert.ok(adoptionReturnIndex > reconciliationIndex)
})

test("reservation acquisition rechecks compatible parameters after insert races", () => {
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20260714200000_membership_reactivation_checkout_reservations.sql",
      import.meta.url,
    ),
    "utf8",
  )
  const uniqueRaceHandler = migration.slice(
    migration.indexOf("EXCEPTION WHEN unique_violation"),
    migration.indexOf(
      "RETURN reservation;\nEND;",
      migration.indexOf("EXCEPTION WHEN unique_violation"),
    ),
  )

  assert.match(
    uniqueRaceHandler,
    /status IN \('open', 'provider_selected', 'provider_created', 'reconciliation_required'\)/,
  )
  assert.match(
    uniqueRaceHandler,
    /reservation\.interval <> p_interval OR reservation\.return_destination <> p_return_destination/,
  )
  assert.match(uniqueRaceHandler, /RETURN reservation;/)
})

test("PayPal reactivation intents have a dedicated foreign key and one canonical row", () => {
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20260715200000_paypal_reactivation_intent_uniqueness.sql",
      import.meta.url,
    ),
    "utf8",
  )

  assert.match(
    migration,
    /ADD COLUMN reactivation_reservation_id uuid[\s\S]*REFERENCES membership_reactivation_checkout_reservations \(id\)/,
  )
  assert.match(
    migration,
    /row_number\(\) OVER \([\s\S]*PARTITION BY reservation\.id[\s\S]*reservation_rank = 1/,
  )
  assert.match(migration, /reactivation_reservation_duplicate_ignored/)
  assert.match(
    migration,
    /CREATE UNIQUE INDEX paypal_checkout_intents_one_per_reactivation_reservation[\s\S]*WHERE reactivation_reservation_id IS NOT NULL/,
  )
})
