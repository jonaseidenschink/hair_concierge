import { CATEGORY_COPY } from "@/components/personal-plan-products/stage3-product-copy"
import type { PersonalPlanCategory } from "@/lib/personal-plan/products/contracts"
import type { PlanPortfolioCoverageFact } from "@/lib/personal-plan/types"

import type { ScanStatusToken, ScanVerdict } from "./types"

/** Every German string the scan result sheet renders that has no source elsewhere. */

export const SCAN_VERDICT_COPY: Record<
  ScanVerdict,
  { label: string; title: string; status: ScanStatusToken }
> = {
  ideal: { label: "Passt", title: "Passt zu deinem Haar", status: "ok" },
  supportive: {
    label: "Passt mit Einschränkung",
    title: "Passt mit Einschränkung zu deinem Haar",
    status: "pending",
  },
  mismatch: { label: "Passt nicht", title: "Passt nicht zu deinem Haar", status: "danger" },
  unknown: { label: "Unklar", title: "Da sind wir noch nicht sicher", status: "neutral" },
}

export const SCAN_NOT_NEEDED_STATUS: Extract<ScanStatusToken, "neutral"> = "neutral"

/** Used when the profile carries no measurable target on this category at all. */
export const SCAN_SUBTITLE_WITHOUT_TARGETS = "Basierend auf deinem Haarprofil"

export function scanTargetSubtitle(matches: number, total: number): string {
  return `${matches} von ${total} Zielbereichen getroffen`
}

export function scanCriterionSubtitle(matches: number, total: number): string {
  return `${matches} von ${total} Kriterien erfüllt`
}

/**
 * Accusative ("Du brauchst … keinen Conditioner") and nominative ("Kein Conditioner in
 * deinem Bedarf") negation for each category label in `CATEGORY_COPY`.
 */
const CATEGORY_NEGATION: Record<PersonalPlanCategory, { accusative: string; nominative: string }> =
  {
    shampoo: { accusative: "kein", nominative: "Kein" },
    conditioner: { accusative: "keinen", nominative: "Kein" },
    leave_in: { accusative: "kein", nominative: "Kein" },
    heat_protectant: { accusative: "keinen", nominative: "Kein" },
    oil: { accusative: "kein", nominative: "Kein" },
    mask: { accusative: "keine", nominative: "Keine" },
    scalp_care: { accusative: "kein", nominative: "Kein" },
    dry_shampoo: { accusative: "kein", nominative: "Kein" },
    bondbuilder: { accusative: "keinen", nominative: "Kein" },
    deep_cleansing_shampoo: { accusative: "keine", nominative: "Keine" },
  }

export function scanNotNeededHeadline(category: PersonalPlanCategory): string {
  return `Du brauchst aktuell ${CATEGORY_NEGATION[category].accusative} ${CATEGORY_COPY[category].label}`
}

export function scanNotNeededSubtitle(category: PersonalPlanCategory): string {
  return `${CATEGORY_NEGATION[category].nominative} ${CATEGORY_COPY[category].label} in deinem Bedarf`
}

export const SCAN_DEFERRED_HEADLINE = "Das klären wir noch"

/**
 * Unknown-product intake, single success-first step (copy sign-off 2026-09-01): the
 * headline leads with thanks/success tone, not surprise, and the question sits under
 * it above the category cards — tapping a card submits immediately (no step 2).
 */
export const SCAN_UNKNOWN_HEADLINE = "Danke dir – das ist neu für uns!"
/**
 * The bridge between the viewfinder and this sheet (plan 2026-09-05): the pill said the
 * barcode was read, and the very next screen says the product is new. Without this line
 * the two read as a contradiction — with it, "gelesen" and "fehlt noch" are one story.
 */
export const SCAN_UNKNOWN_BRIDGE = "Barcode gelesen – das Produkt fehlt noch in unserer Datenbank."
export const SCAN_UNKNOWN_SUBLINE = "Wir nehmen es auf. Dein Ergebnis kommt in den Chat."
export const SCAN_UNKNOWN_QUESTION = "Wobei benutzt du es?"

/** Resolving sheet while the verdict loads (Variante A decode feedback). */
export const SCAN_RESOLVING_TITLE = "Produkt wird geprüft …"
export const SCAN_RESOLVING_SUBLINE = "Passt es zu deinem Haar?"

/**
 * `POST /api/scan/resolve` and `POST /api/scan/submit`: an open submission exists.
 * Success-first (copy sign-off 2026-09-01) — the intake step already told the user
 * we're on it, so this confirms rather than re-announcing a review.
 */
export const SCAN_PENDING_SUBMISSION_HEADLINE = "Eingereicht!"

/**
 * "steht … noch aus" mirrors the plan fork's wording for an open decision.
 * `scalp_care`'s label ("Kopfhautprodukt") reads badly without an article in this
 * frame ("Für Kopfhautprodukt steht …"), so it gets the plural special-case instead
 * (copy sign-off 2026-09-01) — every other category keeps the plain label form.
 */
export function scanDeferredSubtitle(category: PersonalPlanCategory): string {
  if (category === "scalp_care") return "Für Kopfhautprodukte steht deine Einschätzung noch aus"
  return `Für ${CATEGORY_COPY[category].label} steht deine Einschätzung noch aus`
}

export const SCAN_COVERAGE_JOB_LABELS: Record<PlanPortfolioCoverageFact["job"], string> = {
  wet_wash_cleansing: "Reinigung bei der Haarwäsche",
  dry_shampoo_bridge: "Frische zwischen den Haarwäschen",
  scalp_flake_or_comfort: "Kopfhautkomfort und Schuppen",
  scalp_root_reset: "Reset am Ansatz",
  repair_support: "Repair-Pflege",
  damp_smoothing: "Glättung im feuchten Haar",
  heat_protection: "Hitzeschutz",
  rinse_out_conditioning: "Pflege nach der Wäsche",
}

/**
 * German copy for the reason facts a `not_needed` (or target-less) decision can carry.
 * Reason ids are engineering identifiers with no German source anywhere else in the
 * repo, so the scan sheet maps only the ids it knows and drops the rest — an unmapped
 * id must never reach a user as raw text.
 */
export const SCAN_NOT_NEEDED_REASON_COPY: Record<string, string> = {
  "conditioner.inclusion.very_short_not_needed":
    "Bei deiner Haarlänge braucht es nach der Wäsche keine zusätzliche Längenpflege.",
  "leave_in.inclusion.no_job":
    "Deine Angaben zeigen aktuell keine Aufgabe, die ein Leave-in übernehmen müsste.",
  "mask.inclusion.no_job": "Deine Längen zeigen aktuell keinen erhöhten Pflegebedarf.",
  "bondbuilder.inclusion.no_job":
    "Deine Angaben zeigen aktuell keine Belastung, die eine gezielte Strukturpflege nötig macht.",
  "deep_cleansing.inclusion.none":
    "Deine Produktnutzung hinterlässt keine Rückstände, für die eine Tiefenreinigung nötig wäre.",
  "deep_cleansing.inclusion.deferred_load":
    "Deine aktuelle Produktnutzung ist noch nicht erfasst – das klären wir später.",
  "dry_shampoo.inclusion.none":
    "Dein Ansatz fettet nicht so schnell nach, dass du eine Überbrückung brauchst.",
  "dry_shampoo.inclusion.declined_bridge":
    "Du möchtest kein Trockenshampoo zur Überbrückung nutzen.",
  "heat_protectant.inclusion.ordinary_airflow":
    "Deine Hitze-Anwendungen machen keinen eigenen Hitzeschutz nötig.",
  "heat_protectant.inclusion.no_heat_event": "Du stylst aktuell ohne Hitze.",
  "oil.pre_wash_fibre_treatment.no_job": "Vor der Haarwäsche brauchst du aktuell keine Ölpflege.",
  "oil.leave_on_fibre_conditioning.no_job":
    "Im feuchten Haar brauchst du aktuell keine zusätzliche Ölpflege.",
  "oil.dry_finish.no_job":
    "Für ein Finish im trockenen Haar gibt es bei dir aktuell keinen Anlass.",
  "scalp_care.inclusion.none":
    "Deine Kopfhaut zeigt aktuell nichts, was eine eigene Pflege nötig macht.",
  "scalp_care.inclusion.buildup_deferred":
    "Deine Kopfhaut-Angaben sind noch nicht vollständig – das klären wir später.",
}
