import { posthog } from "@/lib/analytics/runtime/posthog"
import type {
  AnalyticsPayload,
  AppEventMap,
  AppEventName,
  FunnelAnalyticsEnvelope,
  OfferAnalyticsContext,
  OfferCommerceProperties,
} from "../events"

function cleanAnalyticsPayload(payload: AnalyticsPayload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  ) as Record<string, NonNullable<AnalyticsPayload[string]> | null>
}

function offerContextProperties(data: Partial<OfferAnalyticsContext>) {
  return {
    conditioner_module_id: data.conditionerModuleId,
    entry_context: data.entryContext,
    focus_routine: data.focusRoutine,
    lead_id: data.leadId,
    need_lane: data.needLane,
    offer_revision: data.offerRevision,
    offer_variant: data.offerVariant,
    offer_view_id: data.offerViewId,
    shampoo_module_id: data.shampooModuleId,
    suggested_category: data.suggestedCategory,
  }
}

function commerceProperties(data: Partial<OfferCommerceProperties>) {
  return {
    currency: data.currency,
    interval: data.interval,
    plan_id: data.planId,
    value: data.value,
  }
}

function toPostHogPayload<E extends AppEventName>(eventName: E, payload: AppEventMap[E]) {
  switch (eventName) {
    case "checkout_start_failed": {
      const data = payload as AppEventMap["checkout_start_failed"]
      return {
        ...offerContextProperties(data),
        ...commerceProperties(data),
        checkout_attempt_id: data.checkoutAttemptId,
        error_code: data.errorCode,
        failure_stage: data.failureStage,
        provider: data.provider,
        retryable: data.retryable,
      }
    }
    case "checkout_started": {
      const data = payload as AppEventMap["checkout_started"]
      return {
        ...offerContextProperties(data),
        checkout_attempt_id: data.checkoutAttemptId,
        checkout_context: data.checkoutContext,
        currency: data.currency,
        interval: data.interval,
        leadId: data.leadId,
        plan_id: data.planId,
        provider: data.provider,
        source: data.source,
        value: data.value,
      }
    }
    case "purchase_completed": {
      const data = payload as AppEventMap["purchase_completed"]
      return {
        checkoutSessionId: data.checkoutSessionId,
        currency: data.currency,
        interval: data.interval,
        paymentMethodType: data.paymentMethodType,
        planId: data.planId,
        value: data.value,
      }
    }
    case "quiz_completed": {
      const data = payload as AppEventMap["quiz_completed"]
      return {
        structure: data.hairTexture,
        thickness: data.thickness,
        scalp_type: data.scalpType,
        scalp_condition: data.scalpCondition,
      }
    }
    case "quiz_lead_captured": {
      const data = payload as AppEventMap["quiz_lead_captured"]
      return { marketing_consent: data.marketingConsent }
    }
    case "quiz_started":
    case "quiz_step_viewed": {
      const data = payload as AppEventMap["quiz_started" | "quiz_step_viewed"]
      return {
        step_name: data.stepName,
        step_number: data.stepNumber,
      }
    }
    case "chat_product_recommendation_shown": {
      const data = payload as AppEventMap["chat_product_recommendation_shown"]
      return { productCount: data.productCount }
    }
    case "onboarding_completed": {
      const data = payload as AppEventMap["onboarding_completed"]
      return { userId: data.userId }
    }
    case "offer_checkout_opened": {
      const data = payload as AppEventMap["offer_checkout_opened"]
      return {
        ...offerContextProperties(data),
        ...commerceProperties(data),
        available_providers: data.availableProviders,
        checkout_attempt_id: data.checkoutAttemptId,
        open_index: data.openIndex,
      }
    }
    case "offer_cta_clicked": {
      const data = payload as AppEventMap["offer_cta_clicked"]
      return {
        ...offerContextProperties(data),
        cta_id: data.ctaId,
        destination: data.destination,
        interaction_index: data.interactionIndex,
        selected_interval: data.selectedInterval,
        source_section: data.sourceSection,
      }
    }
    case "offer_faq_opened": {
      const data = payload as AppEventMap["offer_faq_opened"]
      return {
        ...offerContextProperties(data),
        faq_id: data.faqId,
        faq_index: data.faqIndex,
      }
    }
    case "offer_payment_method_selected": {
      const data = payload as AppEventMap["offer_payment_method_selected"]
      return {
        ...offerContextProperties(data),
        ...commerceProperties(data),
        checkout_attempt_id: data.checkoutAttemptId,
        provider: data.provider,
        selection_index: data.selectionIndex,
      }
    }
    case "offer_plan_selected": {
      const data = payload as AppEventMap["offer_plan_selected"]
      return {
        ...offerContextProperties(data),
        ...commerceProperties(data),
        is_default: data.isDefault,
        previous_interval: data.previousInterval,
        selection_index: data.selectionIndex,
      }
    }
    case "offer_section_viewed": {
      const data = payload as AppEventMap["offer_section_viewed"]
      return {
        ...offerContextProperties(data),
        section_id: data.sectionId,
        section_index: data.sectionIndex,
      }
    }
    case "offer_viewed": {
      const data = payload as AppEventMap["offer_viewed"]
      return {
        ...offerContextProperties(data),
        leadId: data.leadId,
      }
    }
    case "pricing_viewed": {
      const data = payload as AppEventMap["pricing_viewed"]
      return {
        ...offerContextProperties(data),
        available_intervals: data.availableIntervals,
        checkout_context: data.checkoutContext,
        leadId: data.leadId,
        offer_revision: data.offerRevision,
        offer_variant: data.offerVariant,
        offer_view_id: data.offerViewId,
        pricing_revision: data.pricingRevision,
        selected_interval: data.selectedInterval,
        source: data.source,
      }
    }
    default:
      return payload as AnalyticsPayload
  }
}

export const postHogDestination = {
  track<E extends AppEventName>(eventName: E, payload: AppEventMap[E]) {
    const funnel = payload as FunnelAnalyticsEnvelope
    const mapped = cleanAnalyticsPayload(toPostHogPayload(eventName, payload))
    delete mapped.funnelEventId
    delete mapped.funnelSessionId
    delete mapped.funnelPackageKey
    posthog.capture(eventName, {
      ...mapped,
      ...(funnel.funnelEventId ? { $insert_id: funnel.funnelEventId } : {}),
      ...(funnel.funnelSessionId ? { funnel_session_id: funnel.funnelSessionId } : {}),
      ...(funnel.funnelPackageKey ? { funnel_package_key: funnel.funnelPackageKey } : {}),
    })
    return true
  },
}
