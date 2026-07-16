"use client"

import { Check, LockKeyhole } from "lucide-react"

import { AppValueStackProof } from "@/components/quiz/app-value-stack-proof"
import { AppValueStackRoutine } from "@/components/quiz/app-value-stack-routine"
import { OfferFaq } from "@/components/quiz/offer-faq"
import { OfferTrackingProvider } from "@/components/quiz/offer-tracking-provider"
import type { FunnelOfferVariantProps } from "@/funnels/types"
import {
  APP_VALUE_STACK_CTA_LABEL,
  buildAppValueStackHeroCopy,
} from "@/lib/quiz/app-value-stack-copy"
import { buildQuizOfferPreview } from "@/lib/quiz/offer-preview"

const UNLOCK_BENEFITS = [
  "Deine komplette Routine – mit Reihenfolge und Anwendung",
  "Chaarlie beantwortet deine Fragen jederzeit",
  "Alternativen und Anpassungen, wenn etwas nicht passt",
] as const

export default function AppValueStackOfferVariant({
  name,
  narrative,
  quizAnswers,
  pricingSlot,
  entryContext,
  focusRoutine = false,
  leadId,
  offerTracking,
  offerVariant,
}: FunnelOfferVariantProps) {
  const preview = buildQuizOfferPreview(quizAnswers)
  const hero = buildAppValueStackHeroCopy({ name, narrative, lane: preview.lane })

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
            <strong className="font-header text-[20px] font-medium text-[var(--brand-plum-darkest)]">
              chaarlie
            </strong>
            <a
              data-offer-cta="sticky_header"
              data-offer-destination="pricing"
              data-offer-source-section="hero"
              className="rounded-[12px] bg-[var(--brand-coral)] px-4 py-2.5 text-[13px] font-bold text-white shadow-[0_8px_24px_-16px_rgba(var(--brand-coral-rgb),0.65)]"
              href="#pricing"
            >
              {APP_VALUE_STACK_CTA_LABEL}
            </a>
          </div>
        </div>

        <main className="mx-auto w-full max-w-[560px] px-5">
          <section className="pb-9 pt-[84px]">
            <span className="inline-flex items-center gap-2 rounded-full border border-[#2D9F5E]/25 bg-[#2D9F5E]/10 px-3.5 py-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.11em] text-[#2D9F5E]">
              <Check aria-hidden="true" className="size-3.5" />
              Quiz ausgewertet
            </span>
            <h1 className="mt-5 font-header text-[clamp(32px,9vw,46px)] font-medium leading-[1.08] text-[var(--brand-plum-darkest)]">
              {hero.headline}
            </h1>
            <p className="mt-4 text-[16px] leading-[1.65] text-muted-foreground">{hero.intro}</p>
          </section>

          <AppValueStackRoutine preview={preview} />

          <section
            id="unlock-plan"
            data-offer-section="unlock_explanation"
            className="scroll-mt-[76px] border-t border-border py-9"
          >
            {focusRoutine ? (
              <p className="mb-4 font-mono text-[9px] font-semibold uppercase tracking-[0.11em] text-[var(--brand-plum)]">
                Weiter mit deiner Routine
              </p>
            ) : null}
            <article className="rounded-[20px] border border-[var(--brand-plum-light)] bg-[var(--brand-plum-ice)]/65 p-6 text-center">
              <span className="mx-auto grid size-10 place-items-center rounded-full bg-white text-[var(--brand-plum)]">
                <LockKeyhole aria-hidden="true" className="size-[18px]" />
              </span>
              <p className="mt-4 font-mono text-[9px] font-semibold uppercase tracking-[0.11em] text-[var(--brand-plum)]">
                Nach dem Freischalten
              </p>
              <h2 className="mt-2 font-header text-[28px] font-medium leading-[1.15] text-[var(--brand-plum-darkest)]">
                Deine Routine ist erst der Anfang.
              </h2>
              <p className="mx-auto mt-3 max-w-[40ch] text-[14px] leading-[1.6] text-muted-foreground">
                Chaarlie begleitet dich bei der Anwendung und passt deine Pflege mit dir an.
              </p>
              <a
                data-offer-cta="locked_plan"
                data-offer-destination="pricing"
                data-offer-source-section="unlock_explanation"
                className="mt-5 inline-flex min-h-[48px] items-center justify-center rounded-[12px] bg-[var(--brand-coral)] px-7 py-3 text-[13px] font-bold text-white"
                href="#pricing"
              >
                {APP_VALUE_STACK_CTA_LABEL}
              </a>
            </article>
          </section>

          <AppValueStackProof />

          <section
            id="pricing"
            data-offer-section="pricing"
            className="scroll-mt-[76px] border-t border-border py-10"
          >
            {focusRoutine ? (
              <p className="mb-4 rounded-[12px] bg-[var(--brand-plum-ice)] px-3 py-2 text-center text-[12px] font-bold text-[var(--brand-plum)]">
                Weiter mit deiner Routine
              </p>
            ) : null}
            <h2 className="text-center font-header text-[34px] font-medium leading-[1.12] text-[var(--brand-plum-darkest)]">
              Aus deiner Pflegebasis wird eine Routine, die im Alltag funktioniert.
            </h2>
            <ul className="mx-auto mt-6 max-w-[460px] space-y-3">
              {UNLOCK_BENEFITS.map((benefit) => (
                <li
                  key={benefit}
                  className="flex gap-3 text-[13.5px] leading-[1.5] text-[var(--brand-plum-darkest)]"
                >
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-[#2D9F5E]/10 text-[#2D9F5E]">
                    <Check aria-hidden="true" className="size-3" />
                  </span>
                  {benefit}
                </li>
              ))}
            </ul>
            <p className="mt-5 rounded-[14px] bg-[var(--brand-plum-ice)] px-4 py-3 text-center text-[12.5px] leading-[1.55] text-[var(--brand-plum-darkest)]">
              Zum Vergleich: Ein Fehlkauf kostet oft mehr als ein Monat Chaarlie.
            </p>
            <div className="mt-6">{pricingSlot}</div>
          </section>

          <OfferFaq />

          <section
            data-offer-section="final_cta"
            className="border-t border-border pb-20 pt-9 text-center"
          >
            <a
              data-offer-cta="final"
              data-offer-destination="pricing"
              data-offer-source-section="final_cta"
              className="flex min-h-[54px] w-full items-center justify-center rounded-[12px] bg-[var(--brand-coral)] px-5 py-3 text-[14px] font-bold text-white shadow-[0_8px_24px_-16px_rgba(var(--brand-coral-rgb),0.65)]"
              href="#pricing"
            >
              {APP_VALUE_STACK_CTA_LABEL}
            </a>
            <p className="mt-3 text-[11px] text-muted-foreground">
              14 Tage Geld-zurück · zum Laufzeitende kündbar
            </p>
          </section>
        </main>
      </div>
    </OfferTrackingProvider>
  )
}
