import type { ComponentType, ReactNode } from "react"

import type { QuizResultNarrative } from "@/lib/quiz/result-narrative"
import type { QuizAnswers } from "@/lib/quiz/types"
import type { FunnelAnalyticsEnvelope, OfferEntryContext } from "@/lib/analytics/events"

export type FunnelLandingVariantComponent = ComponentType

export type FunnelOfferVariantProps = {
  name: string
  narrative: QuizResultNarrative
  quizAnswers: QuizAnswers
  pricingSlot: ReactNode
  entryContext: OfferEntryContext
  focusRoutine?: boolean
  leadId: string | null
  offerTracking?: FunnelAnalyticsEnvelope | null
  offerVariant: string
}

export type FunnelOfferVariantComponent = ComponentType<FunnelOfferVariantProps>
