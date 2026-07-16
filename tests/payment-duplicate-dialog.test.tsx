import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  buildPayPalDuplicateCheckoutBody,
  PAYPAL_DUPLICATE_CHECKOUT_COPY,
} from "../src/lib/paypal/duplicate-guard"

const dialogSource = readFileSync(
  new URL("../src/components/checkout/active-subscription-dialog.tsx", import.meta.url),
  "utf8",
)
const paypalButtonSource = readFileSync(
  new URL("../src/components/checkout/paypal-subscription-button.tsx", import.meta.url),
  "utf8",
)
const membershipReactivationSource = readFileSync(
  new URL("../src/components/reactivation/membership-reactivation-checkout.tsx", import.meta.url),
  "utf8",
)
const resultOfferPricingSource = readFileSync(
  new URL("../src/components/quiz/result-offer-pricing.tsx", import.meta.url),
  "utf8",
)
const paypalCreateRouteSource = readFileSync(
  new URL("../src/app/api/paypal/create-subscription-intent/route.ts", import.meta.url),
  "utf8",
)
const paypalApproveRouteSource = readFileSync(
  new URL("../src/app/api/paypal/approve-subscription/route.ts", import.meta.url),
  "utf8",
)
const stripeRouteSource = readFileSync(
  new URL("../src/app/api/stripe/create-checkout-session/route.ts", import.meta.url),
  "utf8",
)
const stripeCheckoutSessionParamsSource = readFileSync(
  new URL("../src/lib/stripe/checkout-session-params.ts", import.meta.url),
  "utf8",
)

test("active subscription dialog links known emails to prefilled auth", () => {
  assert.match(dialogSource, /Aktives Abo gefunden/)
  assert.match(dialogSource, /Für diese Chaarlie-E-Mail gibt es bereits ein aktives Abo\./)
  assert.match(dialogSource, /Bitte melde dich mit dieser E-Mail an/)
  assert.ok(dialogSource.includes("`/auth?email=${encodeURIComponent(normalizedEmail)}`"))
  assert.match(dialogSource, /const loginHref = normalizedEmail/)
})

test("active subscription dialog has an unknown-email fallback", () => {
  assert.match(dialogSource, /Für dieses Konto gibt es bereits ein aktives Abo\./)
  assert.match(dialogSource, /Bitte melde dich an, um dein Abo zu nutzen\./)
  assert.ok(dialogSource.includes(': "/auth"'))
})

test("PayPal duplicate responses open the modal instead of redirecting to welcome", () => {
  assert.match(paypalButtonSource, /ActiveSubscriptionDialog/)
  assert.match(paypalButtonSource, /setDuplicateDialogOpen\(true\)/)
  assert.match(paypalButtonSource, /readCheckoutAccessAlreadyExistsEmail/)
  assert.doesNotMatch(
    paypalButtonSource,
    /if \(approved\.duplicate\) window\.location\.assign\(buildPayPalWelcomeUrl\(token\)\)/,
  )
})

test("Stripe duplicate responses are handled in offer and membership reactivation checkout", () => {
  for (const source of [membershipReactivationSource, resultOfferPricingSource]) {
    assert.match(source, /ActiveSubscriptionDialog/)
    assert.match(source, /isCheckoutAccessAlreadyExistsResponse/)
    assert.match(source, /readCheckoutAccessAlreadyExistsEmail/)
    assert.match(source, /setDuplicateDialogOpen\(true\)/)
  }
})

test("duplicate checkout API responses include known context email", () => {
  assert.ok(paypalCreateRouteSource.includes("canExposeConflictEmail ? email : null"))
  assert.match(paypalApproveRouteSource, /createPayPalDuplicateCheckoutResponse/)
  assert.match(paypalApproveRouteSource, /buildPayPalDuplicateCheckoutBody/)
  assert.doesNotMatch(
    paypalApproveRouteSource,
    /boundIntent\.email \? \{ email: boundIntent\.email \}/,
  )
  assert.ok(stripeRouteSource.includes("...(options.includeEmail === false ? {} : { email })"))
  assert.ok(stripeRouteSource.includes("...(email ? { email } : {})"))
})

test("PayPal duplicate approval response hides lead-derived Chaarlie emails", async () => {
  const body = buildPayPalDuplicateCheckoutBody({
    email: "lead@example.com",
    lead_id: "lead-123",
  })

  assert.deepEqual(body, {
    error: "checkout_access_already_exists",
    message: PAYPAL_DUPLICATE_CHECKOUT_COPY,
  })
})

test("PayPal duplicate approval response can include non-lead account emails", async () => {
  const body = buildPayPalDuplicateCheckoutBody({
    email: "account@example.com",
    lead_id: null,
  })

  assert.deepEqual(body, {
    error: "checkout_access_already_exists",
    email: "account@example.com",
    message: PAYPAL_DUPLICATE_CHECKOUT_COPY,
  })
})

test("PayPal approval retry keeps the Chaarlie account email bound to the intent", () => {
  assert.ok(
    paypalApproveRouteSource.includes("intent.email ?? getPayPalSubscriberEmail(subscription)"),
  )
})

test("Stripe lead-derived duplicate conflicts do not expose hidden lead emails", () => {
  assert.ok(stripeRouteSource.includes("req.json().catch(() => null)"))
  assert.ok(stripeRouteSource.includes("{ includeEmail: false }"))
  assert.ok(stripeRouteSource.includes("options.includeEmail === false ? {} : { email }"))
  assert.ok(stripeRouteSource.includes("let resolvedLeadId: string | null = null"))
  assert.ok(stripeRouteSource.includes("leadId: resolvedLeadId"))
  assert.ok(stripeCheckoutSessionParamsSource.includes("...(leadId ? { lead_id: leadId } : {})"))
})
