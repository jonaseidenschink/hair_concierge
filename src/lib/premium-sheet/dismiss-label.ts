import type { PremiumSheetContext } from "./context"

/**
 * The sheet's explicit escape label (T13). Declining is always one obvious tap, and the
 * label names what the user goes back to rather than a guilt line: the scanner surfaces
 * (T9's verdict, T10's triggers) return to scanning, every other opener — the gated
 * „Beispiel" pages, profile gates — just defers.
 *
 * The X, the backdrop, Escape and the drag handle dismiss the sheet too (BottomSheet
 * primitive); this is the labelled one.
 */
export const PREMIUM_SHEET_SCAN_DISMISS_LABEL = "Weiter scannen"
export const PREMIUM_SHEET_DEFAULT_DISMISS_LABEL = "Später"

export function premiumSheetDismissLabel(context: PremiumSheetContext | null): string {
  const source = context?.source ?? ""
  return source.startsWith("scan:") || source.startsWith("trigger:")
    ? PREMIUM_SHEET_SCAN_DISMISS_LABEL
    : PREMIUM_SHEET_DEFAULT_DISMISS_LABEL
}
