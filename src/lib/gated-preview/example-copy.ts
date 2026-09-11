import type { PremiumFeatureId } from "@/lib/premium-sheet/context"

/**
 * The per-page German copy for the three T12 „Beispiel" pages.
 *
 * Deliberately NOT `PREMIUM_FEATURES[feature].benefit`: the PremiumSheet already shows
 * that line the moment the CTA opens it, so repeating it above the CTA would say the
 * same sentence twice in two seconds (T11 carry-forward 2). These lines answer a
 * different question — "what changes for me if I unlock THIS page?" — and never fall
 * back to a generic "Premium freischalten".
 */
export type GatedExampleCopy = {
  feature: PremiumFeatureId
  source: string
  exampleLabel: string
  benefit: string
  cta: string
}

export const GATED_EXAMPLE_COPY = {
  routine: {
    feature: "routine",
    source: "gated:routine",
    exampleLabel: "Beispiel · eine Chaarlie-Routine",
    benefit: "Mit Premium: deine eigene Routine aus deinen Produkten.",
    cta: "Routine freischalten",
  },
  anwendung: {
    feature: "anwendung",
    source: "gated:anwendung",
    exampleLabel: "Beispiel · eine Chaarlie-Anwendung",
    benefit: "Mit Premium: jeder Haartag, Schritt für Schritt.",
    cta: "Anwendung freischalten",
  },
  chat: {
    feature: "chat",
    source: "gated:chat",
    exampleLabel: "Beispiel · ein Chaarlie-Chat",
    benefit: "Mit Premium: deine Haarfragen, jederzeit beantwortet.",
    cta: "Chat freischalten",
  },
} as const satisfies Record<string, GatedExampleCopy>
