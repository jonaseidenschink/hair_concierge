import type {
  ApplicationDayView,
  ApplicationPageView,
  ApplicationProductStepView,
  ApplicationShelfSlotView,
} from "@/components/application/application-types"

import { GATED_EXAMPLE_PRODUCTS, type GatedExampleProduct } from "./example-products"

/**
 * Static example Anwendung for the T12 gated `/anwendung` page.
 *
 * A populated example on purpose (Nick, explicit): the day cards carry the same five real
 * catalog products the example Routine uses, so the shelf illustration is full rather than
 * a row of empty silhouettes. The only empty day is the Pausentag, which is empty by
 * design and shows the moon tile.
 *
 * Handed straight to the REAL `ApplicationPage` as an injected `view` — the same direct
 * view injection `/labs/personal-plan-application` uses.
 */

function productStep(input: {
  product: GatedExampleProduct
  categoryLabelDe: string
  purposeDe: string
  actionDe: string
}): ApplicationProductStepView {
  return {
    kind: "product",
    stepKey: `example:${input.product.category}`,
    applicationInstanceKey: `example:${input.product.category}:step`,
    productId: input.product.productId,
    productName: input.product.displayName,
    imageUrl: input.product.imageUrl,
    categoryLabelDe: input.categoryLabelDe,
    purposeDe: input.purposeDe,
    actions: [{ actionKey: `example:${input.product.category}:apply`, copyDe: input.actionDe }],
    coverageNoteDe: null,
    status: "confirmed",
    provisionalReason: null,
  }
}

function shelfSlot(product: GatedExampleProduct): ApplicationShelfSlotView {
  return {
    kind: "product",
    productId: product.productId,
    productName: product.displayName,
    imageUrl: product.imageUrl,
    category: product.category,
    status: "confirmed",
  }
}

const WASH_DAY: ApplicationDayView = {
  dayType: "wash_day",
  sortOrder: 10,
  labelDe: "Waschtag",
  summaryDe: "Reinigen, pflegen, ohne Ausspülen abschließen.",
  cadenceDe: "2× pro Woche",
  steps: [
    productStep({
      product: GATED_EXAMPLE_PRODUCTS.shampoo,
      categoryLabelDe: "Shampoo",
      purposeDe: "Regelmäßige Reinigung",
      actionDe:
        "Auf die nasse Kopfhaut geben und mit den Fingerkuppen einmassieren. Die Längen werden beim Ausspülen mitgereinigt.",
    }),
    productStep({
      product: GATED_EXAMPLE_PRODUCTS.conditioner,
      categoryLabelDe: "Conditioner",
      purposeDe: "Pflege nach der Reinigung",
      actionDe:
        "In Längen und Spitzen verteilen, die Kopfhaut aussparen. Kurz einwirken lassen, dann gründlich ausspülen.",
    }),
    productStep({
      product: GATED_EXAMPLE_PRODUCTS.leaveIn,
      categoryLabelDe: "Leave-in",
      purposeDe: "Pflege ohne Ausspülen",
      actionDe: "Ins handtuchfeuchte Haar geben, nicht ins trockene. Nicht ausspülen.",
    }),
  ],
  isPartial: false,
  provisionalProductCount: 0,
  unresolvedProductCount: 0,
  shelf: [
    shelfSlot(GATED_EXAMPLE_PRODUCTS.shampoo),
    shelfSlot(GATED_EXAMPLE_PRODUCTS.conditioner),
    shelfSlot(GATED_EXAMPLE_PRODUCTS.leaveIn),
  ],
}

const INTENSIVE_CARE_DAY: ApplicationDayView = {
  dayType: "intensive_care_day",
  sortOrder: 20,
  labelDe: "Intensivpflegetag",
  // No shampoo step here on purpose (pre-boundary fix wave, copy fix 3): the Routine's
  // shampoo cadence says "2× pro Woche", meaning the two Waschtage — Waschtag AND
  // Intensivpflegetag both shampooing would total 3, which the Routine's own cadence line
  // doesn't say. Hair is wetted for the mask without a separate shampoo step instead.
  summaryDe: "Haare anfeuchten, Maske statt Conditioner verwenden.",
  cadenceDe: "1× pro Woche",
  steps: [
    productStep({
      product: GATED_EXAMPLE_PRODUCTS.mask,
      categoryLabelDe: "Maske",
      purposeDe: "Intensivpflege",
      actionDe:
        "Haare gründlich anfeuchten, dann die Maske statt des Conditioners in Längen und Spitzen einarbeiten. Nach der angegebenen Zeit gründlich ausspülen.",
    }),
    productStep({
      product: GATED_EXAMPLE_PRODUCTS.leaveIn,
      categoryLabelDe: "Leave-in",
      purposeDe: "Pflege ohne Ausspülen",
      actionDe: "Ins handtuchfeuchte Haar geben. Nicht ausspülen.",
    }),
  ],
  isPartial: false,
  provisionalProductCount: 0,
  unresolvedProductCount: 0,
  shelf: [shelfSlot(GATED_EXAMPLE_PRODUCTS.mask), shelfSlot(GATED_EXAMPLE_PRODUCTS.leaveIn)],
}

const STYLING_DAY: ApplicationDayView = {
  dayType: "styling_day",
  sortOrder: 30,
  labelDe: "Stylingtag",
  summaryDe: "Ein sparsames Finish für die Spitzen.",
  cadenceDe: "Nach Bedarf",
  steps: [
    productStep({
      product: GATED_EXAMPLE_PRODUCTS.oil,
      categoryLabelDe: "Öl",
      purposeDe: "Finish",
      actionDe:
        "Ein bis zwei Tropfen in den Handflächen verteilen und nur in die Spitzen geben. Sparsam bleiben, sonst beschwert es.",
    }),
  ],
  isPartial: false,
  provisionalProductCount: 0,
  unresolvedProductCount: 0,
  shelf: [shelfSlot(GATED_EXAMPLE_PRODUCTS.oil)],
}

const REST_DAY: ApplicationDayView = {
  dayType: "rest_day",
  sortOrder: 80,
  labelDe: "Pausentag",
  summaryDe: "Heute ist keine Anwendung nötig.",
  cadenceDe: null,
  steps: [],
  isPartial: false,
  provisionalProductCount: 0,
  unresolvedProductCount: 0,
  shelf: [],
}

export const GATED_ANWENDUNG_EXAMPLE_VIEW: ApplicationPageView = {
  state: "ready",
  days: [WASH_DAY, INTENSIVE_CARE_DAY, STYLING_DAY, REST_DAY],
}
