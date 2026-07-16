"use client"

import { Button } from "@/components/ui/button"
import type { BillingInterval } from "@/lib/stripe/intervals"
import {
  DEFAULT_PRICING_INTERVAL,
  STRIPE_PRICING_PLANS,
  getStripePricingPlan,
} from "@/lib/stripe/pricing-plans"

function getPlanDetail(plan: ReturnType<typeof getStripePricingPlan>): string {
  return [plan.perMonth, plan.savings].filter(Boolean).join(" · ")
}

export function SubscriptionPlanSelector({
  actionLabel,
  offerTracking = false,
  onContinue,
  onSelect,
  selectedInterval,
}: {
  actionLabel?: string
  offerTracking?: boolean
  onContinue: () => void
  onSelect: (interval: BillingInterval) => void
  selectedInterval: BillingInterval
}) {
  const selectedPlan = getStripePricingPlan(selectedInterval)

  return (
    <>
      <div className="grid gap-2.5">
        {STRIPE_PRICING_PLANS.map((plan) => {
          const isSelected = plan.interval === selectedInterval
          return (
            <button
              key={plan.interval}
              type="button"
              onClick={() => onSelect(plan.interval)}
              aria-pressed={isSelected}
              className={`relative flex min-h-[78px] items-center gap-3 rounded-[14px] border bg-white px-4 py-3 text-left shadow-[0_1px_2px_rgba(42,24,69,0.03)] transition-colors ${
                isSelected
                  ? "border-[var(--brand-plum)] bg-[var(--brand-plum-ice)]"
                  : "border-border hover:border-[var(--brand-plum-light)]"
              }`}
            >
              {(plan.badge || (isSelected && plan.interval === DEFAULT_PRICING_INTERVAL)) && (
                <span className="absolute right-3 top-0 -translate-y-1/2 rounded-full bg-[var(--brand-plum)] px-2.5 py-1 font-mono text-[8px] font-semibold uppercase tracking-[0.08em] text-white">
                  {plan.badge ?? "Ausgewählt"}
                </span>
              )}
              <span
                className={`grid size-[18px] shrink-0 place-items-center rounded-full border-2 ${
                  isSelected
                    ? "border-[var(--brand-plum)] bg-[var(--brand-plum)]"
                    : "border-border bg-white"
                }`}
              >
                {isSelected ? <span className="size-1.5 rounded-full bg-white" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-bold text-[var(--brand-plum-darkest)]">
                  {plan.name}
                </span>
                <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
                  {[plan.price, getPlanDetail(plan)].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="shrink-0 text-[17px] font-bold leading-none text-[var(--brand-plum-darkest)]">
                {plan.price}
              </span>
            </button>
          )
        })}
      </div>

      <Button
        type="button"
        variant="unstyled"
        onClick={onContinue}
        data-offer-cta={offerTracking ? "pricing_primary" : undefined}
        data-offer-destination={offerTracking ? "checkout" : undefined}
        data-offer-selected-interval={offerTracking ? selectedInterval : undefined}
        data-offer-source-section={offerTracking ? "pricing" : undefined}
        className="mt-4 min-h-[54px] w-full rounded-[12px] bg-[var(--brand-coral)] px-5 py-3 text-[14px] font-bold text-white shadow-[0_8px_24px_-16px_rgba(var(--brand-coral-rgb),0.65)] transition-transform duration-150 hover:-translate-y-0.5"
      >
        {actionLabel ?? selectedPlan.ctaLabel}
      </Button>
      <p className="mt-4 text-center text-[11px] leading-relaxed text-[var(--text-caption)]">
        14 Tage Geld-zurück-Garantie · Details in den Bedingungen
      </p>
    </>
  )
}
