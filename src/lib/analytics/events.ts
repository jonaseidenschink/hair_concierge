import type { BillingInterval } from "@/lib/stripe/intervals"

export type AnalyticsValue = string | number | boolean | null | string[] | number[] | boolean[]
export type AnalyticsPayload = Record<string, AnalyticsValue | undefined>

export type FunnelAnalyticsEnvelope = {
  funnelEventId?: string | null
  funnelSessionId?: string | null
  funnelPackageKey?: string | null
}

export type OfferEntryContext = "quiz_completion" | "saved_result" | "routine_return"
export type CheckoutContext = "membership_reactivation"

export type OfferAnalyticsContext = FunnelAnalyticsEnvelope & {
  conditionerModuleId?: string | null
  entryContext: OfferEntryContext
  focusRoutine: boolean
  leadId?: string | null
  needLane: string
  offerRevision: string
  offerVariant: string
  offerViewId: string
  shampooModuleId?: string | null
  suggestedCategory?: string | null
}

export type OfferSectionId =
  | "personalized_analysis"
  | "mini_routine"
  | "locked_routine"
  | "unlock_explanation"
  | "product_story_chat"
  | "product_story_routine"
  | "product_story_products"
  | "subscription_explanation"
  | "pricing"
  | "guarantee"
  | "faq"
  | "final_cta"

export type OfferCtaId =
  | "sticky_header"
  | "locked_plan"
  | "pricing_primary"
  | "change_plan"
  | "final"

export type CheckoutFailureStage =
  | "configuration"
  | "duplicate_access"
  | "provider_intent"
  | "provider_session"
  | "provider_approval"

export function claimCheckoutFailure(
  seen: Set<string>,
  checkoutAttemptId: string,
  provider: "stripe" | "paypal",
  failureStage: CheckoutFailureStage,
  errorCode: string,
) {
  const key = [checkoutAttemptId, provider, failureStage, errorCode].join(":")
  if (seen.has(key)) return false
  seen.add(key)
  return true
}

export type OfferCommerceProperties = {
  currency: string
  interval: BillingInterval
  planId: string
  value: number
}

export type AppEventMap = {
  chat_product_recommendation_shown: {
    productCount: number
  }
  checkout_start_failed: OfferAnalyticsContext &
    OfferCommerceProperties & {
      checkoutAttemptId: string
      errorCode: string
      failureStage: CheckoutFailureStage
      provider: "stripe" | "paypal"
      retryable: boolean
    }
  checkout_started: FunnelAnalyticsEnvelope &
    Partial<OfferAnalyticsContext> & {
      checkoutAttemptId?: string
      checkoutContext?: CheckoutContext
      currency?: string
      interval?: BillingInterval | null
      leadId?: string | null
      planId?: string
      provider: "stripe" | "paypal"
      source: "pricing_page" | "quiz_result_offer"
      value?: number
    }
  first_chat_message: Record<string, never>
  onboarding_completed: {
    userId: string
  }
  offer_checkout_opened: OfferAnalyticsContext &
    OfferCommerceProperties & {
      availableProviders: string[]
      checkoutAttemptId: string
      openIndex: number
    }
  offer_cta_clicked: OfferAnalyticsContext & {
    ctaId: OfferCtaId
    destination: string
    interactionIndex: number
    selectedInterval?: BillingInterval
    sourceSection: "hero" | OfferSectionId
  }
  offer_faq_opened: OfferAnalyticsContext & {
    faqId: string
    faqIndex: number
  }
  offer_payment_method_selected: OfferAnalyticsContext &
    OfferCommerceProperties & {
      checkoutAttemptId: string
      provider: "stripe" | "paypal"
      selectionIndex: number
    }
  offer_plan_selected: OfferAnalyticsContext &
    OfferCommerceProperties & {
      isDefault: boolean
      previousInterval: BillingInterval
      selectionIndex: number
    }
  offer_section_viewed: OfferAnalyticsContext & {
    sectionId: OfferSectionId
    sectionIndex: number
  }
  offer_viewed: FunnelAnalyticsEnvelope & Partial<OfferAnalyticsContext>
  pricing_viewed: FunnelAnalyticsEnvelope &
    Partial<OfferAnalyticsContext> & {
      availableIntervals?: string[]
      checkoutContext?: CheckoutContext
      leadId?: string | null
      offerRevision?: string
      offerVariant?: string
      offerViewId?: string
      pricingRevision?: string
      selectedInterval?: BillingInterval
      source: "pricing_page" | "quiz_result_offer_pricing"
    }
  purchase_completed: FunnelAnalyticsEnvelope & {
    checkoutSessionId: string
    currency: string
    interval: string
    planId: string
    paymentMethodType?: string
    value: number
  }
  quiz_completed: FunnelAnalyticsEnvelope & {
    hairLength?: string
    hairTexture?: string
    leadId?: string | null
    scalpCondition?: string | null
    scalpType?: string | null
    thickness?: string
  }
  quiz_goals_selected: {
    count: number
  }
  quiz_lead_captured: FunnelAnalyticsEnvelope & {
    leadId: string
    marketingConsent: boolean
  }
  quiz_started: FunnelAnalyticsEnvelope & {
    stepName: string
    stepNumber: number
  }
  quiz_step_viewed: {
    stepName: string
    stepNumber: number
  }
  subscription_started: {
    checkoutSessionId: string
  }
}

export type AppEventName = keyof AppEventMap

export type AppEventPayload<E extends AppEventName = AppEventName> = AppEventMap[E]
