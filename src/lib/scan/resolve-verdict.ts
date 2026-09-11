import { CATEGORY_COPY, ROLE_COPY } from "@/components/personal-plan-products/stage3-product-copy"
import { presentationFor } from "@/lib/personal-plan/decision-presentation"
import { CATEGORY_ROLE_POLICIES } from "@/lib/personal-plan/products/authorities"
import type {
  Stage3AuthorityInput,
  Stage3CategoryProductFacts,
} from "@/lib/personal-plan/products/authority/contracts"
import { evaluateStage3Authority } from "@/lib/personal-plan/products/authority/evaluate"
import {
  candidateDimensionCoverage,
  comparisonDimensions,
  positionsOverlap,
  renderedDimensions,
  type Stage3FitComparisonDimension,
  type Stage3FitComparisonPosition,
} from "@/lib/personal-plan/products/comparison-dimensions"
import type { PersonalPlanCategory } from "@/lib/personal-plan/products/contracts"
import { buildStage3FitComparison } from "@/lib/personal-plan/products/fit-comparison"
import type {
  PlanCategoryDecision,
  PlanHairThickness,
  PlanPortfolioCoverageFact,
  PlanProductRole,
} from "@/lib/personal-plan/types"

import { selectBestRoleEvaluation, scanVerdictForEvaluation } from "./role-selection"
import type {
  ScanAlternative,
  ScanCoveredByEntry,
  ScanDimension,
  ScanInCatalogVerdictPayload,
  ScanNeedMode,
  ScanNotNeededVerdictPayload,
  ScanVerdictPayload,
} from "./types"
import {
  SCAN_COVERAGE_JOB_LABELS,
  SCAN_DEFERRED_HEADLINE,
  SCAN_NOT_NEEDED_REASON_COPY,
  SCAN_NOT_NEEDED_STATUS,
  SCAN_SUBTITLE_WITHOUT_TARGETS,
  SCAN_VERDICT_COPY,
  scanCriterionSubtitle,
  scanDeferredSubtitle,
  scanNotNeededHeadline,
  scanNotNeededSubtitle,
  scanTargetSubtitle,
} from "./verdict-labels"

/** The catalog facts one role is evaluated against: the scanned product plus its field. */
export type ScanRoleFacts = {
  productFacts: Stage3CategoryProductFacts | null
  recommendationCandidates: Stage3CategoryProductFacts[]
}

export type BuildScanVerdictInput = {
  category: PersonalPlanCategory
  decision: PlanCategoryDecision
  /** `null` only for the edge where a not-needed category is scanned without catalog facts. */
  productFacts: Stage3CategoryProductFacts | null
  recommendationCandidates: Stage3CategoryProductFacts[]
  /**
   * Per-role override of the two fields above, for the categories whose derived facts
   * genuinely differ by role. Today that is Shampoo only: `selectShampooSpec`
   * (catalog-facts.ts) picks each product's spec row by the role-specific expected
   * bucket/scalp route, so `shampoo_everyday` and `shampoo_dandruff` legitimately see
   * different `spec` data for the same product — mirrors
   * `ROLE_SENSITIVE_CANDIDATE_CATEGORIES` in `personal-plan/product-previews.ts`.
   *
   * Every role missing from this map (i.e. every role of every other category) falls back
   * to the shared `productFacts` / `recommendationCandidates` above.
   */
  perRoleFacts?: Partial<Record<PlanProductRole, ScanRoleFacts>>
  coverage: PlanPortfolioCoverageFact[]
  hairThickness: PlanHairThickness
  heatCarrierCoverage: {
    carrierCategory: Extract<PersonalPlanCategory, "leave_in" | "oil" | "heat_protectant"> | null
    verifiedRoutes: string[]
  }
  refinedVersionId: string
  refinedInputHash: string
}

export function buildScanVerdict(input: BuildScanVerdictInput): ScanVerdictPayload {
  if (isNotNeeded(input.decision)) return notNeededPayload(input)
  return inCatalogPayload(input)
}

/**
 * A category with no target to compare the scanned product against: either genuinely
 * not needed, or not decided yet. Both take this branch; `needMode` keeps them apart so
 * the headline never claims a need verdict the decision has not reached.
 *
 * Exported because the resolve route uses the same predicate to skip an unnecessary
 * full-catalog candidate load — one definition, so the two can never drift apart.
 */
export function isNotNeeded(decision: PlanCategoryDecision): boolean {
  if (decision.needTier === "not_needed") return true
  return (
    decision.target === null && decision.needTier !== "basis" && decision.needTier !== "optional"
  )
}

/**
 * Only a settled `needTier: "not_needed"` is a real "you don't need this". Everything
 * else reaching this branch is a decision still open — a deferred resolution, or a null
 * tier with no target (scalp care awaiting buildup, deep cleansing awaiting product load).
 */
function needMode(decision: PlanCategoryDecision): ScanNeedMode {
  return decision.needTier === "not_needed" ? "not_needed" : "deferred"
}

/* -------------------------------------------------------------- not_needed */

function notNeededPayload(input: BuildScanVerdictInput): ScanNotNeededVerdictPayload {
  const mode = needMode(input.decision)
  return {
    kind: "not_needed",
    mode,
    status: SCAN_NOT_NEEDED_STATUS,
    headline: mode === "deferred" ? SCAN_DEFERRED_HEADLINE : scanNotNeededHeadline(input.category),
    subtitle:
      mode === "deferred"
        ? scanDeferredSubtitle(input.category)
        : scanNotNeededSubtitle(input.category),
    reasons: notNeededReasons(input.decision),
    dimensions: productOnlyDimensions(input),
    coveredBy: coveredBy(input.category, input.coverage),
  }
}

function notNeededReasons(decision: PlanCategoryDecision): string[] {
  const rendered = decision.reasons
    .map((reason) => SCAN_NOT_NEEDED_REASON_COPY[reason.id])
    .filter((copy): copy is string => copy !== undefined)
  return [...new Set(rendered)]
}

function coveredBy(
  category: PersonalPlanCategory,
  coverage: readonly PlanPortfolioCoverageFact[],
): ScanCoveredByEntry[] {
  const entries: ScanCoveredByEntry[] = []
  const seen = new Set<string>()
  for (const fact of coverage) {
    if (fact.outcome !== "owned" && fact.outcome !== "shared") continue
    const involved = [...fact.primaryCategories, ...fact.supportingCategories]
    if (!involved.includes(category)) continue
    const covering = [...new Set(fact.primaryCategories)].filter((entry) => entry !== category)
    if (covering.length === 0) continue
    const entry = {
      label: covering.map((item) => CATEGORY_COPY[item].label).join(" + "),
      detail: SCAN_COVERAGE_JOB_LABELS[fact.job] ?? null,
    }
    const key = `${entry.label}|${entry.detail}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(entry)
  }
  return entries
}

/**
 * Ruling R2: a category with no need has no target, so the bars show only where the
 * scanned product sits. Some axes carry a target that does not come from the category
 * decision (hair thickness, verified heat protection); those are stripped here so the
 * sheet never implies a target for a category the profile does not need.
 */
function productOnlyDimensions(input: BuildScanVerdictInput): ScanDimension[] {
  const role = input.decision.roles[0] ?? CATEGORY_ROLE_POLICIES[input.category].allowedRoles[0]
  if (!role) return []
  const facts = factsForRole(input, role).productFacts
  if (!facts) return []
  const authorityInput = scanAuthorityInput(input, role)
  const dimensions = renderedDimensions(
    comparisonDimensions(authorityInput, [
      {
        product: {
          productId: facts.productId,
          displayName: facts.displayName,
          category: facts.category,
          role,
          source: "current",
        },
        facts,
      },
    ]),
  )
  return dimensions.map((dimension) =>
    scanDimension(dimension, facts.productId, { withoutTarget: true }),
  )
}

/* ------------------------------------------------------------- in_catalog */

function inCatalogPayload(input: BuildScanVerdictInput): ScanInCatalogVerdictPayload {
  const best = selectBestRoleEvaluation(
    input.decision.roles.flatMap((role) => {
      // Role-sensitive categories carry their own facts per role (see `perRoleFacts`).
      const facts = factsForRole(input, role).productFacts
      if (!facts) return []
      const authorityInput = scanAuthorityInput(input, role)
      const evaluation = evaluateStage3Authority(authorityInput)
      const criteria =
        evaluation.status === "known" || evaluation.status === "unknown" ? evaluation.criteria : []
      return [
        {
          role,
          evaluation,
          coverage: candidateDimensionCoverage(authorityInput, facts, criteria),
        },
      ]
    }),
  )

  const facts = best ? factsForRole(input, best.role).productFacts : null
  if (!best || !facts) return unclearPayload(input)

  const authorityInput = scanAuthorityInput(input, best.role)
  const comparison = buildStage3FitComparison(authorityInput, best.evaluation)
  const dimensions = renderedDimensions(comparison.dimensions).map((dimension) =>
    scanDimension(dimension, facts.productId, { withoutTarget: false }),
  )
  const verdict = scanVerdictForEvaluation(best.evaluation)
  const copy = SCAN_VERDICT_COPY[verdict]
  const narrative = presentationFor(input.decision)

  return {
    kind: "in_catalog",
    verdict,
    verdictLabel: copy.label,
    verdictTitle: copy.title,
    status: copy.status,
    subtitle: subtitleFor(best.coverage, dimensions.length > 0),
    evaluatedRole: best.role,
    evaluatedRoleLabel: ROLE_COPY[best.role]?.label ?? null,
    dimensions,
    criteria:
      best.evaluation.status === "known" || best.evaluation.status === "unknown"
        ? best.evaluation.criteria
        : [],
    coverage: best.coverage,
    fitNarrative: narrative
      ? { productCriteria: narrative.productCriteria, fit: narrative.fit }
      : null,
    // Ruling R12: alternatives show on every in_catalog verdict, `ideal` included — a
    // fitting product is not a reason to hide what else would fit.
    alternatives: alternativesFrom(comparison),
  }
}

/** Nothing evaluable: a needed category whose roles are not resolved yet, or no facts. */
function unclearPayload(input: BuildScanVerdictInput): ScanInCatalogVerdictPayload {
  const copy = SCAN_VERDICT_COPY.unknown
  const narrative = presentationFor(input.decision)
  return {
    kind: "in_catalog",
    verdict: "unknown",
    verdictLabel: copy.label,
    verdictTitle: copy.title,
    status: copy.status,
    subtitle: SCAN_SUBTITLE_WITHOUT_TARGETS,
    evaluatedRole: null,
    evaluatedRoleLabel: null,
    dimensions: [],
    criteria: [],
    coverage: null,
    fitNarrative: narrative
      ? { productCriteria: narrative.productCriteria, fit: narrative.fit }
      : null,
    alternatives: [],
  }
}

function subtitleFor(
  coverage: { matches: number; total: number } | null,
  hasDimensions: boolean,
): string {
  if (!coverage || coverage.total === 0) return SCAN_SUBTITLE_WITHOUT_TARGETS
  return hasDimensions
    ? scanTargetSubtitle(coverage.matches, coverage.total)
    : scanCriterionSubtitle(coverage.matches, coverage.total)
}

function alternativesFrom(
  comparison: ReturnType<typeof buildStage3FitComparison>,
): ScanAlternative[] {
  const presentationById = new Map(
    comparison.products.map((product) => [product.productId, product]),
  )
  return comparison.alternatives.map((candidate) => {
    const product = presentationById.get(candidate.productId)
    return {
      productId: candidate.productId,
      displayName: product?.displayName ?? candidate.recommendation.displayName,
      imageUrl: product?.presentationImageUrl ?? null,
      priceLabel: product?.presentation?.priceLabel ?? null,
      netContentLabel: product?.presentation?.netContentLabel ?? null,
      verdict: candidate.verdict,
      verdictLabel: SCAN_VERDICT_COPY[candidate.verdict].label,
      // T8: already computed by `buildStage3FitComparison` — carried through for the
      // free-tier masked serializer only, see `ScanAlternative.criteria`.
      criteria: candidate.criteria,
    }
  })
}

/* ----------------------------------------------------------------- shared */

function factsForRole(input: BuildScanVerdictInput, role: PlanProductRole): ScanRoleFacts {
  return (
    input.perRoleFacts?.[role] ?? {
      productFacts: input.productFacts,
      recommendationCandidates: input.recommendationCandidates,
    }
  )
}

function scanAuthorityInput(
  input: BuildScanVerdictInput,
  role: PlanProductRole,
): Stage3AuthorityInput {
  const { productFacts: facts, recommendationCandidates } = factsForRole(input, role)
  return {
    category: input.category,
    authorityVersion: CATEGORY_ROLE_POLICIES[input.category].authorityVersion,
    refinedVersionId: input.refinedVersionId,
    refinedInputHash: input.refinedInputHash,
    subjectKey: `scan:${input.category}:${role}`,
    role,
    capturedProductId: null,
    subjectIdentity: facts
      ? {
          kind: "catalog_product",
          productId: facts.productId,
          displayName: facts.displayName,
          category: facts.category,
          imageUrl: facts.presentationImageUrl ?? null,
        }
      : null,
    categoryDecision: input.decision as never,
    coverage: input.coverage,
    productFacts: facts,
    recommendationCandidates,
    hairThickness: input.hairThickness,
    heatCarrierCoverage: input.heatCarrierCoverage,
  }
}

function stopIds(position: Stage3FitComparisonPosition | null): string[] {
  if (!position || position.kind === "unknown") return []
  return position.kind === "position" ? [position.stopId] : [...position.stopIds]
}

function scanDimension(
  dimension: Stage3FitComparisonDimension,
  productId: string,
  options: { withoutTarget: boolean },
): ScanDimension {
  const productPosition =
    dimension.productPositions.find((entry) => entry.productId === productId)?.position ?? null
  const targetPosition = options.withoutTarget ? null : dimension.targetPosition
  const targetStopIds = stopIds(targetPosition)
  const productStopIds = stopIds(productPosition)

  return {
    dimensionId: dimension.dimensionId,
    label: dimension.label,
    stops: dimension.stops.map((stop) => ({ stopId: stop.stopId, label: stop.label })),
    targetStopIds,
    productStopIds,
    state: dimensionState(targetPosition, productPosition),
  }
}

function dimensionState(
  target: Stage3FitComparisonPosition | null,
  product: Stage3FitComparisonPosition | null,
): ScanDimension["state"] {
  if (!target || target.kind === "unknown") return "no_target"
  if (!product || product.kind === "unknown") return "unknown"
  return positionsOverlap(product, target) ? "in_target" : "outside_target"
}
