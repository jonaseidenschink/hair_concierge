import { trackCustomerIoEvent, type CustomerIoProperties } from "@/lib/customerio-tracking"
import {
  bootstrapFunnelContext,
  getCurrentFunnelContext,
  type CurrentFunnelContext,
} from "@/lib/funnel/client"
import type { AppEventMap, AppEventName, FunnelAnalyticsEnvelope } from "../events"

const FUNNEL_CONTEXT_WAIT_MS = 500
const FUNNEL_CONTEXT_EVENTS = new Set<AppEventName>([
  "checkout_started",
  "pricing_viewed",
  "quiz_completed",
  "quiz_started",
  "quiz_step_viewed",
])

type PendingCustomerIoTrack = (context: CurrentFunnelContext | null) => boolean

let pendingFunnelTracks: PendingCustomerIoTrack[] = []
let funnelFlushScheduled = false

function scheduleFunnelFlush() {
  if (funnelFlushScheduled) return
  funnelFlushScheduled = true

  let flushed = false
  const flush = (context: CurrentFunnelContext | null) => {
    if (flushed) return
    flushed = true
    funnelFlushScheduled = false
    const tracks = pendingFunnelTracks
    pendingFunnelTracks = []
    for (const track of tracks) {
      try {
        track(context)
      } catch (error) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[analytics] queued Customer.io event failed", error)
        }
      }
    }
  }

  const timeout = globalThis.setTimeout(
    () => flush(getCurrentFunnelContext()),
    FUNNEL_CONTEXT_WAIT_MS,
  )
  void bootstrapFunnelContext().then((context) => {
    globalThis.clearTimeout(timeout)
    flush(context)
  })
}

function trackWithFunnelContext(
  eventName: AppEventName,
  properties: CustomerIoProperties,
  funnel: FunnelAnalyticsEnvelope,
) {
  const currentContext = getCurrentFunnelContext()
  const resolvedPackageKey = funnel.funnelPackageKey ?? currentContext?.funnelPackageKey
  const resolvedSessionId = funnel.funnelSessionId ?? currentContext?.funnelSessionId
  const track = (fallbackContext: CurrentFunnelContext | null) =>
    trackCustomerIoEvent(eventName as Parameters<typeof trackCustomerIoEvent>[0], {
      ...properties,
      ...(funnel.funnelEventId ? { funnel_event_id: funnel.funnelEventId } : {}),
      ...((resolvedSessionId ?? fallbackContext?.funnelSessionId)
        ? { funnel_session_id: resolvedSessionId ?? fallbackContext?.funnelSessionId }
        : {}),
      ...((resolvedPackageKey ?? fallbackContext?.funnelPackageKey)
        ? { funnel_package_key: resolvedPackageKey ?? fallbackContext?.funnelPackageKey }
        : {}),
    })

  if (resolvedPackageKey && !funnelFlushScheduled) return track(currentContext)

  pendingFunnelTracks.push(track)
  scheduleFunnelFlush()
  return true
}

function toCustomerIoPayload<E extends AppEventName>(eventName: E, payload: AppEventMap[E]) {
  switch (eventName) {
    case "chat_product_recommendation_shown": {
      const data = payload as AppEventMap["chat_product_recommendation_shown"]
      return { product_count: data.productCount }
    }
    case "checkout_started": {
      const data = payload as AppEventMap["checkout_started"]
      return {
        checkout_context: data.checkoutContext,
        currency: data.currency,
        interval: data.interval,
        lead_id: data.leadId,
        plan_id: data.planId,
        provider: data.provider,
        source: data.source,
        value: data.value,
      }
    }
    case "first_chat_message":
      return {}
    case "onboarding_completed": {
      const data = payload as AppEventMap["onboarding_completed"]
      return { user_id: data.userId }
    }
    case "pricing_viewed": {
      const data = payload as AppEventMap["pricing_viewed"]
      return {
        checkout_context: data.checkoutContext,
        lead_id: data.leadId,
        source: data.source,
      }
    }
    case "purchase_completed": {
      const data = payload as AppEventMap["purchase_completed"]
      return {
        checkout_session_id: data.checkoutSessionId,
        currency: data.currency.toUpperCase(),
        interval: data.interval,
        payment_method_type: data.paymentMethodType,
        plan_id: data.planId,
        value: data.value,
      }
    }
    case "quiz_completed": {
      const data = payload as AppEventMap["quiz_completed"]
      return {
        hair_texture: data.hairTexture,
        lead_id: data.leadId,
        scalp_condition: data.scalpCondition,
        scalp_type: data.scalpType,
        thickness: data.thickness,
      }
    }
    case "quiz_goals_selected": {
      const data = payload as AppEventMap["quiz_goals_selected"]
      return { count: data.count }
    }
    case "quiz_lead_captured": {
      const data = payload as AppEventMap["quiz_lead_captured"]
      return {
        lead_id: data.leadId,
        marketing_consent: data.marketingConsent,
      }
    }
    case "quiz_started":
    case "quiz_step_viewed": {
      const data = payload as AppEventMap["quiz_started" | "quiz_step_viewed"]
      return {
        step_name: data.stepName,
        step_number: data.stepNumber,
      }
    }
    case "subscription_started": {
      const data = payload as AppEventMap["subscription_started"]
      return { checkout_session_id: data.checkoutSessionId }
    }
  }
}

export const customerIoDestination = {
  track<E extends AppEventName>(eventName: E, payload: AppEventMap[E]) {
    const mapped = toCustomerIoPayload(eventName, payload) as CustomerIoProperties
    const funnel = payload as FunnelAnalyticsEnvelope
    if (FUNNEL_CONTEXT_EVENTS.has(eventName)) {
      return trackWithFunnelContext(eventName, mapped, funnel)
    }
    return trackCustomerIoEvent(eventName as Parameters<typeof trackCustomerIoEvent>[0], {
      ...mapped,
      ...(funnel.funnelEventId ? { funnel_event_id: funnel.funnelEventId } : {}),
      ...(funnel.funnelSessionId ? { funnel_session_id: funnel.funnelSessionId } : {}),
      ...(funnel.funnelPackageKey ? { funnel_package_key: funnel.funnelPackageKey } : {}),
    })
  },
}
