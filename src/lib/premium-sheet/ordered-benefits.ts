import type { PremiumFeatureId, PremiumSheetContext } from "./context"

/**
 * The Premium sheet always shows exactly three benefits: whatever feature the user just
 * bumped into, plus two more picked from a fixed "core value" order so the sheet never
 * looks like a single-feature paywall. Final algorithm — PR4's real sheet reuses this
 * verbatim, so any change here is a product decision, not a refactor.
 */
const CORE_ORDER: PremiumFeatureId[] = ["routine", "empfehlungen", "chat", "anwendung"]

export function orderedBenefits(ctx: PremiumSheetContext | null): PremiumFeatureId[] {
  if (ctx === null) return CORE_ORDER.slice(0, 3)

  const remaining = CORE_ORDER.filter((feature) => feature !== ctx.feature).slice(0, 2)
  return [ctx.feature, ...remaining]
}
