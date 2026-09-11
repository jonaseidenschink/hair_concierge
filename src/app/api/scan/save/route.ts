import { z } from "zod"

import { checkRateLimit } from "@/lib/rate-limit"
import {
  loadScanSavedState,
  moveScanSavedProduct,
  removeScanRoutineProduct,
  removeScanWishlistProduct,
  type ScanSaveKind,
} from "@/lib/scan/saved-state"
import { captureScanException } from "@/lib/observability/scan"
import { createScanRoute, parseJsonBody, scanFail, scanOk } from "@/lib/scan/route"
import { hasFreemiumPaidAccess, type FreemiumAccessResult } from "@/lib/entitlements/access"
import { createAdminClient } from "@/lib/supabase/admin"
import { isPersonalPlanFieldTestGuest } from "@/lib/supabase/middleware"
import { createClient } from "@/lib/supabase/server"

const saveBodySchema = z
  .object({
    productId: z.string().uuid(),
    kind: z.enum(["routine", "merkliste"]),
  })
  .strict()

type SaveBody = z.infer<typeof saveBodySchema>

export type ScanSaveRouteDeps = {
  getUserId: () => Promise<string | null>
  checkRateLimit: typeof checkRateLimit
  createAdminClient: typeof createAdminClient
  moveSavedProduct: typeof moveScanSavedProduct
  removeWishlist: typeof removeScanWishlistProduct
  removeRoutine: typeof removeScanRoutineProduct
  loadSavedState: typeof loadScanSavedState
  captureScanException?: typeof captureScanException
  /**
   * Freemium scanner-first (T4): save/remove is a premium mutation. Free-tier
   * users can reach this route (the middleware carve-out admits `/api/scan`
   * without itself gating the entitlement), so the guard has to run here,
   * server-side, using the same paid-access composite as the subscription
   * paywall (see `hasFreemiumPaidAccess`). When the flag is off no free user
   * ever reaches this route at all (middleware still 403s them), so this
   * check is redundant-but-harmless in that case.
   *
   * Returns the tri-state `FreemiumAccessResult` (T4 review fix I2), not a
   * plain boolean: an unreadable moderator lookup with no independently
   * verified paid access must surface as a retriable 503, not a 403 —
   * mirroring the middleware paywall's own `moderator_access_unavailable`
   * response.
   */
  requirePremiumAccess: (userId: string) => Promise<FreemiumAccessResult>
}

export function createScanSaveRouteHandlers(deps: ScanSaveRouteDeps) {
  function removeKind(
    client: ReturnType<typeof createAdminClient>,
    userId: string,
    productId: string,
    kind: ScanSaveKind,
  ) {
    return kind === "merkliste"
      ? deps.removeWishlist(client, userId, productId)
      : deps.removeRoutine(client, userId, productId)
  }

  const POST = createScanRoute<SaveBody>({
    route: "save",
    deps,
    parse: parseJsonBody(saveBodySchema),
    failureReason: "save_failed",
    handler: async (ctx) => {
      const access = await deps.requirePremiumAccess(ctx.userId)
      if (access === "unavailable") return scanFail("temporarily_unavailable", 503)
      if (access === "denied") return scanFail("subscription_required", 403)
      const client = deps.createAdminClient()
      // The two destinations are exclusive, so a save is a MOVE — destination write
      // plus source cleanup plus the state read, all inside one transaction
      // (`scan_move_saved_product`). A source row another surface owns is left
      // standing and is not a failure; the returned state reports what stands.
      const result = await deps.moveSavedProduct(
        client,
        ctx.userId,
        ctx.body.productId,
        ctx.body.kind,
      )
      if (result.outcome === "product_not_found") return scanFail("product_not_found", 404)
      if (result.outcome === "product_not_saveable") return scanFail("product_not_saveable", 409)

      return scanOk({
        ok: true,
        kind: ctx.body.kind,
        productId: ctx.body.productId,
        savedState: result.savedState,
      })
    },
  })

  const DELETE = createScanRoute<SaveBody>({
    route: "save",
    deps,
    parse: parseJsonBody(saveBodySchema),
    failureReason: "save_removal_failed",
    handler: async (ctx) => {
      const access = await deps.requirePremiumAccess(ctx.userId)
      if (access === "unavailable") return scanFail("temporarily_unavailable", 503)
      if (access === "denied") return scanFail("subscription_required", 403)
      const client = deps.createAdminClient()
      const result = await removeKind(client, ctx.userId, ctx.body.productId, ctx.body.kind)
      // The routine row belongs to Stage-3 / product intake: the scan sheet has no
      // authority to delete it, and reporting success would render as "removed" for a
      // row that is still there.
      if (result.outcome === "not_removable_here") return scanFail("not_removable_here", 409)
      // Not necessarily `null`: removing the Merkliste entry of a product the user also
      // owns via Stage-3 leaves a truthful "routine" state behind, so re-read it.
      const savedState = await deps.loadSavedState(client, ctx.userId, ctx.body.productId)
      return scanOk({
        ok: true,
        kind: ctx.body.kind,
        productId: ctx.body.productId,
        savedState,
      })
    },
  })

  return { POST, DELETE }
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

const handlers = createScanSaveRouteHandlers({
  getUserId: async () => (await (await createClient()).auth.getUser()).data.user?.id ?? null,
  checkRateLimit,
  createAdminClient,
  moveSavedProduct: moveScanSavedProduct,
  removeWishlist: removeScanWishlistProduct,
  removeRoutine: removeScanRoutineProduct,
  loadSavedState: loadScanSavedState,
  requirePremiumAccess: requirePremiumAccessForCurrentUser,
})

export const POST = handlers.POST
export const DELETE = handlers.DELETE
