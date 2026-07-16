import type { AppEventMap, OfferAnalyticsContext } from "./events"

export function buildOfferViewedPayload(
  context: OfferAnalyticsContext,
  persistedFunnelEventId?: string | null,
): AppEventMap["offer_viewed"] {
  const payload = { ...context }
  delete payload.funnelEventId

  return persistedFunnelEventId ? { ...payload, funnelEventId: persistedFunnelEventId } : payload
}
