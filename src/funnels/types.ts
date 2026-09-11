import type { ComponentType, ReactNode } from "react"

import type { QuizResultNarrative } from "@/lib/quiz/result-narrative"
import type { QuizAnswers } from "@/lib/quiz/types"
import type { FunnelAnalyticsEnvelope, OfferEntryContext } from "@/lib/analytics/events"
import type { GuidedStoryFocusTarget } from "@/lib/quiz/guided-story-flow"
import type { PersonalPlanQuizResumeBootstrap } from "@/lib/personal-plan-quiz/types"

export type FunnelLandingVariantProps = {
  personalPlanQuizResume?: PersonalPlanQuizResumeBootstrap
  personalPlanFieldTest?: boolean
  moderatorQuiz?: { scope: string; email: string } | null
  /**
   * Freemium scanner-first flag, resolved server-side (the flag helper is not
   * Edge/browser-safe). Off by default, so the current funnel is untouched.
   */
  freemiumScannerFirst?: boolean
}

export type FunnelLandingVariantComponent = ComponentType<FunnelLandingVariantProps>

export type FunnelOfferFieldTest =
  | {
      accessDurationHours: number
      activationApiPath?: "/api/quiz/field-test/activate"
      identityMode?: "guest"
    }
  | {
      accessDurationHours: number
      activationApiPath: "/api/personal-plan/field-test/moderator/activate-organic"
      identityMode: "email_bound"
    }

export type FunnelOfferPartnerAccess = {
  activationApiPath: "/api/partner-access/activate"
}

export type FunnelOfferVariantProps = {
  name: string
  narrative: QuizResultNarrative
  quizAnswers: QuizAnswers
  pricingSlot: ReactNode
  entryContext: OfferEntryContext
  focusRoutine?: boolean
  focusTarget?: GuidedStoryFocusTarget
  leadId: string | null
  offerTracking?: FunnelAnalyticsEnvelope | null
  offerVariant: string
  isInternalTest?: boolean
  regularFieldTest?: FunnelOfferFieldTest | null
  partnerAccess?: FunnelOfferPartnerAccess | null
}

export type FunnelOfferVariantComponent = ComponentType<FunnelOfferVariantProps>
