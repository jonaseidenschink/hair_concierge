import type { ScanMaskedVerdictResult } from "../src/lib/scan/masked-alternative"
import type { ScanSavedStatePayload } from "../src/lib/scan/saved-state"
import type {
  ScanAlternativePresentation,
  ScanProductHeader,
  ScanResolvedVerdictResult,
  ScanUnknownProductResult,
} from "../src/lib/scan/types"

/**
 * Fixtures for `tests/scan-flow.spec.ts`. Everything the `/labs/scan` harness's flow can
 * ask the server for, in the exact contract shapes `src/lib/scan/types.ts` declares —
 * typed rather than cast, so a contract change breaks the spec at `npm run typecheck`
 * instead of at 3am in CI.
 *
 * The two products are deliberately unbuyable (`purchaseUrl: null`): the footer then
 * collapses to a single "Speichern" slot, which is the button the save-race scenario
 * asserts on.
 */

/** Valid EAN-13 check digits — `validateEanInput` rejects anything else before it fires. */
export const EAN_PRODUCT_A = "4006381333931"
export const EAN_UNKNOWN = "4006381333948"
export const EAN_PRODUCT_B = "4006381333955"

export const PRODUCT_A_ID = "aaaaaaaa-0000-4000-8000-000000000001"
export const PRODUCT_B_ID = "bbbbbbbb-0000-4000-8000-000000000002"

export const NOT_SAVED: ScanSavedStatePayload = { state: null, managedByScan: false }

function productHeader(productId: string, name: string): ScanProductHeader {
  return {
    productId,
    name,
    brand: "Chaarlie Lab",
    category: "shampoo",
    categoryLabel: "Shampoo",
    imageUrl: null,
    priceLabel: null,
    purchaseUrl: null,
  }
}

function inCatalogResult(productId: string, name: string): ScanResolvedVerdictResult {
  return {
    kind: "in_catalog",
    verdict: "ideal",
    verdictLabel: "Passt",
    verdictTitle: "Passt zu deinem Haar",
    status: "ok",
    subtitle: "3 von 3 Zielbereichen getroffen",
    evaluatedRole: null,
    evaluatedRoleLabel: null,
    dimensions: [],
    criteria: [],
    coverage: { matches: 3, total: 3 },
    fitNarrative: null,
    alternatives: [],
    product: productHeader(productId, name),
    snapshotSource: "refined",
    savedState: NOT_SAVED,
  }
}

export const RESULT_A = inCatalogResult(PRODUCT_A_ID, "Lab Shampoo Alpha")
export const RESULT_B = inCatalogResult(PRODUCT_B_ID, "Lab Shampoo Beta")

/* ---------------------------------------------------- free tier (T8 masked shape, T9) */

export const REVEALED_ALTERNATIVE_ID = "dddddddd-0000-4000-8000-000000000004"
export const REVEALED_ALTERNATIVE_NAME = "Lab Shampoo Gamma"

/**
 * The FULL alternative `POST /api/scan/reveal` hands back once the one-lifetime credit is
 * spent — the same `ScanAlternativePresentation` shape the premium tier gets on resolve.
 */
export const REVEALED_ALTERNATIVES: ScanAlternativePresentation[] = [
  {
    productId: REVEALED_ALTERNATIVE_ID,
    displayName: REVEALED_ALTERNATIVE_NAME,
    imageUrl: null,
    priceLabel: "9,99 €",
    netContentLabel: "250 ml",
    verdict: "ideal",
    verdictLabel: "Passt",
    brand: "Chaarlie Lab",
    purchaseUrl: null,
  },
]

/**
 * A free-tier `in_catalog` verdict: every identity field is absent by contract (the type
 * has none), the comparison rows are readable, and `freeRevealAvailable` is the marker the
 * client gates its whole free-state rendering on.
 */
function maskedResult(freeRevealAvailable: boolean): ScanMaskedVerdictResult {
  return {
    kind: "in_catalog",
    evaluatedRole: null,
    evaluatedRoleLabel: null,
    dimensions: [],
    criteria: [],
    coverage: { matches: 1, total: 3 },
    fitNarrative: null,
    product: productHeader(PRODUCT_A_ID, "Lab Shampoo Alpha"),
    snapshotSource: "refined",
    savedState: NOT_SAVED,
    verdict: "mismatch",
    verdictLabel: "Passt nicht",
    verdictTitle: "Passt nicht zu deinem Haar",
    status: "danger",
    subtitle: "1 von 3 Zielbereichen getroffen",
    alternatives: [
      {
        verdict: "ideal",
        verdictLabel: "Passt",
        comparison: {
          rows: [
            { rowId: "care_weight", label: "Pflegegewicht", state: "match" },
            { rowId: "cleansing", label: "Reinigungsstärke", state: "match" },
            { rowId: "silicones", label: "Silikone", state: "partial" },
            { rowId: "protein", label: "Protein", state: "unknown" },
          ],
          summaryScore: 0.5,
        },
      },
    ],
    freeRevealAvailable,
  }
}

/** First „passt nicht" ever: the reveal credit is still unspent. */
export const MASKED_RESULT_REVEAL_AVAILABLE = maskedResult(true)
/** A later „passt nicht": the credit is gone, so the CTA is the Premium sheet. */
export const MASKED_RESULT_REVEAL_USED = maskedResult(false)

export const UNKNOWN_RESULT: ScanUnknownProductResult = {
  kind: "unknown_product",
  identifier: { type: "ean", value: EAN_UNKNOWN },
  categories: [
    { key: "shampoo", label: "Shampoo" },
    { key: "conditioner", label: "Conditioner" },
    { key: "mask", label: "Maske" },
  ],
}

export const PENDING_SUBMISSION = {
  kind: "pending_submission" as const,
  submissionId: "cccccccc-0000-4000-8000-000000000003",
  headline: "Wir schauen uns das Produkt an",
}

/** Which resolve payload a request body maps to. */
export function resolvePayloadFor(body: {
  identifier?: { value: string }
  productId?: string
}): ScanResolvedVerdictResult | ScanUnknownProductResult | null {
  const ean = body.identifier?.value
  if (ean === EAN_PRODUCT_A) return RESULT_A
  if (ean === EAN_PRODUCT_B) return RESULT_B
  if (ean === EAN_UNKNOWN) return UNKNOWN_RESULT
  if (body.productId === PRODUCT_A_ID) return RESULT_A
  if (body.productId === PRODUCT_B_ID) return RESULT_B
  return null
}

/**
 * The free-tier counterpart: the same request bodies, answered with T8's masked shape.
 * `EAN_PRODUCT_B` deliberately keeps answering the premium shape so one spec can prove
 * that a response WITHOUT the masking marker still renders today's UI.
 */
export function maskedResolvePayloadFor(
  body: { identifier?: { value: string }; productId?: string },
  freeRevealAvailable: boolean,
): ScanMaskedVerdictResult | ScanResolvedVerdictResult | ScanUnknownProductResult | null {
  const ean = body.identifier?.value
  if (ean === EAN_PRODUCT_A || body.productId === PRODUCT_A_ID) {
    return freeRevealAvailable ? MASKED_RESULT_REVEAL_AVAILABLE : MASKED_RESULT_REVEAL_USED
  }
  return resolvePayloadFor(body)
}
