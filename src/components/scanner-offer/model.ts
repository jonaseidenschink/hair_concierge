import type { PersonalPlanDiagnosticDimension } from "@/components/personal-plan-offer/types"
import type { QuizAnswers } from "@/lib/quiz/types"

/** Server-sicheres Model der Scanner-Angebotsseite. Keine React-Abhängigkeit. */

export type ScannerOfferPlanId = "year" | "month"

export type ScannerOfferPlan = {
  id: ScannerOfferPlanId
  title: string
  /** Kurzzeile unter dem Titel, z. B. "7 Tage kostenlos, dann 69,99 €/Jahr" */
  detail: string
  /** Preis rechts, z. B. "5,83 €/Mo" */
  priceLabel: string
  /** Zeile unter dem Preis, z. B. "Testphase inklusive" */
  priceNote?: string
  /** Text, der nach dem Trial gilt, für Kleingedrucktes und Zeitleiste */
  afterTrialLabel: string
  badge?: string
}

export type ScannerOfferProfileChip = { label: string; value: string }

export type ScannerOfferModel = {
  /** Vorname aus dem Lead, für die Eyebrow-Zeile. */
  name?: string | null
  /** Ein Satz, z. B. "Welliges, feines Haar mit mittlerer Dichte." */
  profileHeadline: string
  profileChips: ScannerOfferProfileChip[]
  diagnosticRows: PersonalPlanDiagnosticDimension[]
  /** "Das Gute"-Satz unter den Dimensionen. */
  encouragement: string
  plans: [ScannerOfferPlan, ScannerOfferPlan]
  defaultPlanId?: ScannerOfferPlanId
}

const ANSWER_LABELS: Record<string, Record<string, string>> = {
  structure: { straight: "glatt", wavy: "wellig", curly: "lockig", coily: "kraus" },
  thickness: { fine: "fein", normal: "mittel", coarse: "dick" },
  density: { low: "wenig", medium: "mittel", high: "viel" },
  hair_length: {
    very_short: "sehr kurz",
    short: "kurz",
    medium: "mittellang",
    long: "lang",
    very_long: "sehr lang",
  },
  fingertest: { glatt: "glatt", leicht_uneben: "leicht uneben", rau: "rau" },
  pulltest: {
    stretches_bounces: "federt zurück",
    stretches_stays: "bleibt gedehnt",
    snaps: "reißt sofort",
  },
  scalp_type: { fettig: "eher fettig", ausgeglichen: "ausgeglichen", trocken: "eher trocken" },
}

const TREATMENT_LABELS: Record<string, string> = {
  natur: "Naturhaar",
  gefaerbt: "gefärbt",
  blondiert: "blondiert",
  dauerwelle: "Dauerwelle",
  chemisch_geglaettet: "geglättet",
}

/** Baut die Profil-Chips aus den gespeicherten Quiz-Antworten. Unbekannte Werte werden ausgelassen. */
export function buildScannerProfileChips(answers: QuizAnswers): ScannerOfferProfileChip[] {
  const chips: ScannerOfferProfileChip[] = []
  const push = (label: string, key: keyof typeof ANSWER_LABELS, value: string | undefined) => {
    if (!value) return
    const text = ANSWER_LABELS[key]?.[value]
    if (text) chips.push({ label, value: text })
  }
  push("Struktur", "structure", answers.structure)
  push("Dicke", "thickness", answers.thickness)
  push("Dichte", "density", answers.density)
  push("Länge", "hair_length", answers.hair_length)
  push("Oberfläche", "fingertest", answers.fingertest)
  push("Zugtest", "pulltest", answers.pulltest)
  const treatments = (answers.treatment ?? [])
    .map((value) => TREATMENT_LABELS[value])
    .filter((value): value is string => Boolean(value))
  if (treatments.length) chips.push({ label: "Behandlung", value: treatments.join(", ") })
  push("Kopfhaut", "scalp_type", answers.scalp_type)
  return chips
}
