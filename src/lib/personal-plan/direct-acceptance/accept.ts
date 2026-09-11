import { computeNeedPlan } from "../compute-stage1"
import type {
  Stage2PersistedDraft,
  Stage2RefinementPersistence,
} from "../persistence/stage2-refinement-service"
import { PERSONAL_PLAN_STAGE1_COMPUTATION_VERSION } from "../persistence/stage1-service"
import {
  directAcceptanceRefinementRequiredCategories,
  stage1PreviewedRoleDecisionKeys,
} from "../product-previews"
import type {
  Stage3AuthorityEvaluation,
  Stage3AuthoritySemanticIntent,
} from "../products/authority/contracts"
import type {
  PersonalPlanCategory,
  Stage3DecisionDeferralReason,
} from "../products/contracts"
import type { Stage3AuthorityProductionGateway } from "../products/production-persistence-gateway"
import { createPersistedStage2RefinementGateway } from "../refinement/production-persistence-gateway"
import { buildAssumedAnswerProvenance } from "../refinement/answer-provenance"
import { semanticHash } from "../routine/canonicalize"

import {
  buildDirectAcceptanceStage2Defaults,
  type DirectAcceptanceStage2Defaults,
} from "./defaults"

/**
 * Direct acceptance drives the real Stage-2 → Stage-4 machinery headlessly with
 * a synthetic complete Stage-2 answer set. It never writes a parallel routine:
 * the existing refinement, product-draft, portfolio, compiler and activation
 * paths stay the only writers.
 */

export type DirectAcceptanceErrorCode =
  | "stage_not_available"
  | "seen_state_stale"
  | "recommendation_unavailable"
  | "conflict"
  | "acceptance_not_ready"
  /** A real Stage-2 refinement is already under way; accepting would discard it. */
  | "refinement_in_progress"
  /** The plan already has an active Routine that direct acceptance did not create. */
  | "plan_already_accepted"

export class DirectAcceptanceError extends Error {
  constructor(
    public readonly code: DirectAcceptanceErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = "DirectAcceptanceError"
  }
}

/**
 * The canonical per-role seen-state entry. `decisionKey` is the Stage-3
 * decision subject key (`decision:<category>:<role>:gap`), which is also the
 * authority evaluation's `subjectKey`. Price is deliberately outside the
 * fingerprint: the pinned thing is the product, not its price.
 */
export type DirectAcceptanceSeenRole = {
  decisionKey: string
  productId: string
  factFingerprint: string
}

export type AcceptIdealPlanInput = {
  seenRoles: readonly DirectAcceptanceSeenRole[]
  /**
   * Who chose the products (freemium-scanner-first T14).
   *
   * - `"seen"` (default, and the ONLY value the public `/api/personal-plan/accept-ideal-plan`
   *   route can produce — its body schema is `.strict()` and has no such field): the
   *   consent contract this module was built for. Nothing is planned that the person did
   *   not look at, and a mismatch between what they saw and what the server evaluates is
   *   `seen_state_stale`.
   * - `"server_recommended"`: server-internal post-purchase provisioning, where there is
   *   no Idealplan screen to have seen. A Premium-sheet buyer is promised a live Routine
   *   the moment they pay (plan §"Inherited from evidence or contract": immediate
   *   post-purchase real content, from the approved prototype journey), so the server
   *   plans its OWN current recommendation for every role that has a buyable one and
   *   leaves the rest honestly uncovered. `seenRoles` must be empty in this mode — a
   *   caller that has seen-state should use `"seen"`.
   */
  roleSelection?: "seen" | "server_recommended"
}

export type AcceptIdealPlanResult = {
  status: "accepted"
  personalPlanId: string
  refinedVersionId: string
  productDraftId: string
  productPortfolioVersionId: string
  next: { stage: 4; href: string }
}

export type DirectAcceptanceStage3Gateway = Pick<
  Stage3AuthorityProductionGateway,
  "loadOrCreate" | "evaluateDecisions" | "resolveDecisions" | "complete"
>

export type DirectAcceptancePlanStateReader = {
  loadActiveRoutineVersionId(input: {
    userId: string
    personalPlanId: string
  }): Promise<string | null>
}

export type AcceptIdealPlanDeps = {
  userId: string
  flags: { stage2Enabled: boolean; stage3Enabled: boolean; stage4Enabled: boolean }
  refinementPersistence: Stage2RefinementPersistence
  planState: DirectAcceptancePlanStateReader
  stage3Gateway: DirectAcceptanceStage3Gateway
}

/**
 * Turns the server's own authority evaluations into one intent per role.
 *
 * Two kinds of role, one pass:
 *
 *   - a role the client SAW is pinned exactly as before — same decision key,
 *     same product, same fact fingerprint, or `seen_state_stale`. Nothing is
 *     bought that the person did not look at.
 *   - a role the client did NOT see is never planned. The server derives an
 *     explicit `leave_uncovered` decision for it and records WHY it deferred
 *     (see `Stage3DecisionDeferralReason`), so acceptance succeeds with an
 *     honest gap instead of failing the whole request.
 *
 * A seen role the server does not evaluate at all stays `seen_state_stale`:
 * that is the preview payload contradicting the server, not a gap.
 */
export function buildDirectAcceptanceIntents(
  evaluations: readonly Stage3AuthorityEvaluation[],
  seenRoles: readonly DirectAcceptanceSeenRole[],
  /**
   * Decision keys the Idealplan previewed — see `deferralReasonFor`. Required:
   * a defaulted empty set would silently downgrade every deferral reason.
   */
  previewedRoleKeys: ReadonlySet<string>,
): Stage3AuthoritySemanticIntent[] {
  const seenByKey = new Map(seenRoles.map((role) => [role.decisionKey, role]))
  const evaluatedKeys = new Set(evaluations.map((evaluation) => evaluation.subjectKey))
  if (
    seenByKey.size !== seenRoles.length ||
    // One subject, one evaluation is a server invariant; a duplicate would make
    // the seen-state join ambiguous and produce two intents for one subject.
    evaluatedKeys.size !== evaluations.length ||
    seenRoles.some((role) => !evaluatedKeys.has(role.decisionKey))
  ) {
    throw new DirectAcceptanceError("seen_state_stale")
  }

  return evaluations.flatMap((evaluation): Stage3AuthoritySemanticIntent[] => {
    const seen = seenByKey.get(evaluation.subjectKey)
    if (!seen) {
      // An authority that does not even allow leaving the role uncovered has no
      // decision this flow may author. Completion then reports it as
      // `acceptance_not_ready` rather than this code forging a forbidden action.
      if (!evaluation.allowedActions.includes("leave_uncovered" as never)) return []
      return [
        {
          type: "resolve_decision" as const,
          subjectKey: evaluation.subjectKey,
          action: "leave_uncovered" as const,
          deferralReason: deferralReasonFor(evaluation, previewedRoleKeys),
        },
      ]
    }
    if (
      evaluation.status !== "known" ||
      !evaluation.recommendation ||
      !evaluation.recommendationFactFingerprint ||
      !evaluation.allowedActions.includes("plan_recommendation")
    ) {
      throw new DirectAcceptanceError("recommendation_unavailable")
    }
    if (
      seen.productId !== evaluation.recommendation.productId ||
      seen.factFingerprint !== evaluation.recommendationFactFingerprint
    ) {
      throw new DirectAcceptanceError("seen_state_stale")
    }
    return [
      {
        type: "resolve_decision" as const,
        subjectKey: evaluation.subjectKey,
        action: "plan_recommendation" as const,
      },
    ]
  })
}

/**
 * The `"server_recommended"` counterpart of `buildDirectAcceptanceIntents` (T14).
 *
 * Same two outcomes per role, decided from the server's own evaluations instead of from
 * client seen-state: a role with a buyable recommendation is planned with exactly that
 * recommendation; every other role is left uncovered with the same honest deferral reason
 * the seen-state path would record. Nothing is invented — this plans only what the engine
 * would recommend anyway, which is precisely what the buyer paid to receive.
 */
export function buildServerRecommendedIntents(
  evaluations: readonly Stage3AuthorityEvaluation[],
  previewedRoleKeys: ReadonlySet<string>,
  /**
   * Categories this mode may NOT decide, even where it has a buyable recommendation
   * (Nick's D1 ruling, fix round 1). Today exactly one cohort lands here: Scalp Care
   * deferred on a reported irritation whose detail is unknown. The synthetic refinement
   * answers that fact with `"normal"`, which is precisely the assumption the product
   * refuses to make for a person who told us their scalp is irritated — so the role stays
   * `refinement_required` and the buyer is asked, instead of being handed a scalp product
   * chosen under a guess. Every other role still lands, so the „real content immediately
   * after purchase" promise holds. See `directAcceptanceRefinementRequiredCategories`.
   */
  refinementRequiredCategories: ReadonlySet<PersonalPlanCategory> = new Set(),
): Stage3AuthoritySemanticIntent[] {
  const evaluatedKeys = new Set(evaluations.map((evaluation) => evaluation.subjectKey))
  // Same server invariant the seen-state path asserts: one subject, one evaluation.
  if (evaluatedKeys.size !== evaluations.length) {
    throw new DirectAcceptanceError("seen_state_stale")
  }
  return evaluations.flatMap((evaluation): Stage3AuthoritySemanticIntent[] => {
    const refinementRequired = refinementRequiredCategories.has(evaluation.category)
    if (!refinementRequired && hasBuyableRecommendation(evaluation)) {
      return [
        {
          type: "resolve_decision" as const,
          subjectKey: evaluation.subjectKey,
          action: "plan_recommendation" as const,
        },
      ]
    }
    // An authority that does not even allow leaving the role uncovered has no decision this
    // flow may author — completion reports it rather than this code forging an action.
    if (!evaluation.allowedActions.includes("leave_uncovered" as never)) return []
    return [
      {
        type: "resolve_decision" as const,
        subjectKey: evaluation.subjectKey,
        action: "leave_uncovered" as const,
        // A blocked category is `refinement_required` by definition — its roles exist only
        // because the defaults answered a deferred fact, which is exactly what the buyer is
        // being routed to Feinschliff to answer for real.
        deferralReason: refinementRequired
          ? "refinement_required"
          : deferralReasonFor(evaluation, previewedRoleKeys),
      },
    ]
  })
}

/**
 * Server truth only — two independent facts, three reasons:
 *
 *   - the role was NOT previewable at all → it exists only because the
 *     synthetic refinement defaults answered a deferred Stage-1 fact, so its
 *     product choice belongs to the refinement: `refinement_required`.
 *   - it was previewable and the engine has no buyable recommendation either →
 *     a real product gap: `no_product`.
 *   - it was previewable and the engine DOES have a buyable recommendation, but
 *     the person never echoed it → the Idealplan could not present it (missing
 *     packshot, fingerprint churn, verdict gating): `preview_unavailable`.
 *     Deferring it is still right — nothing unseen may be bought — but claiming
 *     a product gap would be false.
 */
function deferralReasonFor(
  evaluation: Stage3AuthorityEvaluation,
  previewedRoleKeys: ReadonlySet<string>,
): Stage3DecisionDeferralReason {
  if (!previewedRoleKeys.has(evaluation.subjectKey)) return "refinement_required"
  return hasBuyableRecommendation(evaluation) ? "preview_unavailable" : "no_product"
}

/** Exactly the shape `plan_recommendation` requires of a seen role. */
function hasBuyableRecommendation(evaluation: Stage3AuthorityEvaluation): boolean {
  return (
    evaluation.status === "known" &&
    Boolean(evaluation.recommendation) &&
    Boolean(evaluation.recommendationFactFingerprint) &&
    evaluation.allowedActions.includes("plan_recommendation")
  )
}

export async function acceptIdealPlan(
  deps: AcceptIdealPlanDeps,
  input: AcceptIdealPlanInput,
): Promise<AcceptIdealPlanResult> {
  if (!deps.flags.stage2Enabled || !deps.flags.stage3Enabled || !deps.flags.stage4Enabled) {
    throw new DirectAcceptanceError("stage_not_available")
  }
  const serverRecommended = input.roleSelection === "server_recommended"
  // The two modes are mutually exclusive by construction: seen-state in server-recommended
  // mode would silently be ignored, which is exactly the kind of half-applied consent this
  // module refuses elsewhere.
  if (serverRecommended && input.seenRoles.length > 0) {
    throw new DirectAcceptanceError("seen_state_stale")
  }

  const { personalPlanId, refinedVersionId, previewedRoleKeys, refinementRequiredCategories } =
    await completeSyntheticRefinement(deps)
  const loaded = await deps.stage3Gateway.loadOrCreate({
    draftId: "server-derived",
    userId: deps.userId,
    requirements: [],
    personalPlanId,
    refinedVersionId,
  })

  let draft = loaded.draft
  if (draft.status === "active") {
    const evaluations = await deps.stage3Gateway.evaluateDecisions({ draftId: draft.draftId })
    const intents = serverRecommended
      ? buildServerRecommendedIntents(evaluations, previewedRoleKeys, refinementRequiredCategories)
      : buildDirectAcceptanceIntents(evaluations, input.seenRoles, previewedRoleKeys)
    if (intents.length > 0) {
      const resolved = await deps.stage3Gateway.resolveDecisions({
        draftId: draft.draftId,
        expectedRevision: draft.revision,
        intents,
      })
      if (resolved.status !== "saved") throw new DirectAcceptanceError("conflict")
      draft = resolved.draft
    }
  }

  // The provenance write is part of THIS transaction (see
  // `personal_plan_complete_draft_activate_v2`): if it fails, the activation
  // rolls back with it, so the plan can never end up live-but-unmarked.
  const completed = await deps.stage3Gateway.complete({
    draftId: draft.draftId,
    expectedRevision: draft.revision,
    markUnrefinedDirectAccept: true,
  })
  if (completed.status === "conflict") throw new DirectAcceptanceError("conflict")
  if (completed.status === "not_ready") throw new DirectAcceptanceError("acceptance_not_ready")

  return {
    status: "accepted",
    personalPlanId,
    refinedVersionId,
    productDraftId: completed.draft.draftId,
    productPortfolioVersionId: completed.productPortfolioVersionId,
    next: completed.next,
  }
}

/** A draft the user has not touched yet, or one holding only our own defaults. */
function isDirectAcceptanceDraft(
  draft: Stage2PersistedDraft,
  defaults: DirectAcceptanceStage2Defaults,
): boolean {
  const isUntouched =
    Object.keys(draft.answers).length === 0 && draft.completedQuestionIds.length === 0
  if (isUntouched) return true
  // Key order survives a JSON round-trip unpredictably, so compare semantically.
  return (
    semanticHash({
      answers: draft.answers,
      completedQuestionIds: [...draft.completedQuestionIds].sort(),
    }) ===
    semanticHash({
      answers: defaults.answers,
      completedQuestionIds: [...defaults.completedQuestionIds].sort(),
    })
  )
}

/**
 * Writes the documented defaults into the real refinement draft and completes
 * it through the production Stage-2 gateway, so the refined need version is
 * produced by exactly the path interactive Stage 2 uses.
 *
 * Two server-side guards keep this from destroying real work. Neither relies on
 * the UI withholding the accept CTA: a stale screen, back-navigation or a retry
 * can always POST this route.
 */
async function completeSyntheticRefinement(deps: AcceptIdealPlanDeps): Promise<{
  personalPlanId: string
  refinedVersionId: string
  previewedRoleKeys: ReadonlySet<string>
  refinementRequiredCategories: ReadonlySet<PersonalPlanCategory>
}> {
  const draft = await deps.refinementPersistence.loadOrCreate(deps.userId)
  const defaults = buildDirectAcceptanceStage2Defaults(draft.triggerContext)
  // `save` replaces the whole answer object, so a partially answered real
  // Stage 2 would be silently overwritten — and the CAS would happily pass,
  // because the revision is current.
  const ownedByDirectAcceptance = isDirectAcceptanceDraft(draft, defaults)
  if (!ownedByDirectAcceptance && draft.status === "in_progress") {
    throw new DirectAcceptanceError("refinement_in_progress")
  }

  // An active Routine this flow did not create must not be relabelled as a
  // direct accept. The pure double-accept retry is exempt: its refinement draft
  // is complete and still carries exactly these defaults.
  const activeRoutineVersionId = await deps.planState.loadActiveRoutineVersionId({
    userId: deps.userId,
    personalPlanId: draft.personalPlanId,
  })
  if (activeRoutineVersionId && !(draft.status === "complete" && ownedByDirectAcceptance)) {
    throw new DirectAcceptanceError("plan_already_accepted")
  }

  // Only computed once the guards above have let this accept through.
  const { previewedRoleKeys, refinementRequiredCategories } =
    stage1PreviewedRoleKeysForDraft(draft)

  if (draft.status === "complete" && draft.refinedVersionId) {
    return {
      personalPlanId: draft.personalPlanId,
      refinedVersionId: draft.refinedVersionId,
      previewedRoleKeys,
      refinementRequiredCategories,
    }
  }

  const saved = await deps.refinementPersistence.save({
    userId: deps.userId,
    draft,
    expectedRevision: draft.revision,
    answers: defaults.answers,
    completedQuestionIds: defaults.completedQuestionIds,
    // Every synthetic default this write produces is an assumption, never a
    // real answer — see refinement/answer-provenance.ts.
    answerProvenance: buildAssumedAnswerProvenance(defaults.completedQuestionIds),
  })
  if (saved.outcome !== "saved") throw new DirectAcceptanceError("conflict")

  const handoff = await createPersistedStage2RefinementGateway({
    userId: deps.userId,
    persistence: deps.refinementPersistence,
  }).complete({ expectedRevision: saved.revision })

  return {
    personalPlanId: draft.personalPlanId,
    refinedVersionId: handoff.refinedVersionId,
    previewedRoleKeys,
    refinementRequiredCategories,
  }
}

/**
 * Recomputes the plan's own Idealplan projection from the immutable Stage-1
 * input the refinement draft carries, and asks the preview module which roles
 * it would show. Pure and read-only — no persistence and no catalog access,
 * because only the role SET is needed, never the products behind it.
 *
 * An input the Stage-1 computation can no longer parse yields the empty set,
 * which makes every unresolved role `refinement_required`: the conservative
 * side, since it never claims a product gap the plan cannot prove.
 */
function stage1PreviewedRoleKeysForDraft(draft: Stage2PersistedDraft): {
  previewedRoleKeys: ReadonlySet<string>
  refinementRequiredCategories: ReadonlySet<PersonalPlanCategory>
} {
  const computed = computeNeedPlan({
    rawEnvelope: draft.baseInputSnapshot,
    artifactId: draft.preparedArtifactSourceId,
    projection: "initial_quiz",
    computationVersion: PERSONAL_PLAN_STAGE1_COMPUTATION_VERSION,
    createdAt: new Date().toISOString(),
  })
  if (computed.status !== "ready") {
    return { previewedRoleKeys: new Set<string>(), refinementRequiredCategories: new Set() }
  }
  return {
    previewedRoleKeys: stage1PreviewedRoleDecisionKeys(computed.snapshot),
    // Same predicate the Idealplan payload uses to refuse direct acceptance outright (D1).
    refinementRequiredCategories: new Set(
      directAcceptanceRefinementRequiredCategories(computed.snapshot),
    ),
  }
}
