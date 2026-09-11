import type { SupabaseClient } from "@supabase/supabase-js"

import { presentCatalogCommerce } from "@/lib/personal-plan/routine/commerce"
import { checkRateLimit } from "@/lib/rate-limit"
import { loadQuarantinedProductIdsAmong } from "@/lib/scan/catalog-eligibility"
import { captureScanException } from "@/lib/observability/scan"
import { createScanRoute, scanFail, scanOk } from "@/lib/scan/route"
import { hasFreemiumPaidAccess, type FreemiumAccessResult } from "@/lib/entitlements/access"
import { createAdminClient } from "@/lib/supabase/admin"
import { isPersonalPlanFieldTestGuest } from "@/lib/supabase/middleware"
import { createClient } from "@/lib/supabase/server"

export type ScanWishlistEntry = {
  productId: string
  name: string
  brand: string | null
  imageUrl: string | null
  priceLabel: string | null
  purchaseUrl: string | null
}

type WishlistRow = {
  product_id: string
  products: {
    name: string
    brand: string | null
    image_url: string | null
    is_active: boolean | null
    lifecycle_status: string | null
    price_eur: number | null
    currency: string | null
    affiliate_link: string | null
    purchase_link_status: "available" | "unavailable" | null
    price_checked_at: string | null
  } | null
}

export type ScanWishlistRouteDeps = {
  getUserId: () => Promise<string | null>
  checkRateLimit: typeof checkRateLimit
  createAdminClient: typeof createAdminClient
  listWishlist: (client: SupabaseClient, userId: string) => Promise<ScanWishlistEntry[]>
  captureScanException?: typeof captureScanException
  /**
   * Freemium scanner-first (T4): the Merkliste listing is a premium view.
   * Free-tier users can reach this route (the middleware carve-out admits
   * `/api/scan` without itself gating the entitlement), so the guard has to
   * run here, server-side, using the same paid-access composite as the
   * subscription paywall (see `hasFreemiumPaidAccess`). When the flag is off
   * no free user ever reaches this route at all (middleware still 403s
   * them), so this check is redundant-but-harmless in that case.
   *
   * Returns the tri-state `FreemiumAccessResult` (T4 review fix I2), not a
   * plain boolean: an unreadable moderator lookup with no independently
   * verified paid access must surface as a retriable 503, not a 403 —
   * mirroring the middleware paywall's own `moderator_access_unavailable`
   * response.
   */
  requirePremiumAccess: (userId: string) => Promise<FreemiumAccessResult>
}

export function createScanWishlistRouteHandler(deps: ScanWishlistRouteDeps) {
  return createScanRoute<undefined>({
    route: "wishlist",
    deps,
    parse: async () => ({ ok: true, body: undefined }),
    failureReason: "wishlist_list_failed",
    handler: async (ctx) => {
      const access = await deps.requirePremiumAccess(ctx.userId)
      if (access === "unavailable") return scanFail("temporarily_unavailable", 503)
      if (access === "denied") return scanFail("subscription_required", 403)
      const client = deps.createAdminClient()
      const entries = await deps.listWishlist(client, ctx.userId)
      return scanOk({ entries })
    },
  })
}

export async function listScanWishlist(
  client: SupabaseClient,
  userId: string,
): Promise<ScanWishlistEntry[]> {
  const { data, error } = await client
    .from("scan_wishlist")
    .select(
      "product_id, products(name, brand, image_url, is_active, lifecycle_status, price_eur, currency, affiliate_link, purchase_link_status, price_checked_at)",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
  if (error) throw new Error("scan_wishlist_list_failed")

  const rows = (data ?? []) as unknown as WishlistRow[]
  // A Merkliste entry is a "buy this later" pointer, so it has to pass the same catalog
  // gate as everything else scan surfaces (ruling R7 + the lifecycle predicate): a product
  // retired, discontinued or quarantined after it was saved must not keep offering a buy
  // link. v1 drops such rows from the listing silently — the stored row stays, so the
  // entry reappears if the product becomes eligible again.
  const withProduct = rows.filter(
    (row): row is WishlistRow & { products: NonNullable<WishlistRow["products"]> } =>
      Boolean(row.products) &&
      row.products?.is_active === true &&
      row.products?.lifecycle_status === "active",
  )
  const quarantined = await loadQuarantinedProductIdsAmong(
    client,
    withProduct.map((row) => row.product_id),
  )

  return withProduct
    .filter((row) => !quarantined.has(row.product_id))
    .map((row) => {
      const commerce = presentCatalogCommerce({
        priceEur: row.products.price_eur,
        currency: row.products.currency,
        affiliateLink: row.products.affiliate_link,
        purchaseLinkStatus: row.products.purchase_link_status,
        updatedAt: row.products.price_checked_at,
      })
      return {
        productId: row.product_id,
        name: row.products.name,
        brand: row.products.brand,
        imageUrl: row.products.image_url,
        priceLabel: commerce.priceLabel,
        purchaseUrl: commerce.productUrl,
      }
    })
}

// Separate from `getUserId`: the shared scan wrapper only forwards a userId
// string to the handler (see `ScanRouteContext` in `@/lib/scan/route.ts`,
// which this task does not restructure), so the email needed for the C1 fix
// and the `access_kind` needed for the PR1 review's F1 field-test fix have
// no path from `getUserId` into `requirePremiumAccess` without a second
// `auth.getUser()` read. That is a deliberate, request-scoped read — reusing
// a module-level variable across the two calls would leak one concurrent
// request's email/app_metadata into another's premium check.
async function requirePremiumAccessForCurrentUser(userId: string): Promise<FreemiumAccessResult> {
  const { data } = await (await createClient()).auth.getUser()
  return hasFreemiumPaidAccess(
    userId,
    data.user?.email,
    isPersonalPlanFieldTestGuest(data.user ?? {}),
  )
}

export const GET = createScanWishlistRouteHandler({
  getUserId: async () => (await (await createClient()).auth.getUser()).data.user?.id ?? null,
  checkRateLimit,
  createAdminClient,
  listWishlist: listScanWishlist,
  requirePremiumAccess: requirePremiumAccessForCurrentUser,
})
