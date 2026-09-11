import type {
  PersonalPlanRoutineView,
  RoutineProductPresentation,
  RoutinePayloadV1,
} from "@/lib/personal-plan/routine/contracts"

import { GATED_EXAMPLE_PRODUCTS, type GatedExampleProduct } from "./example-products"

/**
 * Static example Routine for the T12 gated `/routine` page.
 *
 * It is a plain `PersonalPlanRoutineView` handed straight to the REAL `RoutinePage`
 * component, so the framed example always matches whatever the Routine looks like today.
 * Nothing here is loaded, and nothing here belongs to any user: the ids are literal
 * `example:*` strings rather than plausible uuids, so an example item can never be
 * mistaken for — or correlated with — real plan data.
 */

type RoutineItem = RoutinePayloadV1["items"][number]

const EXAMPLE_PLAN_ID = "00000000-0000-4000-8000-00000000e123"
const EXAMPLE_REFINED_VERSION_ID = "00000000-0000-4000-8000-00000000e456"

function ownedItem(input: {
  product: GatedExampleProduct
  role: RoutineItem["role"]
  roleOrder: number
  cadenceDe: string
  systemAssessment: RoutineItem["state"]["systemAssessment"]
}): RoutineItem {
  const key = `example:${input.product.category}:${input.role}`
  return {
    itemKey: key,
    assignmentKey: `assignment:${key}`,
    category: input.product.category,
    role: input.role,
    purposeKey: input.role,
    roleOrder: input.roleOrder,
    state: {
      systemAssessment: input.systemAssessment,
      inclusion: "included",
      availability: "owned",
      fitDecision: "standard",
    },
    product: {
      kind: "owned",
      capturedProductId: `${key}:captured`,
      productId: input.product.productId,
      displayName: input.product.displayName,
    },
    cadence: {
      recommended: null,
      userOverride: null,
      displayKey: "personal_plan.cadence.category",
      resolved: { copyDe: input.cadenceDe, source: "category" },
    },
    sourceDecisionKeys: [],
    authorityRuleIds: [],
    executable: true,
  }
}

const BASIS_ITEMS: RoutineItem[] = [
  ownedItem({
    product: GATED_EXAMPLE_PRODUCTS.shampoo,
    role: "shampoo_everyday",
    roleOrder: 0,
    cadenceDe: "2× pro Woche",
    systemAssessment: "basis",
  }),
  ownedItem({
    product: GATED_EXAMPLE_PRODUCTS.conditioner,
    role: "conditioner_rinse_out",
    roleOrder: 1,
    cadenceDe: "Nach jeder Wäsche",
    systemAssessment: "basis",
  }),
  ownedItem({
    product: GATED_EXAMPLE_PRODUCTS.mask,
    role: "intensive_conditioning_mask",
    roleOrder: 2,
    cadenceDe: "1× pro Woche statt Conditioner",
    systemAssessment: "basis",
  }),
  ownedItem({
    product: GATED_EXAMPLE_PRODUCTS.leaveIn,
    role: "post_wash_leave_in",
    roleOrder: 3,
    cadenceDe: "Nach jeder Wäsche",
    systemAssessment: "basis",
  }),
]

const OPTIONAL_ITEMS: RoutineItem[] = [
  ownedItem({
    product: GATED_EXAMPLE_PRODUCTS.oil,
    role: "dry_finish",
    roleOrder: 0,
    cadenceDe: "Nach Bedarf",
    systemAssessment: "optional",
  }),
]

const EXAMPLE_PAYLOAD: RoutinePayloadV1 = {
  schemaVersion: 1,
  planId: EXAMPLE_PLAN_ID,
  versionId: "example-routine-v1",
  parentVersionId: null,
  source: {
    refinedVersionId: EXAMPLE_REFINED_VERSION_ID,
    productPortfolioVersionId: "example-portfolio-v1",
    sourceFingerprint: "e".repeat(64),
    compilerVersion: "gated-preview-example-v1",
    authorityVersions: {},
  },
  intent: { schemaVersion: 1, categories: [] },
  sections: [
    { key: "basis", itemKeys: BASIS_ITEMS.map((item) => item.itemKey) },
    { key: "optional", itemKeys: OPTIONAL_ITEMS.map((item) => item.itemKey) },
  ],
  items: [...BASIS_ITEMS, ...OPTIONAL_ITEMS],
  createdAt: "2026-09-01T08:00:00.000Z",
}

/** Feeds the real product thumbnails into `RoutineCategoryCard`'s rows. */
const EXAMPLE_PRODUCT_PRESENTATION: RoutineProductPresentation = {
  catalogProducts: Object.values(GATED_EXAMPLE_PRODUCTS).map((product) => ({
    productId: product.productId,
    displayName: product.displayName,
    imageUrl: product.imageUrl,
    verifiedLeaveOnHeatProtection: false,
  })),
}

export const GATED_ROUTINE_EXAMPLE_VIEW: PersonalPlanRoutineView = {
  status: "active",
  personalPlanId: EXAMPLE_PLAN_ID,
  planRevision: 1,
  sourceRevision: 1,
  activeVersion: { id: EXAMPLE_PAYLOAD.versionId, payload: EXAMPLE_PAYLOAD },
  // No pending proposal: „Änderungen prüfen" would be a live decision, and the example
  // must not present a decision the reader cannot make.
  pendingProposal: null,
  productPresentation: EXAMPLE_PRODUCT_PRESENTATION,
}
