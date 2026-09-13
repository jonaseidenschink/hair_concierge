import { notFound } from "next/navigation"

import { buildScannerProfileChips, type ScannerOfferModel } from "@/components/scanner-offer/model"
import { ScannerOffer } from "@/components/scanner-offer/scanner-offer"
import { isOfferPageLabEnabled } from "@/lib/labs/offer-page-access"
import { buildPersonalPlanPreparedArtifact } from "@/lib/personal-plan-quiz/prepared-plan"
import { canonicalizePersonalPlanAnswers } from "@/lib/personal-plan-quiz/persistence"
import type { QuizAnswers } from "@/lib/quiz/types"

/**
 * Lab: Scanner-Angebotsseite nach dem Quiz.
 * Aufruf: /labs/scanner-offer (nur development / preview, wie /labs/offer-page).
 * Spec und Mockups: docs/scanner-offer/README.md
 */

const REVIEW_ANSWERS: QuizAnswers = {
  structure: "wavy",
  thickness: "fine",
  density: "medium",
  hair_length: "long",
  fingertest: "leicht_uneben",
  pulltest: "stretches_stays",
  scalp_type: "trocken",
  has_scalp_issue: false,
  concerns: ["dryness", "frizz"],
  treatment: ["gefaerbt"],
  goals: ["moisture", "less_frizz"],
}

const REVIEW_ARTIFACT = buildPersonalPlanPreparedArtifact(
  canonicalizePersonalPlanAnswers({
    texture: "wavy",
    thickness: "fine",
    density: "medium",
    goals: ["moisture", "frizz_surface"],
    routineClarity: "trial_and_error",
    resultReliability: "sometimes",
    adaptationConfidence: "partly",
    currentConcerns: ["dry_lengths", "frizz_flyaways"],
    concernRecurrence: { concernId: "dry_lengths", frequency: "often" },
    hairLength: "long",
    hairSurface: "slightly_uneven",
    elasticResponse: "stretches_stays",
    chemicalTreatments: ["colored"],
    scalpOiliness: "dry",
    scalpConcerns: [],
    previousAttempts: "some_steps_helped",
    blockers: ["product_fit"],
    routineStyle: "simple_reliable",
    meaningfulMoment: "everyday",
  }),
).publicOfferModel

const REVIEW_MODEL: ScannerOfferModel = {
  name: "Jonas",
  profileHeadline: "Welliges, feines Haar mit mittlerer Dichte.",
  profileChips: buildScannerProfileChips(REVIEW_ANSWERS),
  diagnosticRows: REVIEW_ARTIFACT.diagnosticRows,
  encouragement:
    "Feines, gefärbtes Haar mit gedehntem Zugtest braucht leichte Pflege mit hoher Repair-Unterstützung. Die meisten Produkte im Regal sind für mittleres Haar gebaut.",
  plans: [
    {
      id: "year",
      title: "Jahr",
      detail: "7 Tage kostenlos, dann 69,99 €/Jahr",
      priceLabel: "5,83 €/Mo",
      priceNote: "Testphase inklusive",
      afterTrialLabel: "69,99 € im Jahr, jederzeit kündbar.",
      badge: "Beliebteste Wahl",
    },
    {
      id: "month",
      title: "Monat",
      detail: "7 Tage kostenlos, dann 9,99 €/Monat",
      priceLabel: "9,99 €/Mo",
      priceNote: "Testphase inklusive",
      afterTrialLabel: "9,99 € im Monat, monatlich kündbar.",
    },
  ],
  defaultPlanId: "year",
}

const WHATSAPP_LAB_HREF =
  "https://wa.me/4900000000000?text=" +
  encodeURIComponent("Hallo, ich bin Jonas, welliges feines Haar, und hab eine Frage zum Scanner.")

export default function ScannerOfferLab() {
  if (!isOfferPageLabEnabled(process.env)) notFound()

  return <ScannerOffer isInternalTest model={REVIEW_MODEL} whatsappHref={WHATSAPP_LAB_HREF} />
}
