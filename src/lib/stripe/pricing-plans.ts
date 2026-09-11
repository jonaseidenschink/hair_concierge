import type { BillingInterval } from "./intervals"
import type { SubscriptionPricingCatalog } from "@/lib/billing/pricing-catalog"

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

export type { SubscriptionPricingCatalog } from "@/lib/billing/pricing-catalog"

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

export const PERSONAL_PLAN_LAUNCH_PRICING_PLANS: readonly StripePricingPlan[] = [
  {
    analyticsId: "premium_month",
    amount: 9.99,
    currency: "EUR",
    interval: "month",
    name: "Monatlich",
    price: "€9,99",
    perMonth: "/ Monat",
    ctaLabel: "Jetzt starten — €9,99 / Monat",
  },
  {
    analyticsId: "premium_quarter",
    amount: 19.99,
    currency: "EUR",
    interval: "quarter",
    name: "Quartal",
    price: "€19,99",
    perMonth: "~€6,66 / Monat",
    badge: "Beliebteste Wahl",
    savings: "33% sparen",
    ctaLabel: "Jetzt starten — €19,99 im Quartal",
  },
  {
    analyticsId: "premium_year",
    amount: 69.99,
    currency: "EUR",
    interval: "year",
    name: "Jährlich",
    price: "€69,99",
    perMonth: "~€5,83 / Monat",
    savings: "42% sparen",
    ctaLabel: "Jetzt starten — €69,99 / Jahr",
  },
] as const

export const DEFAULT_PRICING_INTERVAL: BillingInterval = "quarter"

/**
 * The secondary line under a plan's name — „~€8,33 / Monat · 44% sparen".
 *
 * Lives here rather than in one selector so every plan-row surface (the offer page's
 * `SubscriptionPlanSelector` and the Premium sheet) reads the same catalog fields in the
 * same order.
 */
export function formatStripePlanDetail(plan: StripePricingPlan): string {
  return [plan.perMonth, plan.savings].filter(Boolean).join(" · ")
}

export function getStripePricingPlans(
  catalog: SubscriptionPricingCatalog = "standard",
): readonly StripePricingPlan[] {
  return catalog === "personal_plan_launch_v1"
    ? PERSONAL_PLAN_LAUNCH_PRICING_PLANS
    : STRIPE_PRICING_PLANS
}

export function getStripePricingPlan(
  interval: BillingInterval,
  catalog: SubscriptionPricingCatalog = "standard",
): StripePricingPlan {
  const plan = getStripePricingPlans(catalog).find((candidate) => candidate.interval === interval)
  if (!plan) {
    throw new Error(`Unknown pricing interval: ${interval}`)
  }
  return plan
}
