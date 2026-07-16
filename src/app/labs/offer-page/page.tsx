import { notFound } from "next/navigation"

import { QuizResultOfferPage } from "@/components/quiz/quiz-result-offer-page"
import AppValueStackOfferVariant from "@/funnels/offers/app-value-stack"
import SocialProofBelowOfferVariant from "@/funnels/offers/social-proof-below"
import { APP_VALUE_STACK_CTA_LABEL } from "@/lib/quiz/app-value-stack-copy"
import { buildQuizResultNarrative } from "@/lib/quiz/result-narrative"
import type { QuizAnswers } from "@/lib/quiz/types"

const REVIEW_ANSWERS: QuizAnswers = {
  structure: "wavy",
  thickness: "normal",
  density: "medium",
  hair_length: "long",
  fingertest: "rau",
  pulltest: "stretches_bounces",
  scalp_type: "ausgeglichen",
  has_scalp_issue: false,
  concerns: ["frizz", "dryness"],
  treatment: ["natur"],
  goals: ["less_frizz", "moisture", "shine"],
}

function StaticPricingPreview() {
  return (
    <div className="space-y-3">
      {["Monatlich · 14,99 €", "Quartal · 34,99 €", "Jährlich · 99,99 €"].map((label, index) => (
        <div
          className={`rounded-[14px] border px-4 py-4 text-[14px] font-semibold ${
            index === 1
              ? "border-[var(--brand-plum)] bg-[var(--brand-plum-ice)]"
              : "border-border bg-white"
          }`}
          key={label}
        >
          {label}
        </div>
      ))}
      <div className="rounded-[12px] bg-[var(--brand-coral)] px-5 py-4 text-center text-[14px] font-bold text-white">
        {APP_VALUE_STACK_CTA_LABEL}
      </div>
      <p className="text-center text-[11px] text-muted-foreground">
        14 Tage Geld-zurück-Garantie · Details in den Bedingungen
      </p>
    </div>
  )
}

export default async function OfferPageLab({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string }>
}) {
  if (process.env.NODE_ENV !== "development") notFound()

  const variant = (await searchParams).variant ?? "app-value-stack"
  const narrative = buildQuizResultNarrative(REVIEW_ANSWERS)

  if (variant === "default") {
    return (
      <QuizResultOfferPage
        leadId={null}
        name="Lea"
        narrative={narrative}
        quizAnswers={REVIEW_ANSWERS}
      />
    )
  }

  if (variant === "social-proof-below") {
    return (
      <SocialProofBelowOfferVariant
        entryContext="quiz_completion"
        leadId={null}
        name="Lea"
        narrative={narrative}
        offerVariant="social-proof-below"
        pricingSlot={<StaticPricingPreview />}
        quizAnswers={REVIEW_ANSWERS}
      />
    )
  }

  if (variant !== "app-value-stack") notFound()

  return (
    <AppValueStackOfferVariant
      entryContext="quiz_completion"
      leadId={null}
      name="Lea"
      narrative={narrative}
      offerVariant="app-value-stack"
      quizAnswers={REVIEW_ANSWERS}
      pricingSlot={<StaticPricingPreview />}
    />
  )
}
