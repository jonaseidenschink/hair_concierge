import assert from "node:assert/strict"
import test from "node:test"

import { buildServerRecommendedIntents } from "../src/lib/personal-plan/direct-acceptance/accept"
import {
  parseFreemiumPlanAdmission,
  resolveFreemiumPlanEnrollment,
  type ResolveFreemiumEnrollmentDeps,
} from "../src/lib/personal-plan/freemium-enrollment"
import { loadPersonalPlanJourneyAccessWithDeps } from "../src/lib/personal-plan/journey-access-loader"
import type { PersonalPlanJourneyAccessLoaderDeps } from "../src/lib/personal-plan/journey-access-loader"
import type { Stage3AuthorityEvaluation } from "../src/lib/personal-plan/products/authority/contracts"

/**
 * Freemium enrollment admission — the contract that decides whether a Premium-sheet buyer
 * is a Personal-Plan owner at all, and therefore whether `/routine` renders their real
 * plan instead of T12's „Beispiel" frame.
 *
 * Three separable claims, tested separately:
 *   1. the admission record resolves to an enrollment ONLY with the flag on and current
 *      paid authority (the record binds the source; it grants nothing);
 *   2. that enrollment carries the journey all the way to Stage 4/5 once a Routine exists —
 *      which is what „real content immediately after purchase" actually means;
 *   3. the server-recommended intents that produce that Routine plan the engine's own
 *      recommendations, and leave the rest honestly uncovered.
 */

const USER = "user-1"
const ADMISSION = {
  id: "admission-1",
  user_id: USER,
  provider: "stripe",
  provider_reference: "cs_test_1",
  lead_id: "lead-1",
  admitted_at: "2026-09-10T09:00:00.000Z",
}

function enrollmentDeps(
  overrides: Partial<ResolveFreemiumEnrollmentDeps> = {},
): ResolveFreemiumEnrollmentDeps {
  return {
    flagEnabled: () => true,
    findAdmission: async () => parseFreemiumPlanAdmission(ADMISSION),
    hasPaidAccess: async () => true,
    ...overrides,
  }
}

const noClient = {} as never

test("an admitted buyer with current paid authority is a plan owner", async () => {
  const resolved = await resolveFreemiumPlanEnrollment(noClient, USER, new Date(), enrollmentDeps())
  assert.deepEqual(resolved, {
    sourceId: "admission-1",
    admittedAt: ADMISSION.admitted_at,
    leadId: "lead-1",
  })
})

test("the source id is the admission, not the provider reference", async () => {
  // A resubscribe issues a new Stripe subscription id; the plan's pinned
  // `enrollment_purchase_source_id` must survive that, so it can never be the provider's.
  const resolved = await resolveFreemiumPlanEnrollment(noClient, USER, new Date(), enrollmentDeps())
  assert.notEqual(resolved?.sourceId, ADMISSION.provider_reference)
})

test("flag off: nothing resolves, and the admission table is never read", async () => {
  let reads = 0
  const resolved = await resolveFreemiumPlanEnrollment(noClient, USER, new Date(), {
    ...enrollmentDeps(),
    flagEnabled: () => false,
    findAdmission: async () => {
      reads += 1
      return null
    },
  })
  assert.equal(resolved, null)
  assert.equal(reads, 0)
})

test("a lapsed subscription loses the plan even with the record in place", async () => {
  const resolved = await resolveFreemiumPlanEnrollment(noClient, USER, new Date(), {
    ...enrollmentDeps(),
    hasPaidAccess: async () => false,
  })
  assert.equal(resolved, null)
})

test("no admission record means no freemium enrollment — legacy standard subscribers are untouched", async () => {
  const resolved = await resolveFreemiumPlanEnrollment(noClient, USER, new Date(), {
    ...enrollmentDeps(),
    findAdmission: async () => null,
  })
  assert.equal(resolved, null)
})

test("a malformed admission row resolves to nothing rather than a half-enrollment", () => {
  assert.equal(parseFreemiumPlanAdmission(null), null)
  assert.equal(parseFreemiumPlanAdmission({ ...ADMISSION, lead_id: null }), null)
  assert.equal(parseFreemiumPlanAdmission({ ...ADMISSION, provider: "klarna" }), null)
  assert.equal(parseFreemiumPlanAdmission({ ...ADMISSION, id: 7 }), null)
})

/* ------------------------------------------------------------------------- *
 * The journey the admission opens.
 * ------------------------------------------------------------------------- */

function journeyDeps(
  plan: NonNullable<Awaited<ReturnType<PersonalPlanJourneyAccessLoaderDeps["loadPlan"]>>>,
  overrides: Partial<PersonalPlanJourneyAccessLoaderDeps> = {},
): PersonalPlanJourneyAccessLoaderDeps {
  return {
    loadEntitlement: async () => ({
      accessState: "active",
      // Admitted TODAY — and deliberately with no new-buyer cutoff configured, so the test
      // proves the `"freemium"` source kind itself qualifies rather than the date.
      qualifiedAt: ADMISSION.admitted_at,
      artifactLeadId: "lead-1",
      quizSourceKind: "personal_plan",
      sourceKind: "freemium",
    }),
    cohortCutoff: () => null,
    appEnabled: () => true,
    appRollout: () => "all",
    stage2Enabled: () => true,
    stage3Enabled: () => true,
    stage4Enabled: () => true,
    loadPreparedArtifact: async () => ({ id: "artifact-1" }),
    loadPlan: async () => plan,
    loadCurrentRefinedNeed: async () => null,
    loadCurrentProductDraft: async () => null,
    loadIsInternal: async () => false,
    ...overrides,
  }
}

test("a provisioned freemium buyer reaches Stage 4 and Stage 5 — the gates open", async () => {
  const access = await loadPersonalPlanJourneyAccessWithDeps(
    journeyDeps({
      id: "plan-1",
      currentInitialNeedVersionId: "need-1",
      currentRefinedNeedVersionId: "refined-1",
      productDraftCompleted: true,
      pendingRoutineProposalId: null,
      activeRoutineVersionId: "routine-1",
    }),
    USER,
  )
  assert.equal(access.kind, "personal_plan")
  if (access.kind !== "personal_plan") throw new Error("unreachable")
  assert.equal(access.allowed.stage4, true)
  assert.equal(access.allowed.stage5, true)
  assert.equal(access.nextHref, "/anwendung")
})

test("without the accepted Routine the same buyer stops short of Stage 4", async () => {
  // The negative half of the claim above: entitlement alone opens nothing, which is exactly
  // why provisioning has to accept a Routine rather than just admit the plan.
  const access = await loadPersonalPlanJourneyAccessWithDeps(
    journeyDeps({
      id: "plan-1",
      currentInitialNeedVersionId: "need-1",
      currentRefinedNeedVersionId: null,
      productDraftCompleted: false,
      pendingRoutineProposalId: null,
      activeRoutineVersionId: null,
    }),
    USER,
  )
  assert.equal(access.kind, "personal_plan")
  if (access.kind !== "personal_plan") throw new Error("unreachable")
  assert.equal(access.allowed.stage4, false)
})

/* ------------------------------------------------------------------------- *
 * The intents that build that Routine.
 * ------------------------------------------------------------------------- */

function knownEvaluation(subjectKey: string, category = "shampoo"): Stage3AuthorityEvaluation {
  return {
    status: "known",
    category,
    subjectKey,
    allowedActions: ["plan_recommendation", "leave_uncovered"],
    recommendation: { productId: "product-1" },
    recommendationFactFingerprint: "fingerprint-1",
    coverageRuleIds: [],
    criteria: [],
  } as unknown as Stage3AuthorityEvaluation
}

function unknownEvaluation(subjectKey: string): Stage3AuthorityEvaluation {
  return {
    status: "unknown",
    category: "shampoo",
    subjectKey,
    missingFacts: ["fact"],
    criteria: [],
    allowedActions: ["leave_uncovered"],
    coverageRuleIds: [],
  } as unknown as Stage3AuthorityEvaluation
}

test("server-recommended acceptance plans every buyable role and defers the rest honestly", () => {
  const intents = buildServerRecommendedIntents(
    [
      knownEvaluation("decision:shampoo:cleanse:gap"),
      unknownEvaluation("decision:mask:repair:gap"),
    ],
    new Set(["decision:shampoo:cleanse:gap"]),
  )
  assert.deepEqual(intents, [
    {
      type: "resolve_decision",
      subjectKey: "decision:shampoo:cleanse:gap",
      action: "plan_recommendation",
    },
    {
      type: "resolve_decision",
      subjectKey: "decision:mask:repair:gap",
      action: "leave_uncovered",
      // Never previewed by an Idealplan the buyer never saw → the refinement owns it.
      deferralReason: "refinement_required",
    },
  ])
})

test("D1: a refinement-required category is never auto-provisioned, even when buyable", () => {
  // Nick's D1 ruling: a buyer who reported scalp irritation whose detail we never asked
  // about must not be handed a scalp product chosen under the „normal" default. Everything
  // else still lands, so the post-purchase promise („real content immediately") holds.
  const intents = buildServerRecommendedIntents(
    [
      knownEvaluation("decision:shampoo:cleanse:gap"),
      knownEvaluation("decision:scalp_care:scalp_comfort:gap", "scalp_care"),
    ],
    // Previewed on purpose: without the block, this key would plan its recommendation.
    new Set(["decision:shampoo:cleanse:gap", "decision:scalp_care:scalp_comfort:gap"]),
    new Set(["scalp_care"]),
  )
  assert.deepEqual(intents, [
    {
      type: "resolve_decision",
      subjectKey: "decision:shampoo:cleanse:gap",
      action: "plan_recommendation",
    },
    {
      type: "resolve_decision",
      subjectKey: "decision:scalp_care:scalp_comfort:gap",
      action: "leave_uncovered",
      deferralReason: "refinement_required",
    },
  ])
})

test("a role whose authority forbids leaving it uncovered is not forged into a decision", () => {
  const unsupported = {
    status: "unsupported",
    category: "shampoo",
    subjectKey: "decision:shampoo:cleanse:gap",
    reason: "no_authority",
    allowedActions: [],
    coverageRuleIds: [],
  } as unknown as Stage3AuthorityEvaluation
  assert.deepEqual(buildServerRecommendedIntents([unsupported], new Set()), [])
})

test("two evaluations for one subject are a server invariant violation, not a merge", () => {
  assert.throws(() =>
    buildServerRecommendedIntents(
      [
        knownEvaluation("decision:shampoo:cleanse:gap"),
        knownEvaluation("decision:shampoo:cleanse:gap"),
      ],
      new Set(),
    ),
  )
})
