/**
 * Opener contract for the Premium sheet (T5, freemium-scanner-first PR1).
 *
 * Every gate that wants to show the Premium sheet (nav locks, API 402/403 responses, the
 * scan verdict, profile edits, ...) hands the sheet a `PremiumSheetContext` describing
 * which feature the user just bumped into and where. This file only carries the contract
 * and its German copy registry — no payment or pricing code lives here (that's PR4).
 */

export type PremiumFeatureId =
  | "empfehlungen"
  | "merkliste"
  | "routine"
  | "anwendung"
  | "chat"
  | "haarcheck"
  | "verfeinerung"

export interface PremiumSheetContext {
  feature: PremiumFeatureId
  /** Free-form surface identifier, e.g. "scan:verdict", "nav-tab", "profil". */
  source: string
}

/** German copy, approved verbatim — do not paraphrase. */
export const PREMIUM_FEATURES: Record<PremiumFeatureId, { name: string; benefit: string }> = {
  empfehlungen: {
    name: "Empfehlungen",
    benefit: "Bei jedem Scan sofort die bessere Alternative — mit Preis und Fundort.",
  },
  merkliste: {
    name: "Merkliste",
    benefit: "Gemerkte Produkte, gesammelt in deiner Routine — für den nächsten Einkauf.",
  },
  routine: {
    name: "Deine Routine",
    benefit: "Vier geprüfte Bausteine, die zusammenpassen.",
  },
  anwendung: {
    name: "Deine Anwendung",
    benefit: "Jeder Haartag begleitet, Schritt für Schritt.",
  },
  chat: {
    name: "Chaarlie Chat",
    benefit: "Antworten, die dein Profil kennen.",
  },
  haarcheck: {
    name: "Haar-Check bearbeiten",
    benefit: "Deine Antworten anpassen, wann immer sich etwas ändert.",
  },
  verfeinerung: {
    name: "Profil-Verfeinerung",
    benefit: "Kurze Fragen zu Gewohnheiten und Alltag — für noch genauere Empfehlungen.",
  },
}
