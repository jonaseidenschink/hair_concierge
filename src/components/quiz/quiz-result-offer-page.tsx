import type { ReactNode } from "react"
import { Check, LockKeyhole, MessageCircle, ShieldCheck } from "lucide-react"

import { OfferFaq } from "@/components/quiz/offer-faq"
import { OfferPreviewRoutine } from "@/components/quiz/offer-preview-routine"
import { OfferProductStory } from "@/components/quiz/offer-product-story"
import { OfferTimeline } from "@/components/quiz/offer-timeline"
import { OfferTrackingProvider } from "@/components/quiz/offer-tracking-provider"
import { ResultOfferPricing } from "@/components/quiz/result-offer-pricing"
import type { FunnelAnalyticsEnvelope, OfferEntryContext } from "@/lib/analytics/events"
import { buildQuizOfferPreview } from "@/lib/quiz/offer-preview"
import type { QuizResultNarrative } from "@/lib/quiz/result-narrative"
import type { QuizAnswers } from "@/lib/quiz/types"
import { STRIPE_PRICING_PLANS } from "@/lib/stripe/pricing-plans"

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? ""
}

function GuaranteeBadge() {
  return (
    <svg
      aria-label="14 Tage Geld-zurück-Garantie"
      className="mx-auto mb-4 size-[108px] text-[var(--brand-coral)]"
      viewBox="0 0 108 108"
      role="img"
    >
      <circle
        cx="54"
        cy="54"
        r="49"
        fill="none"
        stroke="currentColor"
        strokeDasharray="4 6"
        strokeWidth="1.5"
      />
      <circle cx="54" cy="54" r="42" fill="rgba(var(--brand-coral-rgb),0.08)" />
      <text
        x="54"
        y="31"
        textAnchor="middle"
        className="fill-[var(--brand-coral)] font-mono text-[8px] font-semibold uppercase tracking-[0.12em]"
      >
        Geld zurück
      </text>
      <text
        x="54"
        y="63"
        textAnchor="middle"
        className="fill-[var(--brand-plum-darkest)] font-header text-[32px] font-medium"
      >
        14
      </text>
      <text
        x="54"
        y="83"
        textAnchor="middle"
        className="fill-[var(--brand-plum)] font-mono text-[8px] font-semibold uppercase tracking-[0.12em]"
      >
        Tage Garantie
      </text>
    </svg>
  )
}

function StaticPricingPreview() {
  const selectedPlan = STRIPE_PRICING_PLANS.find((plan) => plan.interval === "quarter")

  return (
    <div className="space-y-4">
      <div className="grid gap-2.5">
        {STRIPE_PRICING_PLANS.map((plan) => (
          <div
            key={plan.interval}
            className="relative flex min-h-[74px] items-center gap-3 rounded-[14px] border border-border bg-white px-4 py-3"
          >
            {plan.badge ? (
              <span className="absolute right-3 top-0 -translate-y-1/2 rounded-full bg-[var(--brand-plum)] px-2.5 py-1 font-mono text-[8px] font-semibold uppercase tracking-[0.08em] text-white">
                {plan.badge}
              </span>
            ) : null}
            <span className="size-[18px] rounded-full border-2 border-border" />
            <span className="flex-1">
              <span className="block text-[15px] font-bold text-[var(--brand-plum-darkest)]">
                {plan.name}
              </span>
              <span className="block text-[11px] text-muted-foreground">
                {plan.perMonth}
                {plan.savings ? ` · ${plan.savings}` : ""}
              </span>
            </span>
            <span className="text-[17px] font-bold leading-none text-[var(--brand-plum-darkest)]">
              {plan.price}
            </span>
          </div>
        ))}
      </div>
      {selectedPlan ? (
        <div className="flex min-h-[54px] w-full items-center justify-center rounded-[12px] bg-[var(--brand-coral)] px-5 py-3 text-[14px] font-bold text-white">
          {selectedPlan.ctaLabel}
        </div>
      ) : null}
    </div>
  )
}

export function QuizResultOfferPageShell({
  name,
  narrative,
  quizAnswers,
  pricingSlot,
  entryContext = "saved_result",
  focusRoutine = false,
  leadId = null,
  offerTracking,
  offerVariant = "default",
}: {
  name: string
  narrative: QuizResultNarrative
  quizAnswers: QuizAnswers
  pricingSlot?: ReactNode
  entryContext?: OfferEntryContext
  focusRoutine?: boolean
  leadId?: string | null
  offerTracking?: FunnelAnalyticsEnvelope | null
  offerVariant?: string
}) {
  const displayName = firstName(name)
  const preview = buildQuizOfferPreview(quizAnswers)

  return (
    <OfferTrackingProvider
      key={`${offerTracking?.funnelEventId ?? leadId ?? "anonymous"}:${entryContext}:${offerVariant}:${focusRoutine}`}
      entryContext={entryContext}
      focusRoutine={focusRoutine}
      leadId={leadId}
      offerTracking={offerTracking}
      offerVariant={offerVariant}
      preview={preview}
    >
      <div className="min-h-screen bg-background text-foreground">
        <div className="fixed inset-x-0 top-0 z-40 border-b border-border bg-background/95 backdrop-blur-md">
          <div className="mx-auto flex max-w-[560px] items-center justify-between gap-3 px-5 py-2.5">
            <div>
              <strong className="font-header text-[18px] font-medium text-[var(--brand-plum-darkest)]">
                chaarlie
              </strong>
              <span className="block font-mono text-[8px] font-semibold uppercase tracking-[0.09em] text-[var(--brand-plum)]">
                Dein Ergebnis ist da
              </span>
            </div>
            <a
              href="#pricing"
              data-offer-cta="sticky_header"
              data-offer-destination="pricing"
              data-offer-source-section="hero"
              className="rounded-[12px] bg-[var(--brand-coral)] px-4 py-2.5 text-[13px] font-bold text-white shadow-[0_8px_24px_-16px_rgba(var(--brand-coral-rgb),0.65)]"
            >
              Chaarlie starten
            </a>
          </div>
        </div>

        <main className="mx-auto w-full max-w-[560px] px-5">
          <section className="pb-9 pt-[84px]">
            <span className="inline-flex items-center gap-2 rounded-full border border-[#2D9F5E]/25 bg-[#2D9F5E]/10 px-3.5 py-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.11em] text-[#2D9F5E]">
              <Check className="size-3.5" aria-hidden="true" />
              Quiz ausgewertet
            </span>
            <p className="mb-2 mt-5 font-mono text-[10px] font-semibold uppercase tracking-[0.13em] text-[var(--brand-plum)]">
              {displayName
                ? `${displayName}, wir kennen jetzt die Bedürfnisse deiner Haare`
                : "Wir kennen jetzt die Bedürfnisse deiner Haare"}
            </p>
            <h1 className="font-header text-[clamp(32px,9vw,46px)] font-medium leading-[1.08] text-[var(--brand-plum-darkest)]">
              Deine Analyse ist der Anfang. Chaarlie macht sie anwendbar.
            </h1>
            <p className="mt-5 text-[16px] leading-[1.65] text-muted-foreground">
              {narrative.intro} Jetzt wird daraus eine persönliche Routine mit konkreten Produkten –
              plus ein Begleiter für alle Fragen danach.
            </p>
          </section>

          <OfferPreviewRoutine preview={preview} />

          <section
            id="unlock-plan"
            data-offer-section="unlock_explanation"
            className="scroll-mt-[76px] border-t border-border py-9"
          >
            <article className="relative min-h-[300px] overflow-hidden rounded-[20px] border border-[var(--brand-plum-light)] bg-white shadow-[0_14px_45px_-36px_rgba(var(--brand-plum-rgb),0.7)]">
              <div aria-hidden="true" className="space-y-3 p-7 blur-[6px]">
                {["w-5/6", "w-2/3", "w-full", "w-3/4", "w-1/2"].map((width) => (
                  <div
                    key={width}
                    className={`h-4 ${width} rounded-full bg-[var(--brand-plum-ice)]`}
                  />
                ))}
              </div>
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/72 p-7 text-center backdrop-blur-[1px]">
                <LockKeyhole className="mb-3 size-9 text-[var(--brand-plum)]" aria-hidden="true" />
                <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.11em] text-[var(--brand-plum)]">
                  Nach dem Start
                </p>
                <h2 className="mt-2 font-header text-[27px] font-medium leading-[1.15] text-[var(--brand-plum-darkest)]">
                  {focusRoutine
                    ? "Weiter mit deiner vollständigen Routine."
                    : "Chaarlie finalisiert deinen persönlichen Plan."}
                </h2>
                <p className="mt-3 max-w-[380px] text-[13px] leading-relaxed text-muted-foreground">
                  Du ergänzt deine aktuellen Produkte. Chaarlie prüft, was bleiben kann, schließt
                  Lücken und erklärt Reihenfolge, Menge und Anwendung.
                </p>
                <a
                  href="#pricing"
                  data-offer-cta="locked_plan"
                  data-offer-destination="pricing"
                  data-offer-source-section="unlock_explanation"
                  className="mt-5 rounded-[12px] bg-[var(--brand-coral)] px-8 py-3 text-[13px] font-bold text-white"
                >
                  Vollständige Routine freischalten
                </a>
              </div>
            </article>
          </section>

          <OfferProductStory />
          <OfferTimeline />

          <section
            id="pricing"
            data-offer-section="pricing"
            className="scroll-mt-[76px] border-t border-border py-9"
          >
            {focusRoutine ? (
              <p className="mb-4 rounded-[12px] bg-[var(--brand-plum-ice)] px-3 py-2 text-center text-[12px] font-bold text-[var(--brand-plum)]">
                Weiter mit deiner Routine
              </p>
            ) : null}
            <p className="text-center font-mono text-[10px] font-semibold uppercase tracking-[0.13em] text-[var(--brand-plum)]">
              Dein persönlicher Haarpflege-Begleiter
            </p>
            <h2 className="mt-2 text-center font-header text-[36px] font-medium leading-[1.12] text-[var(--brand-plum-darkest)]">
              Starte mit Chaarlie.
            </h2>
            <p className="mx-auto mt-3 max-w-[40ch] text-center text-[14px] leading-[1.6] text-muted-foreground">
              Routine, konkrete Produkthilfe und persönliche Fragen sind in jeder Laufzeit
              enthalten.
            </p>
            <div className="mt-6">{pricingSlot ?? <StaticPricingPreview />}</div>
            <article
              data-offer-section="guarantee"
              className="mt-7 rounded-[16px] border border-border bg-white p-6 text-center"
            >
              <ShieldCheck
                aria-hidden="true"
                className="mx-auto size-8 text-[var(--brand-coral)]"
              />
              <GuaranteeBadge />
              <h3 className="font-header text-[22px] font-medium text-[var(--brand-plum-darkest)]">
                14 Tage Geld-zurück-Garantie
              </h3>
              <p className="mt-2 text-[13px] leading-[1.6] text-muted-foreground">
                Sollte Chaarlie nicht zu dir passen, bekommst du innerhalb von 14 Tagen nach dem
                Kauf dein Geld zurück.
              </p>
            </article>
          </section>

          <OfferFaq />

          <section
            data-offer-section="final_cta"
            className="border-t border-border pb-20 pt-9 text-center"
          >
            <MessageCircle
              className="mx-auto mb-3 size-8 text-[var(--brand-plum)]"
              aria-hidden="true"
            />
            <h2 className="font-header text-[30px] font-medium leading-[1.15] text-[var(--brand-plum-darkest)]">
              Aus deiner Analyse wird ein Plan, den du wirklich nutzen kannst.
            </h2>
            <p className="mx-auto mt-3 max-w-[38ch] text-[14px] leading-[1.6] text-muted-foreground">
              Starte deine Routine und behalte Chaarlie als geduldigen Begleiter für Produkte,
              Anwendung und alle Fragen danach.
            </p>
            <a
              href="#pricing"
              data-offer-cta="final"
              data-offer-destination="pricing"
              data-offer-source-section="final_cta"
              className="mt-5 flex min-h-[54px] w-full items-center justify-center rounded-[12px] bg-[var(--brand-coral)] px-5 py-3 text-[14px] font-bold text-white shadow-[0_8px_24px_-16px_rgba(var(--brand-coral-rgb),0.65)]"
            >
              Chaarlie starten
            </a>
          </section>
        </main>
      </div>
    </OfferTrackingProvider>
  )
}

export function QuizResultOfferPage({
  name,
  narrative,
  quizAnswers,
  leadId,
  onCheckoutOpen,
  focusRoutine = false,
  offerTracking,
}: {
  name: string
  narrative: QuizResultNarrative
  quizAnswers: QuizAnswers
  leadId: string | null
  onCheckoutOpen?: () => void
  focusRoutine?: boolean
  offerTracking?: FunnelAnalyticsEnvelope | null
}) {
  return (
    <QuizResultOfferPageShell
      name={name}
      narrative={narrative}
      quizAnswers={quizAnswers}
      entryContext="quiz_completion"
      focusRoutine={focusRoutine}
      leadId={leadId}
      offerTracking={offerTracking}
      offerVariant="default"
      pricingSlot={
        <ResultOfferPricing
          leadId={leadId}
          offerTracking={offerTracking}
          onCheckoutOpen={onCheckoutOpen}
        />
      }
    />
  )
}
