"use client"

import { QuizResultOfferPageShell } from "@/components/quiz/quiz-result-offer-page"
import type { FunnelOfferVariantProps } from "@/funnels/types"

export default function DefaultOfferVariant({
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
  return (
    <QuizResultOfferPageShell
      name={name}
      narrative={narrative}
      quizAnswers={quizAnswers}
      pricingSlot={pricingSlot}
      entryContext={entryContext}
      focusRoutine={focusRoutine}
      leadId={leadId}
      offerTracking={offerTracking}
      offerVariant={offerVariant}
    />
  )
}
