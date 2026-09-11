import type { PremiumSheetPurchaseFailure } from "@/lib/premium-sheet/purchase-state"

/**
 * Every German string the purchase step of the Premium sheet introduces
 * (freemium-scanner-first T14), in one place so the invented copy is countable and
 * reviewable rather than scattered through JSX.
 *
 * Telegram-style throughout: one job per line, no reassurance padding, no exclamation
 * marks, no claim the product cannot keep.
 */
export const PREMIUM_SHEET_PURCHASE_COPY = {
  /** Journey step 9, brief-binding — the unlock confirmation. */
  unlockToast: "Alles freigeschaltet",
  /** Shown under the toast title only while the Routine is still being built. */
  unlockToastRoutinePending: "Deine Routine wird gerade erstellt.",
  /** Back out of the payment step without leaving the sheet (reuses the offer's label). */
  backToPlans: "Plan ändern",
  /** Between „onComplete" and the server's verdict. Deliberately not „Geschafft". */
  verifying: "Wir prüfen deine Zahlung …",
  /** Asynchronous payment method still settling. */
  pendingTitle: "Zahlung läuft noch",
  pendingBody: "Sobald sie durch ist, schalten wir frei. Du musst nichts tun.",
  /**
   * Paid, entitled — but the plan could not be built on this call (Codex fix wave, Y1).
   * Says exactly that, because „Alles freigeschaltet" would be false.
   */
  provisioningTitle: "Zahlung bestätigt",
  provisioningBody: "Dein Plan wird vorbereitet. Das dauert einen Moment.",
  /** The same state, once retrying stopped helping — no false promise of a wait. */
  provisioningStalledBody: "Dein Plan ist noch nicht fertig. Wir kümmern uns darum.",
  /** Manual fallback whenever the automatic poll is running or exhausted. */
  recheck: "Status prüfen",
  /**
   * Non-terminal: the completion endpoint is rate-limited, not refusing the purchase (Codex
   * fix wave round 2, R3). The schedule (or the next manual tap) tries again on its own.
   */
  rateLimited: "Einen Moment — wir prüfen gleich erneut.",
  /** Recoverable failures. One line each, then the retry. */
  checkoutUnavailable: "Die Zahlung konnte nicht gestartet werden.",
  providerUnavailable: "Das Bezahlformular konnte nicht geladen werden.",
  verificationFailed: "Wir konnten deine Zahlung nicht bestätigen.",
  /**
   * Terminal, and NOT a generic verification failure: PayPal's duplicate guard already
   * cancelled the second subscription, and the buyer keeps the access they had. Saying
   * „Wir konnten deine Zahlung nicht bestätigen." here would be false on both halves.
   */
  subscriptionAlreadyActive:
    "Du hast bereits ein aktives Abo. Wir haben die neue Zahlung gestoppt.",
  checkoutExpired: "Die Zahlung ist abgelaufen.",
  checkoutAbandoned: "Die Zahlung wurde abgebrochen.",
  /** Existing repo-wide retry label. */
  retry: "Erneut versuchen",
  /**
   * `subscription_already_active`'s own CTA (final cleanup batch, Nick-approved). Retrying
   * would only hit the duplicate guard again — the buyer already has what they were trying
   * to buy, so the primary action is closing the sheet, not another attempt.
   */
  close: "Schließen",
} as const

export function premiumSheetPurchaseFailureCopy(reason: PremiumSheetPurchaseFailure): string {
  if (reason === "checkout_unavailable") return PREMIUM_SHEET_PURCHASE_COPY.checkoutUnavailable
  if (reason === "provider_unavailable") return PREMIUM_SHEET_PURCHASE_COPY.providerUnavailable
  if (reason === "checkout_expired") return PREMIUM_SHEET_PURCHASE_COPY.checkoutExpired
  if (reason === "checkout_abandoned") return PREMIUM_SHEET_PURCHASE_COPY.checkoutAbandoned
  if (reason === "subscription_already_active") {
    return PREMIUM_SHEET_PURCHASE_COPY.subscriptionAlreadyActive
  }
  return PREMIUM_SHEET_PURCHASE_COPY.verificationFailed
}
