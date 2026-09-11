"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { MessageCircle, RefreshCw, SlidersHorizontal } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useToast } from "@/providers/toast-provider"
import { GemerktSection } from "@/components/routine/gemerkt-section"
import { launchRoutineChatTrigger, type RoutineChatTriggerType } from "@/lib/routines/chat-triggers"
import type { RoutineUiCard, RoutineUiShape } from "@/lib/routines/types"
import type { HairProfile } from "@/lib/types"
import type { ProductFrequency } from "@/lib/vocabulary/frequencies"
import { RoutineCard } from "./routine-card"
import { RoutineDrawer } from "./routine-drawer"

type RoutineApiBody =
  | { routine?: RoutineUiShape | { routine?: RoutineUiShape }; cards?: RoutineUiCard[] }
  | RoutineUiShape

type LoadState = "loading" | "ready" | "error"

const EMPTY_ROUTINE: RoutineUiShape = { hairProfile: null, cards: [] }

function extractRoutine(body: RoutineApiBody): RoutineUiShape {
  if ("cards" in body && Array.isArray(body.cards)) {
    return {
      hairProfile:
        "hairProfile" in body ? ((body.hairProfile ?? null) as HairProfile | null) : null,
      cards: body.cards,
    }
  }
  const routine = "routine" in body ? body.routine : null
  if (routine && "cards" in routine && Array.isArray(routine.cards)) {
    return {
      hairProfile: "hairProfile" in routine ? (routine.hairProfile ?? null) : null,
      cards: routine.cards,
    }
  }
  if (routine && "routine" in routine && routine.routine?.cards) return routine.routine
  return EMPTY_ROUTINE
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    return typeof body.error === "string" ? body.error : fallback
  } catch {
    return fallback
  }
}

export function RoutinePageClient({
  merklisteEnabled = false,
}: {
  /**
   * T16: server-derived freemium-flag gate for the „Gemerkt" section (see `RoutinePage`'s
   * doc comment) — never a client flag read. Defaults to `false` so every existing caller
   * of `<RoutinePageClient />` (this file's own legacy render, the source-pattern tests)
   * stays on today's exact behavior: no section, no `/api/scan/wishlist` fetch at all.
   */
  merklisteEnabled?: boolean
} = {}) {
  const router = useRouter()
  const { toast } = useToast()
  const [routine, setRoutine] = useState<RoutineUiShape>(EMPTY_ROUTINE)
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [drawerCardId, setDrawerCardId] = useState<string | null>(null)
  const cards = routine.cards
  const drawerCard = useMemo(
    () => cards.find((card) => card.id === drawerCardId) ?? null,
    [cards, drawerCardId],
  )

  const summary = useMemo(() => {
    // Three disjoint buckets: verified/active vs pending vs suggestions.
    const pending = cards.filter((card) => card.kind === "pending").length
    const suggestions = cards.filter((card) => card.kind === "suggestion").length
    const active = cards.length - pending - suggestions
    return { active, pending, suggestions }
  }, [cards])

  const loadRoutine = useCallback(async () => {
    setLoadState("loading")
    setError(null)
    try {
      const response = await fetch("/api/routine", { cache: "no-store" })
      if (!response.ok) {
        throw new Error(await readError(response, "Routine konnte nicht geladen werden."))
      }
      const body = (await response.json()) as RoutineApiBody
      setRoutine(extractRoutine(body))
      setLoadState("ready")
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Routine konnte nicht geladen werden.",
      )
      setLoadState("error")
    }
  }, [])

  useEffect(() => {
    void loadRoutine()
  }, [loadRoutine])

  // Card kind / action icon / target-delta text derive from CareBalance,
  // which only the server can recompute. After a successful frequency PATCH
  // we silently re-fetch the shaped routine (debounced across slider drags);
  // the optimistic value stays visible during the round-trip.
  const refreshSeq = useRef(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshRoutine = useCallback(async () => {
    const seq = refreshSeq.current
    try {
      const response = await fetch("/api/routine", { cache: "no-store" })
      if (!response.ok) return
      const body = (await response.json()) as RoutineApiBody
      // A newer mutation invalidated this snapshot — drop it.
      if (seq === refreshSeq.current) setRoutine(extractRoutine(body))
    } catch {
      // Keep the optimistic state; the next mutation re-fetches again.
    }
  }, [])

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [])

  const patchFrequency = useCallback(
    async (card: RoutineUiCard, frequency: ProductFrequency) => {
      if (!card.usageRow?.id) return
      const previousRoutine = routine
      refreshSeq.current += 1
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      setBusyKey(`frequency:${card.id}`)
      setError(null)
      setRoutine((current) => ({
        ...current,
        cards: current.cards.map((candidate) =>
          candidate.id === card.id
            ? {
                ...candidate,
                currentFrequency: frequency,
                usageRow: candidate.usageRow
                  ? { ...candidate.usageRow, frequency_range: frequency }
                  : candidate.usageRow,
              }
            : candidate,
        ),
      }))

      try {
        const response = await fetch(`/api/routine/products/${card.usageRow.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ frequency_range: frequency }),
        })

        if (!response.ok) {
          throw new Error(await readError(response, "Nutzung konnte nicht gespeichert werden."))
        }

        // Coalesce refreshes across quick successive slider changes.
        refreshTimer.current = setTimeout(() => void refreshRoutine(), 400)
      } catch {
        // Roll back the optimistic slider value and surface the failure.
        setRoutine(previousRoutine)
        toast({
          title: "Speichern fehlgeschlagen. Bitte versuche es noch einmal.",
          variant: "destructive",
        })
      } finally {
        setBusyKey(null)
      }
    },
    [routine, toast, refreshRoutine],
  )

  const removeUsage = useCallback(
    async (card: RoutineUiCard) => {
      if (!card.usageRow?.id) return
      const previousRoutine = routine
      setBusyKey(`remove:${card.id}`)
      setError(null)
      setDrawerCardId(null)
      setRoutine((current) => ({
        ...current,
        cards: current.cards.filter((candidate) => candidate.id !== card.id),
      }))

      try {
        const response = await fetch(`/api/routine/products/${card.usageRow.id}`, {
          method: "DELETE",
        })

        if (!response.ok) {
          throw new Error(await readError(response, "Produkt konnte nicht entfernt werden."))
        }
      } catch (removeError) {
        setRoutine(previousRoutine)
        setError(
          removeError instanceof Error
            ? removeError.message
            : "Produkt konnte nicht entfernt werden.",
        )
      } finally {
        setBusyKey(null)
      }
    },
    [routine],
  )

  const dismissSuggestion = useCallback(
    async (card: RoutineUiCard) => {
      const previousRoutine = routine
      setBusyKey(`dismiss:${card.id}`)
      setError(null)
      setRoutine((current) => ({
        ...current,
        cards: current.cards.filter((candidate) => candidate.id !== card.id),
      }))

      try {
        const response = await fetch(`/api/routine/suggestions/${card.category}/dismiss`, {
          method: "POST",
        })

        if (!response.ok) {
          throw new Error(await readError(response, "Vorschlag konnte nicht ausgeblendet werden."))
        }
      } catch (dismissError) {
        setRoutine(previousRoutine)
        setError(
          dismissError instanceof Error
            ? dismissError.message
            : "Vorschlag konnte nicht ausgeblendet werden.",
        )
      } finally {
        setBusyKey(null)
      }
    },
    [routine],
  )

  const startChat = useCallback(
    async (card: RoutineUiCard, type: RoutineChatTriggerType) => {
      setBusyKey(`chat:${card.id}:${type}`)
      setError(null)
      try {
        await launchRoutineChatTrigger(
          {
            type,
            cardId: card.id,
            usageId: card.usageRow?.id ?? null,
            productId: card.product?.id ?? null,
            category: card.category,
            categoryLabel: card.categoryLabel,
            productName: card.productName,
          },
          { navigate: router.push },
        )
      } catch (chatError) {
        setError(
          chatError instanceof Error ? chatError.message : "Chat konnte nicht gestartet werden.",
        )
        setBusyKey(null)
      }
    },
    [router],
  )

  const handleCardTap = useCallback(
    (card: RoutineUiCard) => {
      if (card.kind === "suggestion") {
        void startChat(card, "onboard_category")
        return
      }
      setDrawerCardId(card.id)
    },
    [startChat],
  )

  return (
    <>
      <main className="min-h-screen bg-background">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-5 sm:px-6">
          <section className="flex flex-col gap-4 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Routine
              </p>
              <h1 className="mt-1 text-2xl font-semibold text-[var(--text-heading)] sm:text-3xl">
                Deine aktuelle Haarpflege
              </h1>
            </div>
            <div className="grid min-w-[260px] grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-lg font-semibold text-[var(--text-heading)]">{summary.active}</p>
                <p className="text-muted-foreground">aktiv</p>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-lg font-semibold text-[var(--text-heading)]">
                  {summary.pending}
                </p>
                <p className="text-muted-foreground">in Prüfung</p>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-lg font-semibold text-[var(--text-heading)]">
                  {summary.suggestions}
                </p>
                <p className="text-muted-foreground">
                  {summary.suggestions === 1 ? "Vorschlag" : "Vorschläge"}
                </p>
              </div>
            </div>
          </section>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {loadState === "loading" && <RoutinePageSkeleton />}

          {loadState === "error" && (
            <section className="rounded-md border border-border p-6">
              <p className="text-sm text-muted-foreground">
                Die Routine ist gerade nicht verfügbar.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-4 w-auto"
                onClick={() => void loadRoutine()}
              >
                <RefreshCw className="h-4 w-4" />
                Erneut laden
              </Button>
            </section>
          )}

          {loadState === "ready" && cards.length === 0 && (
            <section className="rounded-md border border-border p-6">
              <h2 className="text-base font-semibold text-[var(--text-heading)]">
                Noch keine Routine gespeichert
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Sobald Produkte aus deinem Profil oder Chat erkannt wurden, erscheint hier deine
                stabile Routine-Übersicht. Sicher, dass du noch nichts eingetragen hast?
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-auto"
                  onClick={() => router.push("/onboarding")}
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  Onboarding anpassen
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-auto"
                  onClick={() => router.push("/chat")}
                >
                  <MessageCircle className="h-4 w-4" />
                  Im Chat starten
                </Button>
              </div>
            </section>
          )}

          {loadState === "ready" && cards.length > 0 && (
            <section className="flex flex-col gap-2.5">
              {cards.map((card) => (
                <RoutineCard
                  key={card.id}
                  card={card}
                  busy={Boolean(busyKey)}
                  onTap={handleCardTap}
                  onDismissSuggestion={(targetCard) => void dismissSuggestion(targetCard)}
                />
              ))}
            </section>
          )}

          <GemerktSection
            merklisteEnabled={merklisteEnabled}
            onGraduated={() => void refreshRoutine()}
          />
        </div>
      </main>
      <RoutineDrawer
        card={drawerCard}
        hairProfile={routine.hairProfile}
        busy={Boolean(busyKey)}
        onOpenChange={(open) => {
          if (!open) setDrawerCardId(null)
        }}
        onFrequencyChange={(targetCard, frequency) => void patchFrequency(targetCard, frequency)}
        onRemove={(targetCard) => void removeUsage(targetCard)}
        onChat={(targetCard, type) => void startChat(targetCard, type)}
      />
    </>
  )
}

function RoutinePageSkeleton() {
  return (
    <section className="flex flex-col gap-2.5">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <div
          key={index}
          className="grid grid-cols-[88px_1fr] items-center gap-3.5 rounded-[20px] border border-border bg-card p-3.5"
        >
          <div className="h-[100px] w-[88px] animate-pulse rounded-[14px] bg-primary/10" />
          <div className="min-w-0">
            <div className="h-3 w-24 animate-pulse rounded-md bg-primary/10" />
            <div className="mt-2 h-4 w-2/3 animate-pulse rounded-md bg-primary/10" />
            <div className="mt-2 h-3 w-20 animate-pulse rounded-md bg-primary/10" />
          </div>
        </div>
      ))}
    </section>
  )
}
