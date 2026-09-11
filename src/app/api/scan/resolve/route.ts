import type { SupabaseClient } from "@supabase/supabase-js"
import { after } from "next/server"
import { z } from "zod"

import { CATEGORY_COPY } from "@/components/personal-plan-products/stage3-product-copy"
import { getEntitlements } from "@/lib/entitlements"
import { resolvePaidAppAccess, type FreemiumAccessResult } from "@/lib/entitlements/access"
import { hasUsedFreeReveal } from "@/lib/entitlements/free-reveal"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import {
  loadScanProductFacts,
  loadStage3RecommendationCandidatesByRole,
} from "@/lib/personal-plan/products/authority/catalog-facts"
import {
  PERSONAL_PLAN_PRODUCT_CATEGORIES,
  type PersonalPlanCategory,
} from "@/lib/personal-plan/products/contracts"
import { normalizeIdentifierValue } from "@/lib/product-identity/normalize"
import { checkRateLimit } from "@/lib/rate-limit"
import {
  isProductSearchQuarantined,
  loadQuarantinedProductIdsAmong,
} from "@/lib/scan/catalog-eligibility"
import { lookupCatalogProductByIdentifier, validateEanInput } from "@/lib/scan/identifier-lookup"
import { findOpenScanSubmission } from "@/lib/scan/pending-submission"
import {
  completeScanResolveAttempt,
  createScanResolveAttemptId,
  recordScanResolveAttempt,
  type ScanResolveFailureStage,
  type ScanResolveLookupOutcome,
} from "@/lib/scan/resolve-event-log"
import {
  presentScanVerdictPayload,
  toScanProductHeader,
  withEligibleAlternatives,
  type ScanCatalogPresentationRow,
} from "@/lib/scan/product-presentation"
import { loadScanVerdictForProduct } from "@/lib/scan/load-scan-verdict"
import { maskScanVerdictPayload, type ScanMaskedVerdictResult } from "@/lib/scan/masked-alternative"
import { loadScanEvaluationContext } from "@/lib/scan/profile-context"
import { buildScanVerdict } from "@/lib/scan/resolve-verdict"
import { createScanRoute, parseJsonBody, scanFail, scanOk } from "@/lib/scan/route"
import { loadScanSavedState } from "@/lib/scan/saved-state"
import type { ScanResolveResult, ScanResolvedVerdictResult } from "@/lib/scan/types"
import { SCAN_PENDING_SUBMISSION_HEADLINE } from "@/lib/scan/verdict-labels"
import { captureScanException } from "@/lib/observability/scan"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { isPersonalPlanFieldTestGuest } from "@/lib/supabase/middleware"

/**
 * v1 API surface only ever needs "ean" (ruling R9): the scanner emits ean_13/ean_8 and
 * manual entry is ean-only too. `lookupCatalogProductByIdentifier`'s DB-side matching stays
 * `ean|gtin|barcode` (identifier-lookup.ts, unchanged) — this route just never accepts the
 * other two from a client.
 */
const identifierBodySchema = z
  .object({
    type: z.literal("ean"),
    value: z.string().trim().min(1).max(64),
  })
  .strict()

const resolveBodySchema = z
  .object({
    identifier: identifierBodySchema.optional(),
    productId: z.string().uuid().optional(),
  })
  .strict()
  .refine((body) => Boolean(body.identifier) !== Boolean(body.productId), {
    message: "exactly_one_of_identifier_or_product_id",
  })

type ResolveInput = z.infer<typeof resolveBodySchema>

type ActiveProductLookup = { id: string; category: PersonalPlanCategory } | null

export type ScanResolveRouteDeps = {
  getUserId: () => Promise<string | null>
  checkRateLimit: typeof checkRateLimit
  createAdminClient: typeof createAdminClient
  validateEanInput: typeof validateEanInput
  findOpenScanSubmission: typeof findOpenScanSubmission
  createScanResolveAttemptId: typeof createScanResolveAttemptId
  recordScanResolveAttempt: typeof recordScanResolveAttempt
  completeScanResolveAttempt: typeof completeScanResolveAttempt
  lookupCatalogProductByIdentifier: typeof lookupCatalogProductByIdentifier
  isProductSearchQuarantined: typeof isProductSearchQuarantined
  loadQuarantinedProductIdsAmong: typeof loadQuarantinedProductIdsAmong
  loadScanEvaluationContext: typeof loadScanEvaluationContext
  loadScanProductFacts: typeof loadScanProductFacts
  loadRecommendationCandidates: typeof loadStage3RecommendationCandidatesByRole
  loadScanSavedState: typeof loadScanSavedState
  buildScanVerdict: typeof buildScanVerdict
  loadActiveProductById: (client: SupabaseClient, productId: string) => Promise<ActiveProductLookup>
  loadPresentationRows: (
    client: SupabaseClient,
    productIds: string[],
  ) => Promise<ScanCatalogPresentationRow[]>
  /**
   * Freemium scanner-first (T8): the same paid-access composite `requirePremiumAccess`
   * uses on save/wishlist (see access.ts). Only consulted when the flag is on AND the
   * verdict is `in_catalog` (nothing to mask otherwise) — flag-off and premium responses
   * never call this, so they stay byte-identical to before T8.
   */
  resolvePaidAccess: (userId: string) => Promise<FreemiumAccessResult>
  /** T7 accessor, called with the admin `client` already in scope — never a user-scoped
   * client, or RLS hides the row and this reports "unused" forever. */
  hasUsedFreeReveal: typeof hasUsedFreeReveal
  captureScanException?: typeof captureScanException
  /**
   * Injection seam for Next's `after`, which throws outside a request scope. Tests pass a
   * runner that holds the task until they drain it, mirroring post-response execution.
   */
  after?: ScanAfter
}

type ScanAfter = (task: () => Promise<void> | void) => void

/**
 * Mutable attempt-telemetry bookkeeping for one request, created fresh per parse() call
 * and threaded through the wrapper's ctx.body so both the handler (normal completion) and
 * `onError` (the catch-all's completeAttempt("temporarily_unavailable", ...) call) see the
 * same state. Task 4 owns the telemetry semantics themselves — this is scaffolding-removal
 * only, carrying the same fields the old inline `let`s held.
 */
type ResolveAttemptTracker = {
  attemptId: string | null
  /** Request start, written as the attempt row's `created_at` — see `ScanResolveAttempt`. */
  startedAt: string
  lookupOutcome: ScanResolveLookupOutcome | null
  matchedProductId: string | null
  failureStage: ScanResolveFailureStage
  /** Deferred telemetry writes, drained in FIFO order — see `scheduleAttemptWrite`. */
  telemetryWrites: Array<() => Promise<void>>
  telemetryDrainScheduled: boolean
}

type ResolveRouteBody = {
  input: ResolveInput
  attempt: ResolveAttemptTracker
  /** One admin client per request, shared by the handler and the `onError` hook. */
  client: SupabaseClient
}

type ResolveTerminalOutcome =
  | "invalid_identifier"
  | "unknown_product"
  | "pending_submission"
  | "resolved"
  | "verdict_unknown"
  | "profile_ineligible"
  | "temporarily_unavailable"

/**
 * Attempt telemetry must not sit on the response path (F11), but the attempt row is
 * INSERTed by `recordScanResolveAttempt` and then UPDATEd by `completeScanResolveAttempt`,
 * so the two writes still have to run in order. Two separate `after` calls would NOT give
 * that: `AfterContext.addCallback` pushes each callback into a p-queue constructed with
 * p-queue's default `concurrency: Infinity`
 * (node_modules/next/dist/server/after/after-context.js), so callbacks are only *started*
 * in enqueue order and then run concurrently — the UPDATE could overtake its INSERT and
 * the completion would be silently lost (both helpers are fail-open).
 *
 * So the writes are collected here and drained by a single `after` callback that awaits
 * them one at a time. Registering that drain on the first write is safe because `after`
 * callbacks only run once the response has been sent
 * (`AfterContext.runCallbacksOnClose`), by which point the completion is already queued.
 */
function scheduleAttemptWrite(
  attempt: ResolveAttemptTracker,
  runAfter: ScanAfter,
  write: () => Promise<void>,
) {
  attempt.telemetryWrites.push(write)
  if (attempt.telemetryDrainScheduled) return
  attempt.telemetryDrainScheduled = true
  try {
    runAfter(async () => {
      for (let index = 0; index < attempt.telemetryWrites.length; index += 1) {
        await attempt.telemetryWrites[index]()
      }
    })
  } catch (error) {
    // `after()` throws synchronously when there is no request store or `waitUntil` (e.g. a
    // misconfigured runtime) — telemetry scheduling must stay fail-open like the writes
    // themselves, never turn an otherwise-resolved scan into a 503.
    console.warn("[scan] telemetry scheduling failed", error)
  }
}

/**
 * Shared by the handler's normal-completion calls and the wrapper's `onError` hook (the
 * catch-all's own completion, for a throw mid-handler) — same guard, same shape, one place.
 */
function completeResolveAttempt(
  deps: ScanResolveRouteDeps,
  runAfter: ScanAfter,
  client: SupabaseClient,
  attempt: ResolveAttemptTracker,
  terminalOutcome: ResolveTerminalOutcome,
  stage: ScanResolveFailureStage | null,
) {
  if (!attempt.attemptId) return
  const completion = {
    attemptId: attempt.attemptId,
    lookupOutcome: attempt.lookupOutcome,
    terminalOutcome,
    matchedProductId: attempt.matchedProductId,
    failureStage: stage,
  }
  scheduleAttemptWrite(attempt, runAfter, () =>
    deps.completeScanResolveAttempt(
      client,
      completion,
      deps.captureScanException ?? captureScanException,
    ),
  )
}

export function createScanResolveRouteHandler(deps: ScanResolveRouteDeps) {
  const parseBody = parseJsonBody(resolveBodySchema)
  const runAfter: ScanAfter = deps.after ?? after

  return createScanRoute<ResolveRouteBody>({
    route: "resolve",
    deps,
    parse: async (request) => {
      const parsed = await parseBody(request)
      if (!parsed.ok) return parsed
      return {
        ok: true,
        body: {
          input: parsed.body,
          client: deps.createAdminClient(),
          attempt: {
            attemptId: null,
            startedAt: new Date().toISOString(),
            lookupOutcome: null,
            matchedProductId: null,
            failureStage: "identifier_lookup",
            telemetryWrites: [],
            telemetryDrainScheduled: false,
          },
        },
      }
    },
    failureReason: "resolve_failed",
    onError: async (_error, ctx) => {
      const { attempt, client } = ctx.body
      completeResolveAttempt(
        deps,
        runAfter,
        client,
        attempt,
        "temporarily_unavailable",
        attempt.failureStage,
      )
    },
    handler: async (ctx) => {
      const { input, attempt, client } = ctx.body
      const userId = ctx.userId

      const unknownProduct = (type: "ean", value: string): ScanResolveResult => ({
        kind: "unknown_product",
        identifier: { type, value },
        categories: PERSONAL_PLAN_PRODUCT_CATEGORIES.map((key) => ({
          key,
          label: CATEGORY_COPY[key].label,
        })),
      })

      const completeAttempt = (
        terminalOutcome: ResolveTerminalOutcome,
        stage: ScanResolveFailureStage | null,
      ) => completeResolveAttempt(deps, runAfter, client, attempt, terminalOutcome, stage)

      let productId: string
      let category: PersonalPlanCategory

      if (input.identifier) {
        const identifier = input.identifier
        // Barcode attempts are started before validation; productId resolution below
        // originates in the search sheet and intentionally has no barcode telemetry.
        const attemptId = deps.createScanResolveAttemptId()
        attempt.attemptId = attemptId
        scheduleAttemptWrite(attempt, runAfter, () =>
          deps.recordScanResolveAttempt(
            client,
            {
              attemptId,
              userId,
              identifierType: identifier.type,
              rawValue: identifier.value,
              createdAt: attempt.startedAt,
            },
            deps.captureScanException ?? captureScanException,
          ),
        )

        const validation = deps.validateEanInput(identifier.value)
        if (!validation.ok) {
          attempt.lookupOutcome = "invalid"
          completeAttempt("invalid_identifier", "identifier_lookup")
          return scanFail("invalid_identifier", 400)
        }
        const normalizedValue = normalizeIdentifierValue(validation.value)

        const hit = await deps.lookupCatalogProductByIdentifier(client, {
          type: identifier.type,
          value: identifier.value,
        })

        // F15: bind the match to the attempt before the quarantine await below, so a
        // failure in there still completes with the product the identifier matched.
        attempt.matchedProductId = hit?.productId ?? null
        attempt.lookupOutcome = hit ? "hit" : "miss"

        // Ruling R7: a disposition-quarantined product (identity_ambiguous, retired, or
        // awaiting exact analysis — personal_plan_product_search_dispositions) is not
        // resolvable via scan either. The research/review pipeline is the right place to
        // untangle it; treat it as though the identifier lookup missed.
        attempt.failureStage = "quarantine_lookup"
        const quarantined =
          hit !== null && (await deps.isProductSearchQuarantined(client, hit.productId))
        if (quarantined) attempt.lookupOutcome = "quarantined"

        if (!hit || quarantined) {
          // The catalog is the authority: an open research submission only decides what
          // this scan shows once the EAN is genuinely not (usably) in the catalog. A
          // cataloged product must still reach its verdict while a submission is open.
          attempt.failureStage = "submission_lookup"
          const pending = await deps.findOpenScanSubmission(client, userId, normalizedValue)
          if (pending) {
            completeAttempt("pending_submission", null)
            return scanOk({
              kind: "pending_submission",
              submissionId: pending.submissionId,
              headline: SCAN_PENDING_SUBMISSION_HEADLINE,
              status: pending.status,
            } satisfies ScanResolveResult)
          }
          completeAttempt("unknown_product", null)
          return scanOk(unknownProduct(identifier.type, normalizedValue))
        }

        productId = hit.productId
        category = hit.category
      } else {
        // Schema refine() guarantees productId is set on this branch.
        const active = await deps.loadActiveProductById(client, input.productId as string)
        if (!active) return scanFail("product_not_found", 404)
        if (await deps.isProductSearchQuarantined(client, active.id)) {
          return scanFail("product_not_found", 404)
        }
        productId = active.id
        category = active.category
      }

      attempt.failureStage = "profile_context"
      const context = await deps.loadScanEvaluationContext(client, userId)
      if (!context) {
        completeAttempt("profile_ineligible", null)
        return scanFail("profile_missing", 409)
      }

      attempt.failureStage = "decision"
      const decision = context.snapshot.decisions.find((entry) => entry.category === category)
      if (!decision) throw new Error("scan_resolve_decision_missing")

      // T8: facts-loading + `buildScanVerdict` extracted to `load-scan-verdict.ts`, shared
      // with `/api/scan/reveal` — see that module for why. The `onEnterVerdictStage`
      // callback (fix round 1, F4) restores the original two-stage telemetry split: a
      // throw during facts-loading still reports "product_facts", a throw inside
      // `buildScanVerdict` itself now reports "verdict" again instead of collapsing both
      // into one stage.
      attempt.failureStage = "product_facts"
      const verdict = await loadScanVerdictForProduct(
        client,
        deps,
        category,
        productId,
        decision,
        context,
        () => {
          attempt.failureStage = "verdict"
        },
      )

      // One catalog read covers the sheet's product header and the alternatives' brand +
      // purchase link — neither exists on the authority facts the verdict is built from.
      const alternativeIds =
        verdict.kind === "in_catalog"
          ? verdict.alternatives.map((alternative) => alternative.productId)
          : []
      attempt.failureStage = "post_verdict_load"
      const [savedState, presentationRows] = await Promise.all([
        deps.loadScanSavedState(client, userId, productId),
        deps.loadPresentationRows(client, [productId, ...alternativeIds]),
      ])

      const scannedRow = presentationRows.find((row) => row.id === productId)
      if (!scannedRow) throw new Error("scan_resolve_presentation_row_missing")

      // Ruling R7 applies to what we RECOMMEND too, not just to what we resolve. The
      // Stage-3 candidate loader has no disposition filter, so a quarantined product could
      // be offered as an alternative on a surface that refuses to resolve or save it. Done
      // on the final (≤3) list rather than on the candidate pool: same outcome, one small
      // keyed query instead of filtering the whole catalog.
      attempt.failureStage = "alternative_filter"
      const eligibleVerdict = await withEligibleAlternatives(verdict, (ids) =>
        deps.loadQuarantinedProductIdsAmong(client, ids),
      )

      attempt.failureStage = "response_build"
      const productHeader = toScanProductHeader(scannedRow)
      const resolvedOutcome = (): ResolveTerminalOutcome =>
        eligibleVerdict.kind === "in_catalog" && eligibleVerdict.verdict === "unknown"
          ? "verdict_unknown"
          : "resolved"

      // Freemium scanner-first (T8): masking only ever applies to an `in_catalog`
      // verdict's alternatives, and only with the flag on — flag-off or a `not_needed`
      // verdict never call `resolvePaidAccess` at all, so neither performs a billing
      // lookup it didn't before T8 (mirrors the F1a "inert with the flag off" pattern on
      // `hasFreemiumPaidAccess`). Premium falls through to the untouched full path below.
      //
      // Fail-closed constraint (fix round 1, F3): `resolvePaidAccess` returning
      // "unavailable" 503s every `in_catalog` verdict here, premium included — an
      // entitlement-source outage must never be treated as "unmask," so this is the one
      // case where "flag on + premium ⇒ byte-identical" does not hold.
      if (isFreemiumScannerFirstEnabled() && eligibleVerdict.kind === "in_catalog") {
        const access = await deps.resolvePaidAccess(userId)
        if (access === "unavailable") throw new Error("scan_resolve_entitlements_unavailable")

        // Fix round 1 (F2): the brief names `getEntitlements(...).canSeeAlternatives` as
        // the deciding signal, not the raw `resolvePaidAccess` result — same module the
        // reveal route now also branches on, so a future ruling that grants some free
        // cohort alternatives only has one place to change.
        const entitlements = await getEntitlements(userId, {
          hasAppAccess: async () => access === "allowed",
          readFreeRevealUsed: (id) => deps.hasUsedFreeReveal(client, id),
        })

        if (!entitlements.canSeeAlternatives) {
          const maskedResult: ScanMaskedVerdictResult = {
            ...maskScanVerdictPayload(eligibleVerdict),
            product: productHeader,
            snapshotSource: context.snapshotSource,
            savedState,
            freeRevealAvailable: entitlements.freeRevealAvailable,
          }
          completeAttempt(resolvedOutcome(), null)
          return scanOk(maskedResult)
        }
      }

      const result: ScanResolvedVerdictResult = {
        ...presentScanVerdictPayload(eligibleVerdict, presentationRows),
        product: productHeader,
        snapshotSource: context.snapshotSource,
        savedState,
      }
      completeAttempt(resolvedOutcome(), null)
      return scanOk(result)
    },
  })
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
  if (error) throw new Error("scan_resolve_product_lookup_failed")
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
  if (error) throw new Error("scan_resolve_presentation_lookup_failed")
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

export const POST = createScanResolveRouteHandler({
  getUserId: async () => (await (await createClient()).auth.getUser()).data.user?.id ?? null,
  checkRateLimit,
  createAdminClient,
  validateEanInput,
  findOpenScanSubmission,
  createScanResolveAttemptId,
  recordScanResolveAttempt,
  completeScanResolveAttempt,
  lookupCatalogProductByIdentifier,
  isProductSearchQuarantined,
  loadQuarantinedProductIdsAmong,
  loadScanEvaluationContext,
  loadScanProductFacts,
  loadRecommendationCandidates: loadStage3RecommendationCandidatesByRole,
  loadScanSavedState,
  buildScanVerdict,
  loadActiveProductById,
  loadPresentationRows,
  resolvePaidAccess: resolvePaidAccessForCurrentUser,
  hasUsedFreeReveal,
})

/**
 * Separate from `getUserId`: the shared scan wrapper only forwards a userId string to the
 * handler (`ScanRouteContext`), so the email + `access_kind` `resolvePaidAppAccess` needs
 * (mirrors the C1/F1 fixes on the save/wishlist guard, access.ts) have no path from
 * `getUserId` alone without a second `auth.getUser()` read — a deliberate, request-scoped
 * read, same as `requirePremiumAccessForCurrentUser` on the save route.
 */
async function resolvePaidAccessForCurrentUser(userId: string): Promise<FreemiumAccessResult> {
  const { data } = await (await createClient()).auth.getUser()
  return resolvePaidAppAccess(
    userId,
    data.user?.email,
    isPersonalPlanFieldTestGuest(data.user ?? {}),
  )
}
