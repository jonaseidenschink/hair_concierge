import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { deriveEntitlements } from "@/lib/entitlements"
import { resolvePaidAppAccess, type FreemiumAccessResult } from "@/lib/entitlements/access"
import {
  consumeFreeReveal,
  loadFreeRevealRecord,
  type ConsumeFreeRevealResult,
  type FreeRevealRecord,
} from "@/lib/entitlements/free-reveal"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import {
  loadScanProductFacts,
  loadStage3RecommendationCandidatesByRole,
} from "@/lib/personal-plan/products/authority/catalog-facts"
import type { PersonalPlanCategory } from "@/lib/personal-plan/products/contracts"
import { checkRateLimit } from "@/lib/rate-limit"
import {
  isProductSearchQuarantined,
  loadQuarantinedProductIdsAmong,
} from "@/lib/scan/catalog-eligibility"
import { loadScanVerdictForProduct } from "@/lib/scan/load-scan-verdict"
import { loadScanEvaluationContext } from "@/lib/scan/profile-context"
import {
  presentScanVerdictPayload,
  withEligibleAlternatives,
  type ScanCatalogPresentationRow,
} from "@/lib/scan/product-presentation"
import { buildScanVerdict } from "@/lib/scan/resolve-verdict"
import { createScanRoute, parseJsonBody, scanFail, scanOk } from "@/lib/scan/route"
import type { ScanAlternativePresentation } from "@/lib/scan/types"
import { captureScanException } from "@/lib/observability/scan"
import { createAdminClient } from "@/lib/supabase/admin"
import { isPersonalPlanFieldTestGuest } from "@/lib/supabase/middleware"
import { createClient } from "@/lib/supabase/server"

/**
 * Freemium scanner-first (T8): the free-tier reveal endpoint. `/api/scan/resolve` withholds
 * identity/productId/images/purchase URLs/prices on a free user's alternatives (see
 * `masked-alternative.ts`); this route spends that user's one-lifetime reveal credit (T7's
 * `scan_free_reveals`, via `consumeFreeReveal`) and hands back the FULL, existing
 * `ScanAlternativePresentation[]` shape for the same scanned product's alternatives —
 * recomputed with `loadScanVerdictForProduct`, the exact function `/api/scan/resolve`'s
 * direct-productId path uses, so a revealed alternative can never be one resolve would not
 * have shown.
 *
 * `productId` here is the SCANNED product (same meaning as everywhere else in `lib/scan/*`),
 * not an alternative's id — masked alternatives never carry an id to round-trip, and the
 * ledger's `product_id` column records which scan the lifetime credit was spent on.
 */

const revealBodySchema = z
  .object({
    productId: z.string().uuid(),
  })
  .strict()

type RevealBody = z.infer<typeof revealBodySchema>

export type ScanRevealResult = {
  ok: true
  productId: string
  alternatives: ScanAlternativePresentation[]
}

type ActiveProductLookup = { id: string; category: PersonalPlanCategory } | null

export type ScanRevealRouteDeps = {
  getUserId: () => Promise<string | null>
  checkRateLimit: typeof checkRateLimit
  createAdminClient: typeof createAdminClient
  isFreemiumScannerFirstEnabled: typeof isFreemiumScannerFirstEnabled
  resolvePaidAccess: (userId: string) => Promise<FreemiumAccessResult>
  consumeFreeReveal: (
    client: SupabaseClient,
    input: { userId: string; productId: string },
  ) => Promise<ConsumeFreeRevealResult>
  loadFreeRevealRecord: (client: SupabaseClient, userId: string) => Promise<FreeRevealRecord | null>
  loadActiveProductById: (client: SupabaseClient, productId: string) => Promise<ActiveProductLookup>
  isProductSearchQuarantined: typeof isProductSearchQuarantined
  loadQuarantinedProductIdsAmong: typeof loadQuarantinedProductIdsAmong
  loadScanEvaluationContext: typeof loadScanEvaluationContext
  loadScanProductFacts: typeof loadScanProductFacts
  loadRecommendationCandidates: typeof loadStage3RecommendationCandidatesByRole
  buildScanVerdict: typeof buildScanVerdict
  loadPresentationRows: (
    client: SupabaseClient,
    productIds: string[],
  ) => Promise<ScanCatalogPresentationRow[]>
  captureScanException?: typeof captureScanException
}

export function createScanRevealRouteHandler(deps: ScanRevealRouteDeps) {
  return createScanRoute<RevealBody>({
    route: "reveal",
    deps,
    parse: parseJsonBody(revealBodySchema),
    failureReason: "reveal_failed",
    handler: async (ctx) => {
      const userId = ctx.userId
      const productId = ctx.body.productId

      // The endpoint only exists behind the freemium restructure: with the flag off no
      // free user can even reach `/api/scan/*` (middleware paywall), and there is no
      // masked response for anyone to reveal — mirrors the plan's "Deny when flag off or
      // unauthenticated" (unauthenticated is the wrapper's 401 above).
      if (!deps.isFreemiumScannerFirstEnabled()) return scanFail("scan_reveal_disabled", 404)

      const client = deps.createAdminClient()

      const active = await deps.loadActiveProductById(client, productId)
      if (!active) return scanFail("product_not_found", 404)
      if (await deps.isProductSearchQuarantined(client, active.id)) {
        return scanFail("product_not_found", 404)
      }

      // Profile/decision validated BEFORE the credit is spent: both are reads (no
      // read-before-write on the ledger itself — `consumeFreeReveal` stays a pure INSERT),
      // and doing them first means a missing profile or decision can never burn the one-
      // lifetime credit for nothing.
      const context = await deps.loadScanEvaluationContext(client, userId)
      if (!context) return scanFail("profile_missing", 409)

      const decision = context.snapshot.decisions.find(
        (entry) => entry.category === active.category,
      )
      if (!decision) throw new Error("scan_reveal_decision_missing")

      const access = await deps.resolvePaidAccess(userId)
      if (access === "unavailable") throw new Error("scan_reveal_entitlements_unavailable")

      // Fix round 1 (F2): route the credit decision through the same entitlements module
      // resolve's masking gate uses, not a raw `access === "denied"` check, so both routes
      // have exactly one place to change if a future ruling grants some free cohort
      // alternatives without full paid access.
      const entitlements = deriveEntitlements({
        hasAppAccess: access === "allowed",
        freeRevealUsed: false,
      })

      // Fix round 1 (F1): compute the verdict and the eligible alternative list BEFORE
      // touching the ledger. A downstream failure here now throws — same as any other scan
      // read — with no credit spent yet; a retry costs nothing. Premium alternatives are
      // never masked in the first place (binding constraint), so a premium caller reaches
      // this unconditionally and never spends a credit either way.
      const verdict = await loadScanVerdictForProduct(
        client,
        deps,
        active.category,
        active.id,
        decision,
        context,
      )

      const alternativeIds =
        verdict.kind === "in_catalog"
          ? verdict.alternatives.map((alternative) => alternative.productId)
          : []
      const presentationRows = await deps.loadPresentationRows(client, alternativeIds)

      const eligibleVerdict = await withEligibleAlternatives(verdict, (ids) =>
        deps.loadQuarantinedProductIdsAmong(client, ids),
      )
      const presented = presentScanVerdictPayload(eligibleVerdict, presentationRows)

      const result: ScanRevealResult = {
        ok: true,
        productId: active.id,
        alternatives: presented.kind === "in_catalog" ? presented.alternatives : [],
      }

      if (!entitlements.canSeeAlternatives) {
        // Nothing to reveal: never spend the one-lifetime credit on an empty result (F1,
        // failure scenario B — `not_needed` verdicts and an all-quarantined alternative
        // list both land here).
        if (result.alternatives.length === 0) return scanOk(result)

        const consumed = await deps.consumeFreeReveal(client, { userId, productId: active.id })
        if (consumed === "already_used") {
          // Fix round 1 (F1-adjunct, keepsake rule): the user keeps what they already
          // spent their credit on. Re-serve the SAME product's just-computed reveal
          // instead of erroring; only a genuinely different product is a conflict.
          const ledgered = await deps.loadFreeRevealRecord(client, userId)
          if (ledgered?.productId === active.id) return scanOk(result)
          return scanFail("already_used", 409)
        }
      }

      return scanOk(result)
    },
  })
}

async function resolvePaidAccessForCurrentUser(userId: string): Promise<FreemiumAccessResult> {
  const { data } = await (await createClient()).auth.getUser()
  return resolvePaidAppAccess(
    userId,
    data.user?.email,
    isPersonalPlanFieldTestGuest(data.user ?? {}),
  )
}

async function loadActiveProductById(
  client: SupabaseClient,
  productId: string,
): Promise<ActiveProductLookup> {
  const { data, error } = await client
    .from("products")
    .select("id, category_key")
    .eq("id", productId)
    .eq("is_active", true)
    .eq("lifecycle_status", "active")
    .maybeSingle()
  if (error) throw new Error("scan_reveal_product_lookup_failed")
  const row = data as { id: string; category_key: string } | null
  return row ? { id: row.id, category: row.category_key as PersonalPlanCategory } : null
}

async function loadPresentationRows(
  client: SupabaseClient,
  productIds: string[],
): Promise<ScanCatalogPresentationRow[]> {
  if (productIds.length === 0) return []
  const { data, error } = await client
    .from("products")
    .select(
      "id, name, brand, category_key, image_url, price_eur, currency, affiliate_link, purchase_link_status, price_checked_at",
    )
    .in("id", [...new Set(productIds)])
  if (error) throw new Error("scan_reveal_presentation_lookup_failed")
  return ((data ?? []) as PresentationRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    brand: row.brand,
    category: row.category_key as PersonalPlanCategory,
    imageUrl: row.image_url,
    priceEur: row.price_eur,
    currency: row.currency,
    affiliateLink: row.affiliate_link,
    purchaseLinkStatus:
      row.purchase_link_status === "available" || row.purchase_link_status === "unavailable"
        ? row.purchase_link_status
        : null,
    priceCheckedAt: row.price_checked_at,
  }))
}

type PresentationRow = {
  id: string
  name: string
  brand: string | null
  category_key: string
  image_url: string | null
  price_eur: number | null
  currency: string | null
  affiliate_link: string | null
  purchase_link_status: string | null
  price_checked_at: string | null
}

export const POST = createScanRevealRouteHandler({
  getUserId: async () => (await (await createClient()).auth.getUser()).data.user?.id ?? null,
  checkRateLimit,
  createAdminClient,
  isFreemiumScannerFirstEnabled,
  resolvePaidAccess: resolvePaidAccessForCurrentUser,
  consumeFreeReveal,
  loadFreeRevealRecord,
  loadActiveProductById,
  isProductSearchQuarantined,
  loadQuarantinedProductIdsAmong,
  loadScanEvaluationContext,
  loadScanProductFacts,
  loadRecommendationCandidates: loadStage3RecommendationCandidatesByRole,
  buildScanVerdict,
  loadPresentationRows,
})
