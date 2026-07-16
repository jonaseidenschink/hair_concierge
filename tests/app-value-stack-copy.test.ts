import assert from "node:assert/strict"
import test from "node:test"

import type { QuizNeedLane, QuizConcern } from "../src/lib/quiz/need-lane"
import {
  buildAppValueStackHeroCopy,
  type AppValueStackHeroCopy,
} from "../src/lib/quiz/app-value-stack-copy"
import type { QuizResultNarrative } from "../src/lib/quiz/result-narrative"

const OUTCOME = "mehr Geschmeidigkeit & Kontrolle"

function makeNarrative(primaryConcern: QuizConcern | null): QuizResultNarrative {
  return {
    heroHeadline: "Dein Ergebnis",
    intro: "Einleitung",
    rows: [
      {
        label: "Haargefühl",
        scope: "HAAR",
        before: "vorher",
        after: "nachher",
        iconKey: "sparkles",
        tickBefore: "vorher",
        tickAfter: "nachher",
        currentPosition: 30,
        targetPosition: 70,
      },
      {
        label: "Was dich gerade ausbremst",
        scope: "HAAR",
        before: "unpassende Pflege",
        after: "passende Pflege",
        iconKey: "shield",
        tickBefore: "vorher",
        tickAfter: "nachher",
        currentPosition: 30,
        targetPosition: 70,
      },
      {
        label: "Worauf wir hinarbeiten",
        scope: "LÄNGEN",
        before: "wenig Kontrolle",
        after: OUTCOME,
        iconKey: "sparkles",
        tickBefore: "unruhig",
        tickAfter: "kontrolliert",
        currentPosition: 30,
        targetPosition: 70,
      },
    ],
    needs: {
      title: "Was dein Haar jetzt braucht",
      mainLeverTitle: "Pflegebasis",
      mainLeverWhy: "Warum",
      mainLeverProducts: "Produkte",
      products: [
        { name: "Shampoo", description: "Reinigt." },
        { name: "Conditioner", description: "Pflegt." },
      ],
    },
    cta: { lead: "Als Nächstes", label: "Starten", subline: "Mehr erfahren" },
    primaryConcern,
    primaryGoal: "less_frizz",
  }
}

const EXPECTED_ACTIONS: Record<QuizNeedLane, string> = {
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

for (const [lane, action] of Object.entries(EXPECTED_ACTIONS) as [QuizNeedLane, string][]) {
  test(`uses the approved action sentence for the ${lane} lane`, () => {
    const copy = buildAppValueStackHeroCopy({
      name: "Lea Marie",
      narrative: makeNarrative("frizz"),
      lane,
    })

    assert.equal(copy.headline, `Lea, dein 4-Wochen-Weg zu ${OUTCOME}.`)
    assert.equal(copy.intro, `Frizz ist dein wichtigster Pflegefokus. ${action}`)
    assert.doesNotMatch(copy.headline, /erreichst|bekommst du/i)
  })
}

const CONCERN_LEADS: Record<QuizConcern, string> = {
  frizz: "Frizz ist dein wichtigster Pflegefokus.",
  dryness: "Trockenheit ist dein wichtigster Pflegefokus.",
  breakage: "Haarbruch ist dein wichtigster Pflegefokus.",
  split_ends: "Spliss ist dein wichtigster Pflegefokus.",
  tangling: "Verknotungen sind dein wichtigster Pflegefokus.",
  hair_damage: "Strapaziertes Haar ist dein wichtigster Pflegefokus.",
}

test("uses grammar-safe copy for every supported primary concern", () => {
  for (const [primaryConcern, concernLead] of Object.entries(CONCERN_LEADS) as [
    QuizConcern,
    string,
  ][]) {
    const copy = buildAppValueStackHeroCopy({
      name: "Lea",
      narrative: makeNarrative(primaryConcern),
      lane: "base",
    })

    assert.equal(copy.intro, `${concernLead} ${EXPECTED_ACTIONS.base}`)
    assert.doesNotMatch(copy.intro, /von unpassende Pflege/)
  }
})

test("uses the computed outcome and anonymous headline when no name or concern exists", () => {
  const copy = buildAppValueStackHeroCopy({
    name: "   ",
    narrative: makeNarrative(null),
    lane: "base",
  })

  assert.equal(copy.headline, `Dein 4-Wochen-Weg zu ${OUTCOME}.`)
  assert.equal(copy.intro, `Dein Ziel: ${OUTCOME}. ${EXPECTED_ACTIONS.base}`)
})

test("returns deterministic copy for identical inputs", () => {
  const input = {
    name: "  Lea Marie ",
    narrative: makeNarrative("dryness"),
    lane: "deep_moisture" as const,
  }

  const first: AppValueStackHeroCopy = buildAppValueStackHeroCopy(input)
  const second: AppValueStackHeroCopy = buildAppValueStackHeroCopy(input)

  assert.deepEqual(first, second)
})
