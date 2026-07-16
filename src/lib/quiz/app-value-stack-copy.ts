import type { QuizNeedLane, QuizConcern } from "./need-lane"
import type { QuizResultNarrative } from "./result-narrative"

export const APP_VALUE_STACK_CTA_LABEL = "Routine freischalten"

const CONCERN_LEADS: Record<QuizConcern, string> = {
  frizz: "Frizz ist dein wichtigster Pflegefokus.",
  dryness: "Trockenheit ist dein wichtigster Pflegefokus.",
  breakage: "Haarbruch ist dein wichtigster Pflegefokus.",
  split_ends: "Spliss ist dein wichtigster Pflegefokus.",
  tangling: "Verknotungen sind dein wichtigster Pflegefokus.",
  hair_damage: "Strapaziertes Haar ist dein wichtigster Pflegefokus.",
}

const LANE_ACTIONS: Record<QuizNeedLane, string> = {
  scalp_focus: "Deine Pflegebasis beginnt deshalb mit einer passend abgestimmten Reinigung.",
  bond_repair: "Deine Pflegebasis setzt deshalb auf Schutz und gezielte Strukturpflege.",
  protein:
    "Deine Pflegebasis verbindet deshalb ausgewogene Basispflege mit gezielter Strukturunterstützung.",
  deep_moisture:
    "Deine Pflegebasis setzt deshalb auf milde Reinigung und gezielte Feuchtigkeitspflege.",
  surface_support:
    "Deine Pflegebasis setzt deshalb auf Geschmeidigkeit und Schutz zwischen den Haarwäschen.",
  ends_protection: "Deine Pflegebasis ergänzt deshalb die Basispflege um gezielten Spitzenschutz.",
  base: "Deine Pflegebasis startet deshalb bewusst einfach mit Shampoo und Conditioner.",
}

type AppValueStackHeroCopyInput = {
  name?: string | null
  narrative: QuizResultNarrative
  lane: QuizNeedLane
}

export type AppValueStackHeroCopy = {
  headline: string
  intro: string
}

function getFirstName(name: string | null | undefined): string | null {
  return name?.trim().split(/\s+/)[0] || null
}

export function buildAppValueStackHeroCopy({
  name,
  narrative,
  lane,
}: AppValueStackHeroCopyInput): AppValueStackHeroCopy {
  const firstName = getFirstName(name)
  const outcome = narrative.rows[2].after
  const laneAction = LANE_ACTIONS[lane]

  return {
    headline: firstName
      ? `${firstName}, dein 4-Wochen-Weg zu ${outcome}.`
      : `Dein 4-Wochen-Weg zu ${outcome}.`,
    intro: narrative.primaryConcern
      ? `${CONCERN_LEADS[narrative.primaryConcern]} ${laneAction}`
      : `Dein Ziel: ${outcome}. ${laneAction}`,
  }
}
