import {
  STANDARD_PRICING_CATALOG,
  type SubscriptionPricingCatalog,
} from "@/lib/billing/pricing-catalog"
import type { BillingInterval } from "@/lib/stripe/intervals"
import { formatStripePlanDetail, getStripePricingPlan } from "@/lib/stripe/pricing-plans"

/**
 * The Premium sheet's plan rows (T13, freemium-scanner-first PR4).
 *
 * **Standard catalog, always.** `resolveSubscriptionPricingCatalog()` swaps the offer
 * page onto the launch catalog whenever `PERSONAL_PLAN_LAUNCH_PRICING_ENABLED` is on;
 * the sheet must never follow it (plan §11 F06: the two catalogs can diverge, and the
 * freemium sheet sells the standard subscription). Everything the sheet shows or submits
 * therefore resolves through this module — never through the flag-aware resolver.
 */
export const PREMIUM_SHEET_PRICING_CATALOG: SubscriptionPricingCatalog = STANDARD_PRICING_CATALOG

/** Journey step 8: Jährlich (empfohlen) leads, then Vierteljährlich, then Monatlich. */
export const PREMIUM_SHEET_PLAN_ORDER: readonly BillingInterval[] = ["year", "quarter", "month"]

/** Jährlich is preselected AND carries the „empfohlen" marker. */
export const PREMIUM_SHEET_DEFAULT_INTERVAL: BillingInterval = "year"
export const PREMIUM_SHEET_RECOMMENDED_INTERVAL: BillingInterval = "year"
export const PREMIUM_SHEET_RECOMMENDED_BADGE = "empfohlen"

/**
 * Row labels per the signed-off journey. „Jährlich"/„Monatlich" match the catalog's own
 * names; „Vierteljährlich" is the sheet's spelling of the catalog's „Quartal" — the offer
 * page keeps its label, so neither surface is rewritten to match the other.
 */
const PREMIUM_SHEET_PLAN_NAMES: Record<BillingInterval, string> = {
  year: "Jährlich",
  quarter: "Vierteljährlich",
  month: "Monatlich",
}

export interface PremiumSheetPlanRow {
  interval: BillingInterval
  /** Catalog plan id handed to checkout analytics, e.g. "premium_year". */
  analyticsId: string
  amount: number
  currency: "EUR"
  name: string
  /** „99,99 €" — German order, same normalization the offer overlay applies. */
  price: string
  /** „~€8,33 / Monat · 44% sparen", or empty when the row would only restate itself. */
  detail: string
  ctaLabel: string
  recommended: boolean
}

export function premiumSheetPlan(interval: BillingInterval): PremiumSheetPlanRow {
  const plan = getStripePricingPlan(interval, PREMIUM_SHEET_PRICING_CATALOG)
  return {
    interval,
    analyticsId: plan.analyticsId,
    amount: plan.amount,
    currency: plan.currency,
    name: PREMIUM_SHEET_PLAN_NAMES[interval],
    price: `${plan.price.replace(/^€/, "")} €`,
    // Monatlich's catalog detail is „/ Monat" — the row's own name already says that, so
    // the sheet only carries a second line where it earns one (the savings comparison).
    detail: plan.savings ? formatStripePlanDetail(plan) : "",
    ctaLabel: plan.ctaLabel,
    recommended: interval === PREMIUM_SHEET_RECOMMENDED_INTERVAL,
  }
}

export function premiumSheetPlans(): PremiumSheetPlanRow[] {
  return PREMIUM_SHEET_PLAN_ORDER.map(premiumSheetPlan)
}
