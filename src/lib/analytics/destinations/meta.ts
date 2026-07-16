import {
  trackMetaCheckoutStarted,
  trackMetaLeadCaptured,
  trackMetaPricingViewed,
  trackMetaPurchaseConfirmed,
  trackMetaQuizCompleted,
  trackMetaQuizStarted,
  trackMetaQuizStepViewed,
  trackMetaSubscriptionConfirmed,
} from "@/lib/meta-pixel"
import { bootstrapFunnelContext, getCurrentFunnelContext } from "@/lib/funnel/client"
import type { AppEventMap, AppEventName } from "../events"

const FUNNEL_CONTEXT_WAIT_MS = 500

type PendingPackageTrack = (resolvedPackageKey?: string) => boolean

let pendingPackageTracks: PendingPackageTrack[] = []
let packageFlushScheduled = false

function schedulePackageFlush() {
  if (packageFlushScheduled) return
  packageFlushScheduled = true

  let flushed = false
  const flush = (packageKey?: string) => {
    if (flushed) return
    flushed = true
    packageFlushScheduled = false
    const tracks = pendingPackageTracks
    pendingPackageTracks = []
    for (const track of tracks) {
      try {
        track(packageKey)
      } catch (error) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[analytics] queued Meta event failed", error)
        }
      }
    }
  }

  const timeout = globalThis.setTimeout(
    () => flush(getCurrentFunnelContext()?.funnelPackageKey),
    FUNNEL_CONTEXT_WAIT_MS,
  )
  void bootstrapFunnelContext().then((context) => {
    globalThis.clearTimeout(timeout)
    flush(context?.funnelPackageKey)
  })
}

function trackWithFunnelPackage(
  packageKey: string | null | undefined,
  track: (resolvedPackageKey?: string) => boolean,
) {
  const resolvedPackageKey = packageKey ?? getCurrentFunnelContext()?.funnelPackageKey
  if (resolvedPackageKey && !packageFlushScheduled) return track(resolvedPackageKey)

  pendingPackageTracks.push((fallbackPackageKey) => track(resolvedPackageKey ?? fallbackPackageKey))
  schedulePackageFlush()
  return true
}

export const metaDestination = {
  track<E extends AppEventName>(eventName: E, payload: AppEventMap[E]) {
    switch (eventName) {
      case "checkout_started": {
        const data = payload as AppEventMap["checkout_started"]
        return trackWithFunnelPackage(data.funnelPackageKey, (packageKey) =>
          trackMetaCheckoutStarted(
            data.source,
            data.interval ?? null,
            {
              currency: data.currency,
              planId: data.planId,
              value: data.value,
            },
            data.funnelEventId,
            packageKey,
          ),
        )
      }
      case "pricing_viewed": {
        const data = payload as AppEventMap["pricing_viewed"]
        return trackWithFunnelPackage(data.funnelPackageKey, (packageKey) =>
          trackMetaPricingViewed(data.source, data.funnelEventId, packageKey),
        )
      }
      case "purchase_completed": {
        const data = payload as AppEventMap["purchase_completed"]
        return trackMetaPurchaseConfirmed({
          contentId: data.planId,
          currency: data.currency,
          eventId: data.checkoutSessionId,
          funnelPackageKey: data.funnelPackageKey,
          interval: data.interval,
          paymentMethodType: data.paymentMethodType,
          value: data.value,
        })
      }
      case "quiz_completed": {
        const data = payload as AppEventMap["quiz_completed"]
        return trackWithFunnelPackage(data.funnelPackageKey, (packageKey) =>
          trackMetaQuizCompleted(data.funnelEventId, packageKey),
        )
      }
      case "quiz_lead_captured": {
        const data = payload as AppEventMap["quiz_lead_captured"]
        return trackWithFunnelPackage(data.funnelPackageKey, (packageKey) =>
          trackMetaLeadCaptured(data.marketingConsent, data.funnelEventId, packageKey),
        )
      }
      case "quiz_started": {
        const data = payload as AppEventMap["quiz_started"]
        return trackWithFunnelPackage(data.funnelPackageKey, (packageKey) =>
          trackMetaQuizStarted(data.stepName, data.stepNumber, data.funnelEventId, packageKey),
        )
      }
      case "quiz_step_viewed": {
        const data = payload as AppEventMap["quiz_step_viewed"]
        return trackWithFunnelPackage(undefined, () =>
          trackMetaQuizStepViewed(data.stepName, data.stepNumber),
        )
      }
      case "subscription_started": {
        const data = payload as AppEventMap["subscription_started"]
        return trackMetaSubscriptionConfirmed(data.checkoutSessionId)
      }
      default:
        return false
    }
  },
}
