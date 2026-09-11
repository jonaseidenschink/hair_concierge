"use client"

import { useCallback, useRef, useState } from "react"

import type { BillingInterval } from "@/lib/stripe/intervals"
import { DEFAULT_PRICING_INTERVAL } from "@/lib/stripe/pricing-plans"

/**
 * The plan-selection state every subscription surface needs: which interval is selected,
 * and — for analytics — what it was before, whether it is still the preselected default
 * and how many times the visitor has changed their mind.
 *
 * Extracted from `MembershipResultOfferPricing` (T13, freemium-scanner-first PR4) so the
 * offer page and the Premium sheet share ONE selection model instead of two drifting
 * copies. The hook deliberately owns nothing else: tracking, provider locks and checkout
 * teardown stay at the call site, because those differ per surface.
 */
export interface PlanSelectionChange {
  interval: BillingInterval
  previousInterval: BillingInterval
  /** `true` while the visitor is still on the interval the surface preselected. */
  isDefault: boolean
  /** 1-based, monotonic per mounted surface — the offer funnel's `selectionIndex`. */
  selectionIndex: number
}

export function usePlanSelection({
  defaultInterval = DEFAULT_PRICING_INTERVAL,
}: { defaultInterval?: BillingInterval } = {}): {
  selectedInterval: BillingInterval
  /** Selects `interval` and returns the change descriptor for the caller's analytics. */
  selectPlan: (interval: BillingInterval) => PlanSelectionChange
} {
  const [selectedInterval, setSelectedInterval] = useState<BillingInterval>(defaultInterval)
  // A ref, not state: the index must increment synchronously across two `selectPlan`
  // calls inside one React batch (no re-render between them), matching the original
  // `planSelectionIndexRef.current += 1` semantics this hook was extracted from.
  const selectionIndexRef = useRef(0)

  const selectPlan = useCallback(
    (interval: BillingInterval): PlanSelectionChange => {
      selectionIndexRef.current += 1
      const change: PlanSelectionChange = {
        interval,
        previousInterval: selectedInterval,
        isDefault: interval === defaultInterval,
        selectionIndex: selectionIndexRef.current,
      }
      setSelectedInterval(interval)
      return change
    },
    [defaultInterval, selectedInterval],
  )

  return { selectedInterval, selectPlan }
}
