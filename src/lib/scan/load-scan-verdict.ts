import type { SupabaseClient } from "@supabase/supabase-js"

import { ROLE_SENSITIVE_CANDIDATE_CATEGORIES } from "@/lib/personal-plan/product-previews"
import { CATEGORY_ROLE_POLICIES } from "@/lib/personal-plan/products/authorities"
import type {
  CategorySelectionContext,
  loadScanProductFacts,
  loadStage3RecommendationCandidatesByRole,
} from "@/lib/personal-plan/products/authority/catalog-facts"
import type { PersonalPlanCategory } from "@/lib/personal-plan/products/contracts"
import type { PlanCategoryDecision, PlanProductRole } from "@/lib/personal-plan/types"

import type { ScanEvaluationContext } from "./profile-context"
import { buildScanVerdict, isNotNeeded, type ScanRoleFacts } from "./resolve-verdict"
import type { ScanVerdictPayload } from "./types"

/**
 * The facts-loading + verdict-building step shared by `/api/scan/resolve`'s direct-
 * productId path and `/api/scan/reveal` (T8): given a category, an already-matched
 * productId, its category decision and the evaluation context, load per-role catalog
 * facts and hand them to `buildScanVerdict`. Extracted out of the resolve route so reveal
 * can never compute a different alternative list than the one resolve just masked — both
 * call this one function, not two hand-copies of the same orchestration that could drift.
 *
 * Behavior is verbatim what `resolve/route.ts`'s handler did inline before T8 (see its
 * git history) — this is a pure extraction, not a rewrite: same role-sensitivity check,
 * same not-needed short-circuit, same per-role Map, same `buildScanVerdict` input shape.
 */
export type LoadScanVerdictDeps = {
  loadScanProductFacts: typeof loadScanProductFacts
  loadRecommendationCandidates: typeof loadStage3RecommendationCandidatesByRole
  buildScanVerdict: typeof buildScanVerdict
}

export async function loadScanVerdictForProduct(
  client: SupabaseClient,
  deps: LoadScanVerdictDeps,
  category: PersonalPlanCategory,
  productId: string,
  decision: PlanCategoryDecision,
  context: ScanEvaluationContext,
  /**
   * T8 fix round 1 (F4): the pre-extraction code marked the attempt-telemetry failure
   * stage `"verdict"` once facts-loading finished and `buildScanVerdict` itself was about
   * to run. The extraction collapsed that into one `"product_facts"` stage for every
   * caller. Optional so `/api/scan/reveal` (which has no attempt-telemetry row) can omit
   * it; `/api/scan/resolve` passes a callback that restores the original two-stage split.
   */
  onEnterVerdictStage?: () => void,
): Promise<ScanVerdictPayload> {
  const shampooTarget =
    category === "shampoo" && decision.target?.category === "shampoo" ? decision.target : null
  const conditionerTarget =
    category === "conditioner" && decision.target?.category === "conditioner"
      ? decision.target
      : null

  /**
   * `buildScanVerdict` evaluates EVERY role of the decision, but a category's derived
   * facts are identical for all of its roles except Shampoo, where `selectShampooSpec`
   * picks the spec row by the role's expected bucket/scalp route. So mirror
   * `product-previews.ts`: one shared load for every other category, per-role facts for a
   * role-sensitive one — otherwise e.g. the dandruff role would be graded against facts
   * loaded for the everyday role.
   *
   * The candidate POOL is role-independent, so it is loaded exactly once for all roles and
   * only re-specced per role inside `loadStage3RecommendationCandidatesByRole` (F12). The
   * scanned product's own facts are still one small load per role.
   */
  const primaryRole = decision.roles[0] ?? CATEGORY_ROLE_POLICIES[category].allowedRoles[0]
  const roleSensitive = ROLE_SENSITIVE_CANDIDATE_CATEGORIES.has(category)
  const rolesToLoad = roleSensitive
    ? [...new Set<PlanProductRole>([primaryRole, ...decision.roles])]
    : [primaryRole]
  const hairThickness = context.snapshot.profile.hair.thickness
  const selectionContextFor = (role: PlanProductRole): CategorySelectionContext => ({
    hairThickness,
    role,
    shampooTarget,
    conditionerTarget,
  })

  const [productFactsByRole, candidatesByRole] = await Promise.all([
    Promise.all(
      rolesToLoad.map(
        async (role) =>
          [
            role,
            await deps.loadScanProductFacts(client, category, productId, selectionContextFor(role)),
          ] as const,
      ),
    ),
    isNotNeeded(decision)
      ? Promise.resolve(Object.fromEntries(rolesToLoad.map((role) => [role, []])))
      : deps.loadRecommendationCandidates(client, {
          category,
          hairThickness,
          shampooTarget,
          conditionerTarget,
          roles: rolesToLoad,
        }),
  ])
  const loadedFacts = new Map<PlanProductRole, ScanRoleFacts>(
    productFactsByRole.map(([role, productFacts]) => {
      const recommendationCandidates = candidatesByRole[role]
      if (!recommendationCandidates) throw new Error("scan_resolve_candidates_role_missing")
      return [role, { productFacts, recommendationCandidates }]
    }),
  )
  const primaryFacts = loadedFacts.get(primaryRole) as ScanRoleFacts

  onEnterVerdictStage?.()

  return deps.buildScanVerdict({
    category,
    decision,
    productFacts: primaryFacts.productFacts,
    recommendationCandidates: primaryFacts.recommendationCandidates,
    perRoleFacts: roleSensitive ? Object.fromEntries(loadedFacts) : undefined,
    coverage: context.snapshot.coverage,
    hairThickness: context.snapshot.profile.hair.thickness,
    // No Stage3ProductDraft exists for scan — mirrors product-previews.ts's no-draft
    // default for heat-carrier coverage instead of computing a real one.
    heatCarrierCoverage: { carrierCategory: null, verifiedRoutes: [] },
    refinedVersionId: context.refinedVersionId,
    refinedInputHash: context.refinedInputHash,
  })
}
