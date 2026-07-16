export const TRACKER_DAY_TYPES = [
  "wash",
  "clarifying",
  "treatment_only",
  "styling_only",
  "none",
  "custom",
] as const

export type TrackerDayType = (typeof TRACKER_DAY_TYPES)[number]

export const WASH_DAY_TYPES: readonly TrackerDayType[] = ["wash", "clarifying"]

export const TRACKER_DAY_TYPE_LABELS_DE: Record<TrackerDayType, string> = {
  wash: "Haare gewaschen",
  clarifying: "Klärwäsche",
  treatment_only: "Pflege ohne Wäsche",
  styling_only: "Styling aufgefrischt",
  none: "Keine Haarpflege",
  custom: "Eigene Aktivität",
}

export const CUSTOM_ACTIVITY_NAME_MIN_LENGTH = 1
export const CUSTOM_ACTIVITY_NAME_MAX_LENGTH = 60

export function normalizeCustomActivityName(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? ""
  return normalized.length === 0 ? null : normalized
}

export function isValidCustomActivityName(value: string | null | undefined): boolean {
  const normalized = normalizeCustomActivityName(value)
  return (
    normalized !== null &&
    normalized.length >= CUSTOM_ACTIVITY_NAME_MIN_LENGTH &&
    normalized.length <= CUSTOM_ACTIVITY_NAME_MAX_LENGTH
  )
}

export function hasValidTrackerDayTypeDetails(input: {
  dayType: TrackerDayType
  customActivityName?: string | null
}): boolean {
  if (input.dayType === "custom") return isValidCustomActivityName(input.customActivityName)
  return input.customActivityName == null
}

export interface TrackerLogProduct {
  category: string
  productName: string | null
  userProductUsageId: string | null
}

export interface TrackerLogDay {
  loggedOn: string
  dayType: TrackerDayType
  customActivityName?: string | null
  /** Omitted for persisted days; false keeps a local draft out of derived signals. */
  confirmed?: boolean
  products: TrackerLogProduct[]
}

export function getTrustGateQualifyingLogDates(days: readonly TrackerLogDay[]): string[] {
  return days
    .filter((day) => day.confirmed !== false && day.dayType !== "custom")
    .map((day) => day.loggedOn)
}

export const TRACKER_CATEGORY_LABELS_DE: Record<string, string> = {
  shampoo: "Shampoo",
  conditioner: "Conditioner",
  mask: "Maske",
  leave_in: "Leave-in",
  oil: "Haaröl",
  dry_shampoo: "Trockenshampoo",
  deep_cleansing_shampoo: "Tiefenreinigung",
  bondbuilder: "Bondbuilder",
  heat_protectant: "Hitzeschutz",
  serum: "Serum",
  scrub: "Scrub",
  peeling: "Peeling",
  styling_gel: "Styling-Gel",
  styling_mousse: "Schaumfestiger",
  styling_cream: "Styling-Creme",
  hairspray: "Haarspray",
}

export const PRECHECK_CATEGORIES: Record<TrackerDayType, ReadonlySet<string>> = {
  wash: new Set(["shampoo", "conditioner", "leave_in"]),
  clarifying: new Set(["deep_cleansing_shampoo", "shampoo", "conditioner"]),
  treatment_only: new Set(["mask", "bondbuilder", "oil"]),
  styling_only: new Set([]),
  none: new Set([]),
  custom: new Set([]),
}
