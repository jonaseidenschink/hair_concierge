"use client"

import { format } from "date-fns"
import { de } from "date-fns/locale"
import { CalendarPlus, CheckCircle2, ChevronRight, PencilLine, RotateCcw } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { LogDayCard, type ShelfItem } from "@/components/tracker/log-day-card"
import {
  getPricingRedirectTarget,
  useTrackerAutosave,
} from "@/components/tracker/use-tracker-autosave"
import {
  NudgeCard,
  RhythmBand,
  WeekStrip,
  type WeekStripDay,
} from "@/components/tracker/tracker-widgets"
import { TRACKER_ACTIVITY_PRESENTATION_DE } from "@/lib/tracking/presentation"
import { buildRhythmSummary, type RhythmTarget } from "@/lib/tracking/rhythm"
import {
  isValidCustomActivityName,
  PRECHECK_CATEGORIES,
  type TrackerDayType,
  type TrackerLogDay,
  type TrackerLogProduct,
} from "@/lib/tracking/types"

interface TrackerApiBody {
  days: TrackerLogDay[]
  gate: {
    unlocked: boolean
    daysRemaining: number
    loggedDayCount: number
  }
  nudges: Array<{
    category: string
    direction: "increase" | "decrease"
    message: string
  }>
  rhythm: {
    washesThisWeek: number
    targetWashesPerWeek: number | null
    frequencyTarget: RhythmTarget | null
  }
  rhythmHistory: Array<{ loggedOn: string; dayType: TrackerDayType }>
  shelf: ShelfItem[]
  today: string
}

type TrackerNudge = TrackerApiBody["nudges"][number]

type LoadState = "loading" | "ready" | "error"

const DAY_MS = 24 * 60 * 60 * 1000
const UNDO_DURATION_MS = 6_000

function shiftDate(dateIso: string, days: number): string {
  return new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

function dateLabel(dateIso: string, today: string): string {
  const label = format(new Date(`${dateIso}T00:00:00`), "EEEE, d. MMMM", { locale: de })
  return dateIso === today ? label : `${label} · Nachtrag`
}

function productKey(product: TrackerLogProduct): string {
  return product.userProductUsageId ?? `${product.category}:${product.productName ?? ""}`
}

function upsertDay(days: TrackerLogDay[], day: TrackerLogDay): TrackerLogDay[] {
  return [...days.filter((candidate) => candidate.loggedOn !== day.loggedOn), day].sort(
    (left, right) => left.loggedOn.localeCompare(right.loggedOn),
  )
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

export function TrackerPageClient() {
  const [state, setState] = useState<LoadState>("loading")
  const [data, setData] = useState<TrackerApiBody | null>(null)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [draftsByDate, setDraftsByDate] = useState<Record<string, TrackerLogDay>>({})
  const [deletedDates, setDeletedDates] = useState<Set<string>>(new Set())
  const [prefillDates, setPrefillDates] = useState<Set<string>>(new Set())
  const [undo, setUndo] = useState<{ date: string; day: TrackerLogDay } | null>(null)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestValidDaysRef = useRef(new Map<string, TrackerLogDay>())
  const needsServerRefreshRef = useRef(false)
  const refreshGenerationRef = useRef(0)
  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin",
    [],
  )

  const refresh = useCallback(
    async (preserveCurrentState = false) => {
      const generation = ++refreshGenerationRef.current
      try {
        const response = await fetch(`/api/tracker?tz=${encodeURIComponent(timezone)}`, {
          cache: "no-store",
        })
        const pricingRedirect = getPricingRedirectTarget(response)
        if (pricingRedirect) {
          window.location.assign(pricingRedirect)
          return
        }
        if (!response.ok) throw new Error(String(response.status))
        const body = (await response.json()) as TrackerApiBody
        if (generation !== refreshGenerationRef.current) return
        setData(body)
        setSelectedDate((previous) => previous ?? body.today)
        setState("ready")
      } catch {
        if (generation === refreshGenerationRef.current && !preserveCurrentState) setState("error")
      }
    },
    [timezone],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(
    () => () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    },
    [],
  )

  const handlePersisted = useCallback(
    (result: { kind: "save" | "delete"; loggedOn: string; day: TrackerLogDay | null }) => {
      if (result.day) latestValidDaysRef.current.set(result.loggedOn, result.day)
      else latestValidDaysRef.current.delete(result.loggedOn)
      setData((previous) => {
        if (!previous) return previous
        const nextDays = result.day
          ? upsertDay(previous.days, { ...result.day, confirmed: true })
          : previous.days.filter((day) => day.loggedOn !== result.loggedOn)
        const nextHistory = previous.rhythmHistory.filter((day) => day.loggedOn !== result.loggedOn)
        if (result.day && result.day.dayType !== "custom") {
          nextHistory.push({ loggedOn: result.day.loggedOn, dayType: result.day.dayType })
          nextHistory.sort((left, right) => left.loggedOn.localeCompare(right.loggedOn))
        }
        return { ...previous, days: nextDays, rhythmHistory: nextHistory }
      })
      setDraftsByDate((previous) => withoutKey(previous, result.loggedOn))
      setDeletedDates((previous) => {
        const next = new Set(previous)
        next.delete(result.loggedOn)
        return next
      })
      needsServerRefreshRef.current = true
    },
    [],
  )

  const handleQueueIdle = useCallback(() => {
    if (!needsServerRefreshRef.current) return
    needsServerRefreshRef.current = false
    void refresh(true)
  }, [refresh])

  const autosave = useTrackerAutosave({
    onPersisted: handlePersisted,
    onQueueIdle: handleQueueIdle,
  })

  const confirmedDay = useMemo(() => {
    if (!data || !selectedDate) return null
    return data.days.find((day) => day.loggedOn === selectedDate) ?? null
  }, [data, selectedDate])

  const selectedDay = useMemo(() => {
    if (!selectedDate || deletedDates.has(selectedDate)) return null
    return draftsByDate[selectedDate] ?? confirmedDay
  }, [confirmedDay, deletedDates, draftsByDate, selectedDate])

  const queueDay = useCallback(
    (day: TrackerLogDay) => {
      if (!autosave.ready) return
      autosave.queueSave({
        kind: "save",
        loggedOn: day.loggedOn,
        timezone,
        dayType: day.dayType,
        customActivityName: day.dayType === "custom" ? (day.customActivityName ?? null) : null,
        products: day.products,
      })
    },
    [autosave, timezone],
  )

  const setDraftAndQueue = useCallback(
    (day: TrackerLogDay) => {
      const draft = { ...day, confirmed: false }
      setDeletedDates((previous) => {
        const next = new Set(previous)
        next.delete(day.loggedOn)
        return next
      })
      setDraftsByDate((previous) => ({ ...previous, [day.loggedOn]: draft }))
      if (day.dayType !== "custom" || isValidCustomActivityName(day.customActivityName)) {
        latestValidDaysRef.current.set(day.loggedOn, draft)
        queueDay(draft)
      } else {
        autosave.discardPending(day.loggedOn)
      }
    },
    [autosave, queueDay],
  )

  const lastSameActivityProducts = useCallback(
    (dayType: TrackerDayType, loggedOn: string): TrackerLogProduct[] | null => {
      if (!data || dayType === "custom" || dayType === "none") return null
      const previous = data.days
        .filter((day) => day.loggedOn < loggedOn && day.dayType === dayType)
        .sort((left, right) => right.loggedOn.localeCompare(left.loggedOn))[0]
      return previous?.products ?? null
    },
    [data],
  )

  const handleSelectDayType = useCallback(
    (dayType: TrackerDayType) => {
      if (!data || !selectedDate || selectedDay?.dayType === dayType) return
      const previousProducts = lastSameActivityProducts(dayType, selectedDate)
      const products: TrackerLogProduct[] =
        dayType === "none" || dayType === "custom"
          ? []
          : (previousProducts ??
            data.shelf
              .filter((item) => PRECHECK_CATEGORIES[dayType].has(item.category))
              .map((item) => ({
                category: item.category,
                productName: item.productName,
                userProductUsageId: item.usageId,
              })))
      setPrefillDates((previous) => {
        const next = new Set(previous)
        if (previousProducts?.length) next.add(selectedDate)
        else next.delete(selectedDate)
        return next
      })
      setDraftAndQueue({
        loggedOn: selectedDate,
        dayType,
        customActivityName: dayType === "custom" ? "" : null,
        products,
      })
    },
    [data, lastSameActivityProducts, selectedDate, selectedDay?.dayType, setDraftAndQueue],
  )

  const handleCustomNameChange = useCallback(
    (name: string) => {
      if (!selectedDay || selectedDay.dayType !== "custom") return
      setDraftAndQueue({ ...selectedDay, customActivityName: name })
    },
    [selectedDay, setDraftAndQueue],
  )

  const handleToggleProduct = useCallback(
    (product: TrackerLogProduct, checked: boolean) => {
      if (!selectedDay) return
      const key = productKey(product)
      const nextProducts = checked
        ? [...selectedDay.products.filter((candidate) => productKey(candidate) !== key), product]
        : selectedDay.products.filter((candidate) => productKey(candidate) !== key)
      if (selectedDate) {
        setPrefillDates((previous) => {
          const next = new Set(previous)
          next.delete(selectedDate)
          return next
        })
      }
      setDraftAndQueue({ ...selectedDay, products: nextProducts })
    },
    [selectedDate, selectedDay, setDraftAndQueue],
  )

  const handleSheetOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setSheetOpen(true)
        return
      }
      if (
        selectedDay?.dayType === "custom" &&
        !isValidCustomActivityName(selectedDay.customActivityName)
      ) {
        const latestValidDay = selectedDate
          ? (latestValidDaysRef.current.get(selectedDate) ?? confirmedDay)
          : null
        if (selectedDate) {
          setDraftsByDate((previous) => withoutKey(previous, selectedDate))
          if (latestValidDay) {
            latestValidDaysRef.current.set(selectedDate, latestValidDay)
            queueDay(latestValidDay)
          } else if (autosave.hasDispatched(selectedDate)) {
            autosave.queueSave({ kind: "delete", loggedOn: selectedDate, timezone })
          }
        }
        void autosave.flush()
      } else {
        void autosave.flush()
      }
      setSheetOpen(false)
    },
    [autosave, confirmedDay, queueDay, selectedDate, selectedDay, timezone],
  )

  const handleDone = useCallback(async () => {
    if (
      selectedDay?.dayType === "custom" &&
      !isValidCustomActivityName(selectedDay.customActivityName)
    ) {
      return
    }
    await autosave.flush()
    if (selectedDate && autosave.getRawState(selectedDate).status === "error") return
    setSheetOpen(false)
  }, [autosave, selectedDate, selectedDay])

  const handleDelete = useCallback(() => {
    if (!selectedDate || !selectedDay || !autosave.ready) return
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    const snapshot = { ...selectedDay, products: [...selectedDay.products] }
    setUndo({ date: selectedDate, day: snapshot })
    undoTimerRef.current = setTimeout(() => setUndo(null), UNDO_DURATION_MS)
    setDeletedDates((previous) => new Set(previous).add(selectedDate))
    setDraftsByDate((previous) => withoutKey(previous, selectedDate))
    latestValidDaysRef.current.delete(selectedDate)
    autosave.queueSave({ kind: "delete", loggedOn: selectedDate, timezone })
    setSheetOpen(false)
  }, [autosave, selectedDate, selectedDay, timezone])

  const handleUndo = useCallback(() => {
    if (!undo) return
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    setDeletedDates((previous) => {
      const next = new Set(previous)
      next.delete(undo.date)
      return next
    })
    setDraftAndQueue(undo.day)
    setUndo(null)
  }, [setDraftAndQueue, undo])

  const handleSelectDate = useCallback(
    (date: string) => {
      void autosave.flush()
      setSelectedDate(date)
      setSheetOpen(false)
    },
    [autosave],
  )

  const dismissNudge = useCallback(
    async (category: string, direction: "increase" | "decrease") => {
      const dismissedIndex = data?.nudges.findIndex((nudge) => nudge.category === category) ?? -1
      const dismissedNudge: TrackerNudge | null =
        dismissedIndex >= 0 ? (data?.nudges[dismissedIndex] ?? null) : null
      const restoreNudge = () => {
        if (!dismissedNudge) return
        setData((previous) => {
          if (!previous || previous.nudges.some((nudge) => nudge.category === category)) {
            return previous
          }
          const nudges = [...previous.nudges]
          nudges.splice(Math.min(dismissedIndex, nudges.length), 0, dismissedNudge)
          return { ...previous, nudges }
        })
      }

      setData((previous) =>
        previous
          ? {
              ...previous,
              nudges: previous.nudges.filter((nudge) => nudge.category !== category),
            }
          : previous,
      )

      try {
        const response = await fetch("/api/tracker/dismiss-nudge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category, direction }),
        })
        const pricingRedirect = getPricingRedirectTarget(response)
        if (pricingRedirect) {
          window.location.assign(pricingRedirect)
          return
        }
        if (!response.ok) {
          restoreNudge()
          if (response.status === 403) {
            window.location.assign("/reactivate?reason=expired&next=%2Ftracker")
          }
        }
      } catch {
        restoreNudge()
      }
    },
    [data?.nudges],
  )

  if (state === "loading") {
    return (
      <main className="mx-auto max-w-xl space-y-6 px-4 py-7" aria-busy="true">
        <div className="h-16 animate-pulse rounded-[14px] bg-[var(--brand-plum-ice)] motion-reduce:animate-none" />
        <div className="h-20 animate-pulse rounded-[14px] bg-[var(--brand-plum-ice)] motion-reduce:animate-none" />
        <div className="h-40 animate-pulse rounded-[20px] bg-[var(--brand-plum-ice)] motion-reduce:animate-none" />
      </main>
    )
  }

  if (state === "error" || !data) {
    return (
      <main className="mx-auto max-w-xl px-4 py-8">
        <p className="text-[var(--text-heading)]">Tagebuch konnte nicht geladen werden.</p>
        <button
          type="button"
          className="mt-2 font-medium text-[var(--brand-plum-dark)] underline underline-offset-2"
          onClick={() => void refresh()}
        >
          Erneut versuchen
        </button>
      </main>
    )
  }

  const weekDays: WeekStripDay[] = Array.from({ length: 8 }, (_, index) => {
    const date = shiftDate(data.today, index - 7)
    const day = deletedDates.has(date)
      ? null
      : (draftsByDate[date] ?? data.days.find((candidate) => candidate.loggedOn === date) ?? null)
    return {
      date,
      dayType: day?.dayType ?? null,
      customActivityName: day?.customActivityName ?? null,
      isToday: date === data.today,
      isFuture: date > data.today,
      isEditable: date >= shiftDate(data.today, -7),
    }
  })
  const headerDate = selectedDate ?? data.today
  const saveState = autosave.getState(headerDate)
  const rhythmDays: TrackerLogDay[] = data.rhythmHistory.map((day) => ({ ...day, products: [] }))
  const rhythmSummary = buildRhythmSummary(rhythmDays, data.rhythm.frequencyTarget, data.today)
  const customNameError =
    selectedDay?.dayType === "custom" && !isValidCustomActivityName(selectedDay.customActivityName)
  const selectedPresentation = selectedDay
    ? TRACKER_ACTIVITY_PRESENTATION_DE[selectedDay.dayType]
    : null

  return (
    <main className="mx-auto min-h-[calc(100vh-3.5rem)] max-w-xl px-4 pb-24 pt-7">
      <header>
        <h1 className="font-header text-[30px] leading-tight text-[var(--text-heading)]">
          Tagebuch
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{dateLabel(headerDate, data.today)}</p>
      </header>

      <section className="mt-7 border-b border-border pb-7" aria-labelledby="tracker-days-heading">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2
            id="tracker-days-heading"
            className="text-base font-medium text-[var(--text-heading)]"
          >
            Letzte 8 Tage
          </h2>
          <span className="text-xs text-muted-foreground">Tippe zum Nachtragen</span>
        </div>
        <WeekStrip days={weekDays} selectedDate={headerDate} onSelect={handleSelectDate} />
      </section>

      <section
        key={headerDate}
        className="tracker-day-content mt-7"
        aria-labelledby="tracker-entry-heading"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2
              id="tracker-entry-heading"
              className="text-lg font-medium text-[var(--text-heading)]"
            >
              {headerDate === data.today
                ? "Heute"
                : format(new Date(`${headerDate}T00:00:00`), "EEEE", { locale: de })}
            </h2>
          </div>
          {selectedDay ? (
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              disabled={!autosave.ready}
              className="flex h-10 items-center gap-2 rounded-xl border border-[var(--brand-plum-light)] px-3 text-sm font-medium text-[var(--brand-plum-dark)] hover:bg-[var(--brand-plum-ice)] disabled:opacity-50"
            >
              <PencilLine className="h-4 w-4" aria-hidden="true" />
              Bearbeiten
            </button>
          ) : null}
        </div>

        {selectedDay && selectedPresentation ? (
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            disabled={!autosave.ready}
            className="mt-3 flex min-h-20 w-full items-center justify-between gap-4 rounded-[14px] border border-[var(--brand-plum-light)] bg-background px-4 py-3 text-left transition-[border-color,background-color,transform] hover:bg-[var(--brand-plum-ice)] active:scale-[0.99] disabled:opacity-50"
          >
            <span className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--brand-plum-ice)] text-[var(--brand-plum)]">
                <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block font-medium">
                  {selectedDay.dayType === "custom"
                    ? selectedDay.customActivityName
                    : selectedPresentation.label}
                </span>
                <span className="mt-0.5 block text-sm text-muted-foreground">
                  {selectedDay.products.length === 0
                    ? selectedPresentation.description
                    : `${selectedDay.products.length} ${selectedDay.products.length === 1 ? "Produkt" : "Produkte"}`}
                </span>
              </span>
            </span>
            <ChevronRight className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            disabled={!autosave.ready}
            className="mt-3 flex min-h-20 w-full items-center justify-between gap-4 rounded-xl border border-[var(--brand-coral-dark)] bg-[var(--brand-coral)] px-4 py-3 text-left text-white shadow-[0_8px_24px_rgba(var(--brand-coral-rgb),0.20)] transition-[background-color,transform,box-shadow] hover:bg-[var(--brand-coral-dark)] hover:shadow-[0_10px_28px_rgba(var(--brand-coral-rgb),0.26)] active:scale-[0.99] disabled:opacity-50"
          >
            <span className="flex min-w-0 items-center gap-3">
              <CalendarPlus className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span>
                <span className="block font-medium">Routine eintragen</span>
                <span className="mt-0.5 block text-sm text-white/80">
                  Aktivität und verwendete Produkte auswählen
                </span>
              </span>
            </span>
            <ChevronRight className="h-5 w-5 text-white/80" aria-hidden="true" />
          </button>
        )}

        {saveState.status === "error" ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            Konnte nicht gespeichert werden.
            <button
              type="button"
              className="ml-2 font-medium underline"
              onClick={() => autosave.retry(headerDate)}
            >
              Erneut versuchen
            </button>
          </p>
        ) : null}
      </section>

      <div className="mt-8">
        <RhythmBand summary={rhythmSummary} />
      </div>

      {data.gate.unlocked && data.nudges.length > 0 ? (
        <section className="mt-6 space-y-3" aria-labelledby="tracker-insights-heading">
          <h2
            id="tracker-insights-heading"
            className="text-base font-medium text-[var(--text-heading)]"
          >
            Hinweise für dich
          </h2>
          {data.nudges.map((nudge) => (
            <NudgeCard
              key={`${nudge.category}:${nudge.direction}`}
              message={nudge.message}
              onDismiss={() => void dismissNudge(nudge.category, nudge.direction)}
            />
          ))}
        </section>
      ) : null}

      <LogDayCard
        open={sheetOpen}
        dateLabel={dateLabel(headerDate, data.today)}
        day={selectedDay}
        shelf={data.shelf}
        prefillVisible={prefillDates.has(headerDate)}
        customNameError={customNameError}
        canDelete={confirmedDay !== null}
        saveState={saveState}
        onOpenChange={handleSheetOpenChange}
        onSelectDayType={handleSelectDayType}
        onCustomNameChange={handleCustomNameChange}
        onToggleProduct={handleToggleProduct}
        onRetry={() => autosave.retry(headerDate)}
        onDone={() => void handleDone()}
        onDelete={handleDelete}
      />

      {undo ? (
        <div
          className="fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-md items-center justify-between gap-4 rounded-xl bg-[var(--brand-plum-darkest)] px-4 py-3 text-sm text-white shadow-lg"
          role="status"
        >
          <span>Eintrag gelöscht</span>
          <button
            type="button"
            className="flex items-center gap-1.5 font-medium"
            onClick={handleUndo}
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Rückgängig
          </button>
        </div>
      ) : null}
    </main>
  )
}
