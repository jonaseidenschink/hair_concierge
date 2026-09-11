"use client"

import { Button } from "@/components/ui/button"
import {
  formatQuizResultReferencePrice,
  type QuizResultReferencePrices,
} from "@/components/checkout/plan-reference-prices"
import type { BillingInterval } from "@/lib/stripe/intervals"
import {
  DEFAULT_PRICING_INTERVAL,
  formatStripePlanDetail,
  getStripePricingPlan,
  getStripePricingPlans,
  type SubscriptionPricingCatalog,
} from "@/lib/stripe/pricing-plans"

export function SubscriptionPlanSelector({
  actionLabel,
  busy = false,
  busyLabel,
  offerTracking = false,
  onContinue,
  onSelect,
  referencePrices,
  pricingCatalog = "standard",
  selectedInterval,
}: {
  actionLabel?: string
  busy?: boolean
  busyLabel?: string
  offerTracking?: boolean
  onContinue: () => void
  onSelect: (interval: BillingInterval) => void
  referencePrices?: QuizResultReferencePrices
  pricingCatalog?: SubscriptionPricingCatalog
  selectedInterval: BillingInterval
}) {
  const plans = getStripePricingPlans(pricingCatalog)
  const selectedPlan = getStripePricingPlan(selectedInterval, pricingCatalog)
  const selectedActionLabel = actionLabel ?? selectedPlan.ctaLabel

  return (
    <>
      {referencePrices ? (
        <p className="mb-3 flex min-h-10 w-full items-center justify-center rounded-full border border-[var(--brand-plum-light)] bg-[var(--brand-plum-ice)] px-3 py-2 text-center font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--brand-plum-darkest)]">
          {pricingCatalog === "personal_plan_launch_v1" ? (
            <>
              <span aria-hidden="true">Launch-Rabatt sichern</span>
              <span className="sr-only">Launch-Rabatt mit regulärem Vergleichspreis sichern</span>
            </>
          ) : (
            <>
              <span aria-hidden="true">JETZT MIND. 20 % RABATT SICHERN</span>
              <span className="sr-only">Jetzt mindestens 20 Prozent Rabatt sichern</span>
            </>
          )}
        </p>
      ) : null}
      <div className="grid gap-2.5">
        {plans.map((plan) => {
          const isSelected = plan.interval === selectedInterval
          return (
            <button
              key={plan.interval}
              type="button"
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={() => onSelect(plan.interval)}
              aria-pressed={isSelected}
              data-offer-plan-card={plan.interval}
              data-offer-plan-selected={isSelected ? "true" : "false"}
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
                data-offer-plan-radio={plan.interval}
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
                  {[plan.price, formatStripePlanDetail(plan)].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                {referencePrices ? (
                  <span className="text-[14px] font-medium leading-none text-muted-foreground">
                    <span className="sr-only">
                      {pricingCatalog === "personal_plan_launch_v1"
                        ? "Regulärer Preis "
                        : "Vergleichspreis "}
                    </span>
                    <s>{formatQuizResultReferencePrice(referencePrices[plan.interval])}</s>
                  </span>
                ) : null}
                <span className="text-[17px] font-bold leading-none text-[var(--brand-plum-darkest)]">
                  <span
                    data-offer-plan-price={plan.interval}
                    data-offer-plan-price-selected={isSelected ? "true" : "false"}
                  >
                    {plan.price}
                  </span>
                </span>
              </span>
            </button>
          )
        })}
      </div>
      <Button
        type="button"
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        variant="unstyled"
        onClick={() => {
          if (!busy) onContinue()
        }}
        data-offer-cta={offerTracking ? "pricing_primary" : undefined}
        data-offer-destination={offerTracking ? "checkout" : undefined}
        data-offer-selected-interval={offerTracking ? selectedInterval : undefined}
        data-offer-selected-price={selectedPlan.price}
        data-offer-source-section={offerTracking ? "pricing" : undefined}
        data-offer-cta-label={selectedActionLabel}
        className="mt-4 min-h-[54px] w-full rounded-[12px] bg-[var(--brand-coral)] px-5 py-3 text-[14px] font-bold text-white shadow-[0_8px_24px_-16px_rgba(var(--brand-coral-rgb),0.65)] transition-transform duration-150 hover:-translate-y-0.5 aria-disabled:cursor-wait aria-disabled:opacity-80"
      >
        <span
          key={busy ? "busy" : selectedInterval}
          className="personal-plan-pricing-cta-content block"
          data-offer-plan-cta-content=""
        >
          {busy ? (
            <span className="inline-flex items-center justify-center gap-2">
              <span
                aria-hidden="true"
                className="size-4 animate-spin rounded-full border-2 border-white/35 border-t-white motion-reduce:animate-none"
              />
              <span>{busyLabel ?? selectedActionLabel}</span>
            </span>
          ) : (
            selectedActionLabel
          )}
        </span>
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {busy ? (busyLabel ?? "Zahlungsoptionen werden vorbereitet …") : ""}
      </span>
      <div className="mt-4 space-y-2 text-center text-[11px] leading-relaxed text-[var(--text-caption)]">
        <p>14 Tage Geld-zurück-Garantie · Jederzeit kündbar</p>
        <p>PayPal · Apple Pay (auf unterstützten Geräten) · Visa · Mastercard</p>
        <p>
          Zahlungsdaten verarbeitet dein gewählter Anbieter.{" "}
          <a className="underline underline-offset-2" href="/datenschutz">
            Mehr zum Datenschutz.
          </a>
        </p>
      </div>
    </>
  )
}
