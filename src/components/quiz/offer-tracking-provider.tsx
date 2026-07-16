"use client"

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { trackAppEvent } from "@/lib/analytics/track-app-event"
import { observeOnceEngaged } from "@/lib/analytics/observe-once-engaged"
import { buildOfferViewedPayload } from "@/lib/analytics/offer-viewed-payload"
import type {
  FunnelAnalyticsEnvelope,
  OfferAnalyticsContext,
  OfferCtaId,
  OfferEntryContext,
  OfferSectionId,
} from "@/lib/analytics/events"
import { createFunnelEventId } from "@/lib/funnel/client"
import type { QuizOfferPreview } from "@/lib/quiz/offer-preview-types"

export const OFFER_REVISION = "product_led_v1"
export const OFFER_PRICING_REVISION = "pricing_v1"

const OfferTrackingContext = createContext<OfferAnalyticsContext | null>(null)

export function useOfferTrackingContext() {
  return useContext(OfferTrackingContext)
}

export function OfferTrackingProvider({
  children,
  entryContext,
  focusRoutine,
  leadId,
  offerTracking,
  offerVariant,
  preview,
}: {
  children: ReactNode
  entryContext: OfferEntryContext
  focusRoutine: boolean
  leadId: string | null
  offerTracking?: FunnelAnalyticsEnvelope | null
  offerVariant: string
  preview: QuizOfferPreview
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const offerTrackedRef = useRef(false)
  const ctaInteractionIndexRef = useRef(0)
  const [offerViewId] = useState(createFunnelEventId)
  const shampooModuleId =
    preview.products.find((product) => product.category === "shampoo")?.key ?? null
  const conditionerModuleId =
    preview.products.find((product) => product.category === "conditioner")?.key ?? null
  const suggestedCategory = preview.needs.extra?.category ?? null

  const context = useMemo<OfferAnalyticsContext>(
    () => ({
      conditionerModuleId,
      entryContext,
      focusRoutine,
      funnelPackageKey: offerTracking?.funnelPackageKey,
      funnelSessionId: offerTracking?.funnelSessionId,
      leadId,
      needLane: preview.lane,
      offerRevision: OFFER_REVISION,
      offerVariant,
      offerViewId,
      shampooModuleId,
      suggestedCategory,
    }),
    [
      conditionerModuleId,
      entryContext,
      focusRoutine,
      offerTracking?.funnelPackageKey,
      offerTracking?.funnelSessionId,
      leadId,
      offerVariant,
      offerViewId,
      preview.lane,
      shampooModuleId,
      suggestedCategory,
    ],
  )

  useEffect(() => {
    if (offerTrackedRef.current) return
    offerTrackedRef.current = true
    trackAppEvent("offer_viewed", buildOfferViewedPayload(context, offerTracking?.funnelEventId))
  }, [context, offerTracking?.funnelEventId])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const cleanups = Array.from(root.querySelectorAll<HTMLElement>("[data-offer-section]")).map(
      (element, sectionIndex) =>
        observeOnceEngaged(element, () => {
          const sectionId = element.dataset.offerSection as OfferSectionId | undefined
          if (!sectionId) return
          trackAppEvent("offer_section_viewed", {
            ...context,
            funnelEventId: createFunnelEventId(),
            sectionId,
            sectionIndex,
          })
        }),
    )

    return () => cleanups.forEach((cleanup) => cleanup())
  }, [context])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const handleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return
      const target = event.target.closest<HTMLElement>("[data-offer-cta]")
      if (!target || !root.contains(target)) return
      const ctaId = target.dataset.offerCta as OfferCtaId | undefined
      const sourceSection = target.dataset.offerSourceSection as "hero" | OfferSectionId | undefined
      const destination = target.dataset.offerDestination
      if (!ctaId || !sourceSection || !destination) return

      ctaInteractionIndexRef.current += 1
      trackAppEvent("offer_cta_clicked", {
        ...context,
        ctaId,
        destination,
        funnelEventId: createFunnelEventId(),
        interactionIndex: ctaInteractionIndexRef.current,
        selectedInterval: target.dataset.offerSelectedInterval as
          | "month"
          | "quarter"
          | "year"
          | undefined,
        sourceSection,
      })
    }

    root.addEventListener("click", handleClick)
    return () => root.removeEventListener("click", handleClick)
  }, [context])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const openedFaqs = new Set<string>()
    const details = Array.from(root.querySelectorAll<HTMLDetailsElement>("details[data-offer-faq]"))
    const cleanups = details.map((detail, faqIndex) => {
      const handleToggle = () => {
        const faqId = detail.dataset.offerFaq
        if (!detail.open || !faqId || openedFaqs.has(faqId)) return
        openedFaqs.add(faqId)
        trackAppEvent("offer_faq_opened", {
          ...context,
          faqId,
          faqIndex,
          funnelEventId: createFunnelEventId(),
        })
      }
      detail.addEventListener("toggle", handleToggle)
      return () => detail.removeEventListener("toggle", handleToggle)
    })

    return () => cleanups.forEach((cleanup) => cleanup())
  }, [context])

  return (
    <OfferTrackingContext.Provider value={context}>
      <div ref={rootRef}>{children}</div>
    </OfferTrackingContext.Provider>
  )
}
