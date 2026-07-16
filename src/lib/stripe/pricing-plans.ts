import type { BillingInterval } from "./intervals"

export interface StripePricingPlan {
  analyticsId: string
  amount: number
  currency: "EUR"
  interval: BillingInterval
  name: string
  price: string
  perMonth: string
  badge?: string
  savings?: string
  ctaLabel: string
}

export const STRIPE_PRICING_PLANS: readonly StripePricingPlan[] = [
  {
    analyticsId: "premium_month",
    amount: 14.99,
    currency: "EUR",
    interval: "month",
    name: "Monatlich",
    price: "€14,99",
    perMonth: "/ Monat",
    ctaLabel: "Jetzt starten — €14,99 / Monat",
  },
  {
    analyticsId: "premium_quarter",
    amount: 34.99,
    currency: "EUR",
    interval: "quarter",
    name: "Quartal",
    price: "€34,99",
    perMonth: "~€11,66 / Monat",
    badge: "Beliebteste Wahl",
    savings: "22% sparen",
    ctaLabel: "Jetzt starten — €34,99 im Quartal",
  },
  {
    analyticsId: "premium_year",
    amount: 99.99,
    currency: "EUR",
    interval: "year",
    name: "Jährlich",
    price: "€99,99",
    perMonth: "~€8,33 / Monat",
    savings: "44% sparen",
    ctaLabel: "Jetzt starten — €99,99 / Jahr",
  },
] as const

export const DEFAULT_PRICING_INTERVAL: BillingInterval = "quarter"

export function getStripePricingPlan(interval: BillingInterval): StripePricingPlan {
  const plan = STRIPE_PRICING_PLANS.find((candidate) => candidate.interval === interval)
  if (!plan) {
    throw new Error(`Unknown pricing interval: ${interval}`)
  }
  return plan
}
