import { CATEGORY_COPY } from "@/components/personal-plan-products/stage3-product-copy"
import type { PersonalPlanCategory } from "@/lib/personal-plan/products/contracts"
import { presentCatalogCommerce } from "@/lib/personal-plan/routine/commerce"

import type {
  ScanAlternativePresentation,
  ScanPresentedVerdictPayload,
  ScanProductHeader,
  ScanVerdictPayload,
} from "./types"

/**
 * Catalog presentation, joined onto the verdict after the fact.
 *
 * The verdict core (`resolve-verdict.ts`) runs on Stage-3 authority facts, and those
 * deliberately exclude identity/commerce fields that must never influence a fit verdict —
 * there is no brand on them at all, and the purchase link is not carried through the
 * comparison. The sheet needs both (spec §2.1 product header, §3 "Kaufen · <Preis>"), so
 * the resolve route reads the plain catalog rows for the scanned product plus its
 * alternatives and applies this module. Price/link copy comes from `presentCatalogCommerce`
 * so scan, routine drawer and Stage-1 previews never word the same product differently.
 */

export type ScanCatalogPresentationRow = {
  id: string
  name: string
  brand: string | null
  category: PersonalPlanCategory
  imageUrl: string | null
  priceEur: number | null
  currency: string | null
  affiliateLink: string | null
  purchaseLinkStatus: "available" | "unavailable" | null
  priceCheckedAt: string | null
}

function commerceFor(row: ScanCatalogPresentationRow) {
  return presentCatalogCommerce({
    priceEur: row.priceEur,
    currency: row.currency,
    affiliateLink: row.affiliateLink,
    purchaseLinkStatus: row.purchaseLinkStatus,
    updatedAt: row.priceCheckedAt,
  })
}

export function toScanProductHeader(row: ScanCatalogPresentationRow): ScanProductHeader {
  const commerce = commerceFor(row)
  return {
    productId: row.id,
    name: row.name,
    brand: row.brand,
    category: row.category,
    categoryLabel: CATEGORY_COPY[row.category].label,
    imageUrl: row.imageUrl,
    priceLabel: commerce.priceLabel,
    purchaseUrl: commerce.productUrl,
  }
}

export function presentScanVerdictPayload(
  verdict: ScanVerdictPayload,
  rows: readonly ScanCatalogPresentationRow[],
): ScanPresentedVerdictPayload {
  if (verdict.kind === "not_needed") return verdict
  const byId = new Map(rows.map((row) => [row.id, row]))
  return {
    ...verdict,
    alternatives: verdict.alternatives.map((alternative): ScanAlternativePresentation => {
      const row = byId.get(alternative.productId)
      // Field list spelled out (not `...alternative`) on purpose: `ScanAlternative` also
      // carries `criteria` (T8, server-internal only — see types.ts) and a spread would
      // let it ride along onto the wire. Listing every field here means a new
      // `ScanAlternative` field either lands here deliberately or fails to compile.
      return {
        productId: alternative.productId,
        displayName: alternative.displayName,
        imageUrl: alternative.imageUrl,
        priceLabel: alternative.priceLabel,
        netContentLabel: alternative.netContentLabel,
        verdict: alternative.verdict,
        verdictLabel: alternative.verdictLabel,
        brand: row?.brand ?? null,
        purchaseUrl: row ? commerceFor(row).productUrl : null,
      }
    }),
  }
}

/**
 * Drops disposition-quarantined products from an `in_catalog` verdict's alternatives
 * (ruling R7 — a quarantined product must not be recommended, only resolved/saved is
 * covered elsewhere). Shared by the resolve route (T8: applied before either the full or
 * masked serialization branch) and the reveal route (T8), which recomputes the same
 * candidate list and must apply the identical filter so a revealed alternative can never
 * be one resolve would have hidden.
 */
export async function withEligibleAlternatives(
  verdict: ScanVerdictPayload,
  loadQuarantined: (productIds: string[]) => Promise<Set<string>>,
): Promise<ScanVerdictPayload> {
  if (verdict.kind !== "in_catalog" || verdict.alternatives.length === 0) return verdict
  const quarantined = await loadQuarantined(
    verdict.alternatives.map((alternative) => alternative.productId),
  )
  if (quarantined.size === 0) return verdict
  return {
    ...verdict,
    alternatives: verdict.alternatives.filter(
      (alternative) => !quarantined.has(alternative.productId),
    ),
  }
}
