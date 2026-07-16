"use client"

import { useEffect } from "react"

import { ResultOfferPricing } from "@/components/quiz/result-offer-pricing"
import { QuizResultsView } from "@/components/quiz/quiz-results-view"
import { renderOfferVariant } from "@/funnels/offers/registry"
import { getQuizResultCta } from "@/lib/quiz/result-cta"
import { buildQuizResultNarrative } from "@/lib/quiz/result-narrative"
import type { QuizAnswers } from "@/lib/quiz/types"
import type { FunnelAnalyticsEnvelope, OfferEntryContext } from "@/lib/analytics/events"

type ResultPageFocusTarget = "unlock-plan" | "pricing" | null

export function ResultPageClient({
  leadId,
  name,
  quizAnswers,
  entryContext,
  focusRoutine,
  focusTarget = null,
  hasAccess,
  offerTracking = null,
  offerVariant = "default",
}: {
  leadId: string
  name: string
  quizAnswers: QuizAnswers
  entryContext?: OfferEntryContext
  focusRoutine: boolean
  focusTarget?: ResultPageFocusTarget
  hasAccess: boolean
  offerTracking?: FunnelAnalyticsEnvelope | null
  offerVariant?: string
}) {
  const narrative = buildQuizResultNarrative(quizAnswers)
  const cta = getQuizResultCta({ canGoStraightToRoutine: hasAccess })
  const resolvedEntryContext = entryContext ?? (focusRoutine ? "routine_return" : "saved_result")

  useEffect(() => {
    if (!focusTarget) return

    window.requestAnimationFrame(() => {
      document.getElementById(focusTarget)?.scrollIntoView({ behavior: "smooth", block: "start" })
    })
  }, [focusTarget])

  if (hasAccess) {
    return (
      <QuizResultsView
        name={name}
        narrative={{ ...narrative, cta }}
        primaryAction={{
          label: cta.label,
          href: `/onboarding?lead=${encodeURIComponent(leadId)}`,
        }}
        secondaryAction={null}
      />
    )
  }

  const offer = renderOfferVariant(offerVariant, {
    entryContext: resolvedEntryContext,
    leadId,
    name,
    narrative,
    offerTracking,
    offerVariant,
    quizAnswers,
    focusRoutine,
    pricingSlot: <ResultOfferPricing leadId={leadId} offerTracking={offerTracking} />,
  })
  if (!offer) throw new Error(`Unknown funnel offer variant: ${offerVariant}`)
  return offer
}
