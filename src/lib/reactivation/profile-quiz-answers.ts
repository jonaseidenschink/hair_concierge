import {
  GOALS,
  HAIR_LENGTHS,
  PROFILE_CONCERNS,
  type Goal,
  type HairLength,
  type ProfileConcern,
} from "@/lib/vocabulary"
import { QUIZ_CONCERN_VALUES, normalizeStoredQuizAnswers } from "@/lib/quiz/normalization"
import type { QuizAnswers } from "@/lib/quiz/types"

/**
 * The deliberately small projection required to rebuild the quiz offer preview.
 * Values are unknown because old rows can predate the current canonical enums.
 */
export interface SavedHairProfileQuizSource {
  hair_texture?: unknown
  thickness?: unknown
  density?: unknown
  hair_length?: unknown
  cuticle_condition?: unknown
  protein_moisture_balance?: unknown
  scalp_type?: unknown
  scalp_condition?: unknown
  chemical_treatment?: unknown
  concerns?: unknown
  goals?: unknown
}

const STRUCTURE_BY_HAIR_TEXTURE: Record<string, NonNullable<QuizAnswers["structure"]>> = {
  straight: "straight",
  wavy: "wavy",
  curly: "curly",
  coily: "coily",
}

const THICKNESS_BY_PROFILE_VALUE: Record<string, NonNullable<QuizAnswers["thickness"]>> = {
  fine: "fine",
  normal: "normal",
  coarse: "coarse",
}

const DENSITY_BY_PROFILE_VALUE: Record<string, NonNullable<QuizAnswers["density"]>> = {
  low: "low",
  medium: "medium",
  high: "high",
}

const HAIR_LENGTH_BY_PROFILE_VALUE = Object.fromEntries(
  HAIR_LENGTHS.map((value) => [value, value]),
) as Record<string, HairLength>

const FINGERTEST_BY_CUTICLE: Record<string, NonNullable<QuizAnswers["fingertest"]>> = {
  smooth: "glatt",
  slightly_rough: "leicht_uneben",
  rough: "rau",
}

const PULLTEST_BY_BALANCE: Record<string, NonNullable<QuizAnswers["pulltest"]>> = {
  snaps: "snaps",
  stretches_bounces: "stretches_bounces",
  stretches_stays: "stretches_stays",
}

const SCALP_TYPE_BY_PROFILE_VALUE: Record<string, NonNullable<QuizAnswers["scalp_type"]>> = {
  oily: "fettig",
  balanced: "ausgeglichen",
  dry: "trocken",
}

const SCALP_CONDITION_BY_PROFILE_VALUE: Record<
  string,
  NonNullable<QuizAnswers["scalp_condition"]>
> = {
  dandruff: "schuppen",
  dry_flakes: "trockene_schuppen",
  irritated: "gereizt",
}

const TREATMENT_BY_PROFILE_VALUE: Record<string, string> = {
  natural: "natur",
  colored: "gefaerbt",
  bleached: "blondiert",
  permed: "dauerwelle",
  chemically_straightened: "chemisch_geglaettet",
}

const QUIZ_CONCERNS = new Set<string>(QUIZ_CONCERN_VALUES)
const PROFILE_CONCERN_VALUES = new Set<string>(PROFILE_CONCERNS)
const GOAL_VALUES = new Set<string>(GOALS)

function mappedValue<T extends string>(value: unknown, mapping: Record<string, T>): T | undefined {
  return typeof value === "string" ? mapping[value] : undefined
}

function mappedValues(value: unknown, mapping: Record<string, string>): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((entry) => {
    if (typeof entry !== "string") return []
    const mapped = mapping[entry]
    return mapped ? [mapped] : []
  })
}

function filterConcerns(value: unknown): ProfileConcern[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter(
    (entry): entry is ProfileConcern =>
      typeof entry === "string" && PROFILE_CONCERN_VALUES.has(entry) && QUIZ_CONCERNS.has(entry),
  )
}

function filterGoals(value: unknown): Goal[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is Goal => typeof entry === "string" && GOAL_VALUES.has(entry))
}

/**
 * Reconstruct the quiz-shaped input used by `buildQuizOfferPreview` from the
 * saved, canonical hair profile. Unknown legacy values are omitted so the
 * offer builder uses its existing conservative defaults instead of inventing
 * profile precision.
 */
export function buildQuizAnswersFromHairProfile(
  profile: SavedHairProfileQuizSource | null | undefined,
): QuizAnswers {
  const source = profile ?? {}
  const scalpCondition = mappedValue(source.scalp_condition, SCALP_CONDITION_BY_PROFILE_VALUE)

  return normalizeStoredQuizAnswers({
    structure: mappedValue(source.hair_texture, STRUCTURE_BY_HAIR_TEXTURE),
    thickness: mappedValue(source.thickness, THICKNESS_BY_PROFILE_VALUE),
    density: mappedValue(source.density, DENSITY_BY_PROFILE_VALUE),
    hair_length: mappedValue(source.hair_length, HAIR_LENGTH_BY_PROFILE_VALUE),
    fingertest: mappedValue(source.cuticle_condition, FINGERTEST_BY_CUTICLE),
    pulltest: mappedValue(source.protein_moisture_balance, PULLTEST_BY_BALANCE),
    scalp_type: mappedValue(source.scalp_type, SCALP_TYPE_BY_PROFILE_VALUE),
    has_scalp_issue: scalpCondition !== undefined,
    scalp_condition: scalpCondition,
    concerns: filterConcerns(source.concerns),
    treatment: mappedValues(source.chemical_treatment, TREATMENT_BY_PROFILE_VALUE),
    goals: filterGoals(source.goals),
  })
}
