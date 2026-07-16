import { PRODUCT_CATEGORY_ORDER } from "@/lib/onboarding/product-options"

import type { TrackerDayType } from "./types"

export interface TrackerActivityPresentation {
  label: string
  description: string
}

export const TRACKER_ACTIVITY_PRESENTATION_DE: Record<TrackerDayType, TrackerActivityPresentation> =
  {
    wash: { label: "Haare gewaschen", description: "Mit Shampoo oder Co-Wash" },
    clarifying: { label: "Klärwäsche", description: "Mit klärendem Shampoo" },
    treatment_only: { label: "Pflege ohne Wäsche", description: "Maske, Kur oder Öl" },
    styling_only: { label: "Styling aufgefrischt", description: "Mit Wasser oder Stylingprodukt" },
    none: { label: "Keine Haarpflege", description: "Keine Produkte verwendet" },
    custom: { label: "Eigene Aktivität", description: "Für alles, was sonst nicht passt" },
  }

export const TRACKER_PROFILE_DISCLAIMER_DE = "Produkte kannst du in deinem Profil verwalten."

export const TRACKER_PREFILL_SOURCE_COPY_DE = "Wie bei deinem letzten ähnlichen Eintrag."

export const TRACKER_LIKELY_CATEGORIES: Record<TrackerDayType, readonly string[]> = {
  wash: ["shampoo", "conditioner", "leave_in"],
  clarifying: ["deep_cleansing_shampoo", "shampoo", "conditioner"],
  treatment_only: ["mask", "bondbuilder", "oil"],
  styling_only: [],
  none: [],
  custom: [],
}

export interface TrackerShelfItem {
  usageId: string
  category: string
  productName: string | null
}

const categoryOrder = new Map(PRODUCT_CATEGORY_ORDER.map((category, index) => [category, index]))

function normalizedName(value: string | null): string {
  return (value ?? "")
    .trim()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("de")
}

export function sortTrackerShelf<T extends TrackerShelfItem>(shelf: readonly T[]): T[] {
  return [...shelf].sort((left, right) => {
    const categoryDifference =
      (categoryOrder.get(left.category) ?? Number.MAX_SAFE_INTEGER) -
      (categoryOrder.get(right.category) ?? Number.MAX_SAFE_INTEGER)
    if (categoryDifference !== 0) return categoryDifference

    const nameDifference = normalizedName(left.productName).localeCompare(
      normalizedName(right.productName),
      "de",
    )
    if (nameDifference !== 0) return nameDifference
    return left.usageId.localeCompare(right.usageId)
  })
}

export function orderTrackerShelfForActivity<T extends TrackerShelfItem>(
  dayType: TrackerDayType,
  shelf: readonly T[],
): { likely: T[]; remaining: T[] } {
  const sorted = sortTrackerShelf(shelf)
  const likelyCategories = new Set(TRACKER_LIKELY_CATEGORIES[dayType])
  if (dayType === "custom" || dayType === "none") return { likely: [], remaining: sorted }

  return {
    likely: sorted.filter((item) => likelyCategories.has(item.category)),
    remaining: sorted.filter((item) => !likelyCategories.has(item.category)),
  }
}
