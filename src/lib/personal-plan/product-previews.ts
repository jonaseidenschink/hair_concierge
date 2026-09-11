import type { SupabaseClient } from "@supabase/supabase-js"

import type {
  InitialNeedPlanSnapshot,
  PlanCategoryDecision,
  PlanProductRole,
} from "@/lib/personal-plan/types"
import type {
  Stage1DirectAcceptanceAvailability,
  Stage1ProductExampleCommerce,
  Stage1ProductExamplePreviewResponse,
  Stage1ProductExampleReasoning,
  Stage1ProductExampleRolePreview,
} from "@/lib/personal-plan/product-preview-contract"

import { frequencyLabel, presentationFor } from "./decision-presentation"
import { CATEGORY_ROLE_POLICIES, stage1ExampleVerdictAllowed } from "./products/authorities"
import {
  loadStage3RecommendationCandidates,
  type Stage3RecommendationCandidateSelection,
} from "./products/authority/catalog-facts"
import type { Stage3CategoryProductFacts } from "./products/authority/contracts"
import { evaluateStage3Authority } from "./products/authority/evaluate"
import { stage3DecisionKey, type PersonalPlanCategory } from "./products/contracts"
import { presentCatalogCommerce } from "./routine/commerce"

export type Stage1ProductExamplePreviewCandidateLoader = (
  input: Stage3RecommendationCandidateSelection,
) => Promise<Stage3CategoryProductFacts[]>

type RoleTask = {
  category: PersonalPlanCategory
  decision: PlanCategoryDecision
  role: PlanProductRole
}

/**
 * Every category's derived candidate facts are identical for every one of
 * its roles — EXCEPT Shampoo: `selectShampooSpec` (catalog-facts.ts) filters
 * each candidate's spec rows by the role-specific expected bucket/scalp
 * route (see `expectedShampooBucket`), so `shampoo_everyday` and
 * `shampoo_dandruff` can legitimately see different `spec` data for the same
 * product. Only Shampoo needs a per-role candidate load; every other
 * category can share one load across all of its role tasks.
 */
export const ROLE_SENSITIVE_CANDIDATE_CATEGORIES: ReadonlySet<PersonalPlanCategory> = new Set([
  "shampoo",
])

function candidateCacheKey(task: RoleTask): string {
  return ROLE_SENSITIVE_CANDIDATE_CATEGORIES.has(task.category)
    ? `${task.category}:${task.role}`
    : task.category
}

/**
 * Every role the Idealplan previews for this snapshot — as a recommendation OR
 * as a fallback card, both of which carry the same decision key.
 *
 * Only categories that actually render a Stage 1 card produce a preview;
 * deferred and not-needed decisions never surface one.
 */
function stage1PreviewRoleTasks(snapshot: InitialNeedPlanSnapshot): RoleTask[] {
  const decisions = new Map(snapshot.decisions.map((decision) => [decision.category, decision]))
  const roleTasks: RoleTask[] = []
  for (const category of snapshot.renderedOrder) {
    const decision = decisions.get(category)
    if (!decision?.target || decision.target.category !== category) continue
    if (decision.needTier !== "basis" && decision.needTier !== "optional") continue
    if (decision.resolution === "deferred_until_post_plan_onboarding") continue
    const allowedRoles = CATEGORY_ROLE_POLICIES[category].allowedRoles
    for (const role of decision.roles) {
      if (allowedRoles.includes(role as never)) roleTasks.push({ category, decision, role })
    }
  }
  return roleTasks
}

/**
 * The Stage-3 decision keys the Idealplan previewed, i.e. exactly the roles a
 * client could have echoed as `seenRoles`.
 *
 * Direct acceptance uses this to tell its two deferral reasons apart: a role
 * the client did not echo was either previewed but unbuyable (`no_product`, a
 * fallback card) or never previewed at all (`refinement_required`). Sharing
 * this one predicate with the preview computation above is what keeps the two
 * sides from drifting.
 */
export function stage1PreviewedRoleDecisionKeys(
  snapshot: InitialNeedPlanSnapshot,
): ReadonlySet<string> {
  return new Set(
    stage1PreviewRoleTasks(snapshot).map((task) =>
      stage3DecisionKey(task.category, task.role, null),
    ),
  )
}

export async function computeStage1ProductExamplePreviews(input: {
  personalPlanId: string
  sourceNeedVersionId: string
  snapshot: InitialNeedPlanSnapshot
  loadCandidates: Stage1ProductExamplePreviewCandidateLoader
}): Promise<Stage1ProductExamplePreviewResponse> {
  const roleTasks = stage1PreviewRoleTasks(input.snapshot)

  // One candidate load per category (Shampoo: per role — see
  // ROLE_SENSITIVE_CANDIDATE_CATEGORIES above), reused across every role
  // task that shares its cache key, instead of one load per role.
  const candidateLoadsByKey = new Map<string, Promise<Stage3CategoryProductFacts[]>>()
  const loadCandidatesForTask = (task: RoleTask): Promise<Stage3CategoryProductFacts[]> => {
    const key = candidateCacheKey(task)
    const cached = candidateLoadsByKey.get(key)
    if (cached) return cached
    const promise = input.loadCandidates({
      category: task.category,
      hairThickness: input.snapshot.profile.hair.thickness,
      role: task.role,
      shampooTarget: task.decision.target?.category === "shampoo" ? task.decision.target : null,
      conditionerTarget:
        task.decision.target?.category === "conditioner" ? task.decision.target : null,
      completeCatalog: true,
    })
    candidateLoadsByKey.set(key, promise)
    return promise
  }

  const previews = await Promise.all(
    roleTasks.map((task) => computeRolePreview(task, input, loadCandidatesForTask(task))),
  )
  return {
    schemaVersion: 2,
    personalPlanId: input.personalPlanId,
    sourceNeedVersionId: input.sourceNeedVersionId,
    sourceInputHash: input.snapshot.inputHash,
    previews,
    directAcceptance: resolveDirectAcceptanceAvailability(input.snapshot),
  }
}

/**
 * A deferred Stage-1 decision renders no card and gets no preview (see the
 * `deferred_until_post_plan_onboarding` skip in the role-task loop above). The
 * direct-acceptance defaults, however, must answer the deferred fact to
 * complete Stage 2 — and answering it can resolve the deferral into real roles.
 * Those roles reach the server's Stage-3 evaluation but are absent from the
 * client's `seenRoles`, so the accept contract rejects the whole request.
 *
 * Rather than let that cohort meet a 409, the payload says up front that they
 * need the refinement.
 *
 * Today exactly one deferral behaves this way: Scalp Care deferred on a
 * reported irritation whose detail is still unknown
 * (`categories/scalp-care.ts:81-95`, `deferredFacts: ["scalp_irritation_detail"]`).
 * The defaults answer it with `"normal"`
 * (`direct-acceptance/defaults.ts:41`), which skips the deferral branch and
 * falls through to role derivation. The predicates below mirror the role rules
 * that survive that `"normal"` answer:
 *
 *   - `scalp-care.ts:99-106`  scalp_comfort            ← oiliness === "dry"
 *     (the `mild_sensitive_or_itchy` half cannot fire under `"normal"`)
 *   - `scalp-care.ts:108-115` scalp_flake_oil_adjunct  ← oiliness === "oily"
 *     || oily_dandruff || dry_dandruff
 *   - `scalp-care.ts:117-120` scalp_comfort            ← dry_dandruff
 *   - `scalp-care.ts:122-128` density_claim_tonic      ← hair_loss_or_thinning
 *
 * `scalp_exfoliant` (`scalp-care.ts:130-137`) keys off `assessments.scalpBuildup`,
 * which the snapshot does not carry, so it is not mirrored here.
 *
 * This mirror is deliberately narrow. The joint invariant test
 * (`tests/personal-plan-direct-accept-seen-state-join.test.ts`) is the drift
 * net: any new divergence must fail there rather than reach users as a 409.
 */
function resolveDirectAcceptanceAvailability(
  snapshot: InitialNeedPlanSnapshot,
): Stage1DirectAcceptanceAvailability {
  const blockedCategories = directAcceptanceRefinementRequiredCategories(snapshot)

  return blockedCategories.length === 0
    ? { available: true }
    : { available: false, reason: "refinement_required", blockedCategories }
}

/**
 * The categories the direct-acceptance defaults must NOT decide for this snapshot — see the
 * contract above.
 *
 * Exported because the post-purchase provisioning lane needs the same cohort. Direct
 * acceptance refuses the whole request for these users; the freemium buyer instead gets
 * everything else provisioned and only these categories left to the refinement (Nick's D1
 * ruling, fix round 1). Both readings must come from ONE predicate, or the cohort the
 * product refuses to guess for and the cohort provisioning skips would drift apart.
 */
export function directAcceptanceRefinementRequiredCategories(
  snapshot: InitialNeedPlanSnapshot,
): PersonalPlanCategory[] {
  const blockedCategories: PersonalPlanCategory[] = []

  const scalpCare = snapshot.decisions.find((decision) => decision.category === "scalp_care")
  const scalpCareDeferredOnIrritation =
    scalpCare?.resolution === "deferred_until_post_plan_onboarding" &&
    scalpCare.deferredFacts.includes("scalp_irritation_detail")
  if (scalpCareDeferredOnIrritation && defaultsWouldAddScalpCareRoles(snapshot)) {
    blockedCategories.push("scalp_care")
  }

  return blockedCategories
}

function defaultsWouldAddScalpCareRoles(snapshot: InitialNeedPlanSnapshot): boolean {
  const scalpConcerns = new Set(snapshot.profile.scalp.concerns)
  const oiliness = snapshot.profile.scalp.oiliness
  return (
    oiliness === "dry" ||
    oiliness === "oily" ||
    scalpConcerns.has("oily_dandruff") ||
    scalpConcerns.has("dry_dandruff") ||
    snapshot.profile.concerns.includes("hair_loss_or_thinning")
  )
}

async function computeRolePreview(
  task: RoleTask,
  input: {
    sourceNeedVersionId: string
    snapshot: InitialNeedPlanSnapshot
  },
  loadCandidates: Promise<Stage3CategoryProductFacts[]>,
): Promise<Stage1ProductExampleRolePreview> {
  const { category, decision, role } = task
  const authorityVersion = CATEGORY_ROLE_POLICIES[category].authorityVersion
  const decisionKey = stage3DecisionKey(category, role, null)
  const fallback = (): Stage1ProductExampleRolePreview => ({
    kind: "fallback",
    category,
    role,
    decisionKey,
    authorityVersion,
    fallback: "post_refinement",
  })

  try {
    const candidates = await loadCandidates
    const authorityInput = {
      category,
      authorityVersion,
      refinedVersionId: input.sourceNeedVersionId,
      refinedInputHash: input.snapshot.inputHash,
      subjectKey: `preview:${category}:${role}`,
      role,
      capturedProductId: null,
      subjectIdentity: null,
      categoryDecision: decision as never,
      coverage: input.snapshot.coverage,
      hairThickness: input.snapshot.profile.hair.thickness,
      productFacts: null,
      recommendationCandidates: candidates as never,
      heatCarrierCoverage: { carrierCategory: null, verifiedRoutes: [] },
    }
    const evaluation = evaluateStage3Authority(authorityInput)
    if (evaluation.status !== "known" || !evaluation.recommendation) return fallback()
    const selectedProductId = evaluation.recommendation.productId
    const selected = candidates.find((candidate) => candidate.productId === selectedProductId)
    const imageUrl = selected?.presentationImageUrl?.trim()
    if (!selected || !imageUrl) return fallback()
    if (evaluation.recommendationFactFingerprint !== selected.factFingerprint) return fallback()

    // Some authorities use the first verdict to describe an uncovered portfolio slot.
    // Evaluate the recommendation itself before exposing its presentation data.
    const selectedEvaluation = evaluateStage3Authority({
      ...authorityInput,
      productFacts: selected as never,
    })
    if (
      selectedEvaluation.status !== "known" ||
      (selectedEvaluation.verdict !== "ideal" && selectedEvaluation.verdict !== "supportive") ||
      !stage1ExampleVerdictAllowed(decision, selectedEvaluation.verdict)
    ) {
      return fallback()
    }

    const presentation = presentationFor(decision)
    if (!presentation) return fallback()
    const reasoning: Stage1ProductExampleReasoning = {
      productCriteria: presentation.productCriteria,
      fit: presentation.fit,
      frequency: frequencyLabel(decision.frequency, decision.executionState === "paused"),
    }
    const netContentValue = selected.netContentValue ?? null
    const netContentUnit = selected.netContentUnit ?? null
    const { availabilityLabel, affiliateDisclosure, priceLabel, productUrl } =
      presentCatalogCommerce({
        priceEur: selected.priceEur ?? null,
        currency: selected.currency ?? null,
        affiliateLink: selected.affiliateLink ?? null,
        purchaseLinkStatus: selected.purchaseLinkStatus ?? null,
        updatedAt: selected.priceCheckedAt ?? null,
      })
    const commerce: Stage1ProductExampleCommerce = {
      priceEur: selected.priceEur ?? null,
      purchaseLinkStatus: selected.purchaseLinkStatus ?? null,
      netContentValue,
      netContentUnit,
      netContentLabel:
        netContentValue !== null && netContentUnit !== null
          ? `${new Intl.NumberFormat("de-DE").format(netContentValue)} ${netContentUnit}`
          : null,
      priceLabel,
      availabilityLabel,
      productUrl,
      affiliateDisclosure,
    }

    return {
      kind: "recommendation",
      category,
      role,
      decisionKey,
      productId: selected.productId,
      productName: selected.displayName,
      imageUrl,
      verdict: selectedEvaluation.verdict,
      authorityVersion,
      factFingerprint: evaluation.recommendationFactFingerprint ?? selected.factFingerprint,
      commerce,
      reasoning,
    }
  } catch {
    return fallback()
  }
}

export function createSupabaseStage1ProductExamplePreviewCandidateLoader(
  client: SupabaseClient,
): Stage1ProductExamplePreviewCandidateLoader {
  return (input) => loadStage3RecommendationCandidates(client, input)
}
